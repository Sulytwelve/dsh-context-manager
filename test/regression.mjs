/**
 * Regression tests for the three correctness fixes:
 *
 * 1. scope isolation (write-time merge, recall, index rebuild, legacy records);
 * 2. probe scheduling (zero TTL, least-recently-checked sweep, front-line budget);
 * 3. distillation support (cited tool results decide `active` vs `proposed`,
 *    and a claim version is replaced as one unit).
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { summarizeDistillLedger } from '../lib/budget.js'
import { evaluateCheckpointGuard } from '../lib/checkpoint-guard.js'
import { checkContract } from '../lib/contract.js'
import { normalizeCwdOn, runProbe } from '../lib/util.js'
import { ownerFor } from '../lib/store.js'
import { probeDue, selectProbeCandidates } from '../lib/probe-plan.js'
import { evaluateSupport, toolClass } from '../lib/support.js'
import { recallEnabled, reviewLines } from '../index.js'
import { createChecker, makeStore, reopen } from './harness.mjs'

const check = createChecker()
const root = mkdtempSync(join(tmpdir(), 'memory-regression-'))
const projectA = join(root, 'project-a')
const projectB = join(root, 'project-b')
mkdirSync(projectA, { recursive: true })
mkdirSync(projectB, { recursive: true })
writeFileSync(join(projectA, 'check.mjs'), 'export const command = "--suite=all --workers=2"\n')
writeFileSync(join(projectB, 'check.mjs'), 'export const command = "--suite=all --workers=4"\n')

// ---------------------------------------------------------- 1. scope isolation

{
  const { store, domain } = makeStore()
  const trigger = 'running the full test suite in this repository'

  const first = await store.write({
    scope: 'project',
    kind: 'procedure',
    trigger,
    claim: 'Run node scripts/test.mjs --suite=all --workers=2 for the full suite.',
    evidence: 'project A docs',
    confidence: 0.9,
    cwd: projectA,
    origin: 'test',
  })
  const second = await store.write({
    scope: 'project',
    kind: 'procedure',
    trigger,
    claim: 'Run node scripts/test.mjs --suite=all --workers=4 for the full suite.',
    evidence: 'project B docs',
    confidence: 0.9,
    cwd: projectB,
    origin: 'test',
  })

  check('identical trigger in two projects creates two records', () => {
    assert.notEqual(first.record.id, second.record.id)
    assert.equal(store.list({ status: 'active' }).length, 2)
    assert.match(first.record.claim, /--workers=2/)
    assert.match(second.record.claim, /--workers=4/)
  })

  check('each project recalls only its own command', () => {
    const a = store.recall({ query: 'full test suite command', cwd: projectA })
    const b = store.recall({ query: 'full test suite command', cwd: projectB })
    assert.equal(a.items.length, 1)
    assert.equal(b.items.length, 1)
    assert.match(a.items[0].record.claim, /--workers=2/)
    assert.match(b.items[0].record.claim, /--workers=4/)
  })

  // A restart rebuilds the index from the records: the isolation must survive it.
  const reopened = reopen(domain)
  check('project isolation survives an index rebuild', () => {
    const a = reopened.recall({ query: 'full test suite command', cwd: projectA })
    const b = reopened.recall({ query: 'full test suite command', cwd: projectB })
    assert.equal(a.items.length, 1)
    assert.equal(b.items.length, 1)
    assert.match(a.items[0].record.claim, /--workers=2/)
    assert.match(b.items[0].record.claim, /--workers=4/)
  })

  const third = await store.write({
    scope: 'project',
    kind: 'procedure',
    trigger,
    claim: 'Run node scripts/test.mjs --suite=all --workers=2 for the full suite.',
    evidence: 'project A docs, restated',
    confidence: 0.9,
    cwd: projectA,
    origin: 'test',
  })
  check('a restatement still merges inside its own project only', () => {
    assert.equal(third.record.id, first.record.id)
    assert.equal(store.list({ status: 'active' }).length, 2)
    const b = store.recall({ query: 'full test suite command', cwd: projectB })
    assert.match(b.items[0].record.claim, /--workers=4/)
  })

  // Legacy rows written before `owner` existed derive their owner from cwd.
  const legacy = store.list({ status: 'active' }).find(record => record.cwd === projectB)
  const { owner, ...withoutOwner } = legacy
  await store.domain.table('memories').put(legacy.id, withoutOwner)
  check('a record without an owner field still scopes to its directory', () => {
    const rebuilt = reopen(store.domain)
    assert.equal(rebuilt.recall({ query: 'full test suite command', cwd: projectA }).items.length, 1)
    assert.equal(rebuilt.recall({ query: 'full test suite command', cwd: projectB }).items.length, 1)
  })
}

// --------------------------------------------------------- session isolation

{
  const { store } = makeStore()
  const trigger = 'the current refactoring task in this session'

  await store.write({
    scope: 'session',
    kind: 'decision',
    trigger,
    claim: 'Keep the old public API until release 2.0; the migration is user-visible.',
    evidence: 'user instruction',
    confidence: 0.9,
    sessionId: 'session-1',
    origin: 'test',
  })
  await store.write({
    scope: 'session',
    kind: 'decision',
    trigger,
    claim: 'Rename the public API now; the maintainer approved the break.',
    evidence: 'user instruction',
    confidence: 0.9,
    sessionId: 'session-2',
    origin: 'test',
  })

  check('session records do not merge across sessions', () => {
    assert.equal(store.list({ status: 'active' }).length, 2)
  })

  check('a session recalls only its own decision', () => {
    const one = store.recall({ query: 'public API rename or keep', cwd: projectA, sessionId: 'session-1' })
    const two = store.recall({ query: 'public API rename or keep', cwd: projectA, sessionId: 'session-2' })
    const none = store.recall({ query: 'public API rename or keep', cwd: projectA, sessionId: 'session-3' })
    assert.equal(one.items.length, 1)
    assert.equal(two.items.length, 1)
    assert.match(one.items[0].record.claim, /Keep the old public API/)
    assert.match(two.items[0].record.claim, /Rename the public API/)
    assert.equal(none.items.length, 0)
  })

  check('session records never surface without a session id', () => {
    const anonymous = store.recall({ query: 'public API rename or keep', cwd: projectA })
    assert.equal(anonymous.items.length, 0)
  })
}

// -------------------------------------------------------------- probe timing

{
  const { store } = makeStore()
  const dir = join(root, 'probe-timing')
  mkdirSync(dir, { recursive: true })
  const target = join(dir, 'target.txt')
  writeFileSync(target, 'present\n')

  await store.write({
    scope: 'project',
    kind: 'fact',
    trigger: 'the probe target file contents',
    claim: 'The target file contains the marker line used by the build.',
    evidence: 'target.txt',
    confidence: 0.9,
    cwd: dir,
    origin: 'test',
    probe: { kind: 'file-contains', target: 'target.txt', pattern: 'present' },
  })
  rmSync(target)

  check('zero TTL checks a record written in the same millisecond', () => {
    const result = store.recall({ query: 'probe target file contents', cwd: dir, probeTtlMs: 0 })
    assert.equal(result.probeLines.length, 1, 'the probe should have run')
    assert.equal(result.items.length, 0, 'the failed record must not be served')
    assert.equal(store.list({ status: 'stale' }).length, 1)
  })

  check('lastCheckedAt advances after a check and gates the next one', () => {
    const [record] = store.list({ status: 'stale' })
    assert.ok(typeof record.lastCheckedAt === 'number')
    assert.equal(probeDue(record, record.lastCheckedAt + 1, 86_400_000), false)
    assert.equal(probeDue(record, record.lastCheckedAt + 86_400_000, 86_400_000), true)
  })
}

// ------------------------------------------------------------ probe fairness

{
  const now = 1_800_000_000_000
  const records = []
  for (let index = 0; index < 41; index += 1) {
    records.push({
      id: `mem_${index}`,
      status: 'active',
      probe: { kind: 'path-exists', target: `file-${index}.txt` },
      // Forty records came due two hours ago; the forty-first never ran a probe
      // and is the one that has started to fail.
      lastCheckedAt: index === 40 ? undefined : now - 7_200_000,
      updatedAt: now - 7_200_000,
    })
  }

  check('the sweep reaches a never-checked record behind forty due ones', () => {
    const selected = selectProbeCandidates(records, { now, recheckMs: 3_600_000, max: 40 })
    assert.equal(selected.length, 40)
    assert.ok(selected.some(record => record.id === 'mem_40'), 'the forty-first record must be in the batch')
    assert.equal(selected[0].id, 'mem_40', 'never-checked records sort first')
  })

  check('a recently checked record is not re-selected', () => {
    const fresh = [{ id: 'x', status: 'active', probe: { kind: 'path-exists', target: 'x' }, lastCheckedAt: now - 1, updatedAt: now }]
    assert.equal(selectProbeCandidates(fresh, { now, recheckMs: 3_600_000, max: 40 }).length, 0)
  })
}

// ------------------------------------------------- front-line probe budget

{
  const dir = join(root, 'budget')
  mkdirSync(dir, { recursive: true })
  for (let index = 0; index < 6; index += 1) writeFileSync(join(dir, `keep-${index}.txt`), 'ok\n')
  writeFileSync(join(dir, 'failing.txt'), 'ok\n')

  const { store } = makeStore()
  for (let index = 0; index < 6; index += 1) {
    const target = index === 5 ? 'failing.txt' : `keep-${index}.txt`
    await store.write({
      scope: 'project',
      kind: 'fact',
      trigger: `budget probe target ${index}`,
      claim: `Budget probe record number ${index} holds a verified statement about the fixture.`,
      evidence: target,
      confidence: 0.9,
      cwd: dir,
      origin: 'test',
      probe: { kind: 'file-contains', target, pattern: 'ok' },
    })
  }
  rmSync(join(dir, 'failing.txt'))

  const all = store.recall({ query: 'budget probe target record fixture', cwd: dir, probeTtlMs: 0, budgetTokens: 4000, limit: 10, probeBudget: 5 })
  check('a candidate still due when the probe budget runs out is skipped, not served', () => {
    assert.equal(all.probeLines.length, 5)
    assert.equal(all.probeSkipped, 1)
    assert.equal(all.items.length, 5, 'the unprobed sixth record must not appear in the packet')
    assert.ok(!all.items.some(item => /record number 5/.test(item.record.claim)))
  })

  const enough = store.recall({ query: 'budget probe target record fixture', cwd: dir, probeTtlMs: 0, budgetTokens: 4000, limit: 10, probeBudget: 6 })
  check('with enough budget the failing sixth record is probed and excluded', () => {
    assert.equal(enough.probeSkipped, 0)
    assert.equal(enough.probeFails, 1)
    assert.ok(!enough.items.some(item => /record number 5/.test(item.record.claim)))
    assert.equal(store.list({ status: 'stale' }).length, 1)
  })
}

// --------------------------------------------------------- distillation support

{
  const sample = {
    sessionId: 'session-x',
    turn: 3,
    tools: [
      { ref: 't1', callId: 'call-1', name: 'read', args: '{"path":"docs/06-testing.md"}' },
      { ref: 't2', callId: 'call-2', name: 'pwsh', args: '{"command":"node test.mjs"}' },
      { ref: 't3', callId: 'call-3', name: 'write', args: '{"path":"src/offset.js"}' },
      { ref: 't4', callId: 'call-4', name: 'pwsh', args: '{"command":"node broken.mjs"}' },
    ],
    results: new Map([
      ['call-1', { ok: true }],
      ['call-2', { ok: true }],
      ['call-3', { ok: true }],
      ['call-4', { ok: false, code: 'EXIT_1' }],
    ]),
  }

  check('no evidence refs means no promotion', () => {
    const verdict = evaluateSupport({ claim: 'The docs say the command is X.' }, sample)
    assert.equal(verdict.sufficient, false)
    assert.equal(verdict.reason, 'no-evidence-ref')
  })

  check('an unknown ref is not evidence', () => {
    const verdict = evaluateSupport({ claim: 'The docs say the command is X.', evidence_refs: ['t9'] }, sample)
    assert.equal(verdict.sufficient, false)
    assert.match(verdict.reason, /unknown-ref/)
  })

  check('a failed tool cannot support a claim', () => {
    const verdict = evaluateSupport({ claim: 'The broken script works.', evidence_refs: ['t4'] }, sample)
    assert.equal(verdict.sufficient, false)
    assert.equal(verdict.reason, 'cited-tools-failed')
  })

  check('a read supports a documentary claim', () => {
    const verdict = evaluateSupport({ claim: 'The testing doc names the full-suite command.', evidence_refs: ['t1'] }, sample)
    assert.equal(verdict.sufficient, true)
    assert.equal(verdict.class, 'documented')
  })

  check('a command supports a behavioural claim', () => {
    const verdict = evaluateSupport({ claim: 'Running node test.mjs passes the suite.', evidence_refs: ['t2'] }, sample)
    assert.equal(verdict.sufficient, true)
    assert.equal(verdict.class, 'verified')
  })

  check('a read does not support a behavioural claim', () => {
    const verdict = evaluateSupport({ claim: 'Running node test.mjs passes the suite.', evidence_refs: ['t1'] }, sample)
    assert.equal(verdict.sufficient, false)
    assert.equal(verdict.reason, 'behavioural-claim-cited-no-command')
  })

  check('an edit alone supports nothing', () => {
    const verdict = evaluateSupport({ claim: 'The implementation now stops at the first gap.', evidence_refs: ['t3'] }, sample)
    assert.equal(verdict.sufficient, false)
    assert.equal(verdict.reason, 'cited-tools-support-nothing')
  })

  check('word substrings do not turn a documentary claim behavioural', () => {
    // "workspace" contains "works" and "bypasses" contains "passes"; neither is
    // an execution outcome, so a successful read still supports the claim.
    const workspaceClaim = evaluateSupport(
      { claim: 'A domain name must match the lowercase rule in this workspace.', evidence_refs: ['t1'] },
      sample,
    )
    assert.equal(workspaceClaim.sufficient, true)
    assert.equal(workspaceClaim.class, 'documented')

    const bypassClaim = evaluateSupport(
      { claim: 'The single-worker fixture bypasses the checkpoint coordinator.', evidence_refs: ['t1'] },
      sample,
    )
    assert.equal(bypassClaim.sufficient, true)
  })

  check('tool classification covers the shell and observation families', () => {
    assert.equal(toolClass('pwsh'), 'verification')
    assert.equal(toolClass('terminal_session'), 'verification')
    assert.equal(toolClass('grep'), 'observation')
    assert.equal(toolClass('edit'), 'other')
  })
}

// ------------------------------------------------------- claim version integrity

{
  const { store } = makeStore()
  const written = await store.write({
    scope: 'project',
    kind: 'procedure',
    trigger: 'the release checklist for this package',
    claim: 'Publish with npm publish --access public after the tag is pushed.',
    evidence: 'RELEASE.md step 4',
    confidence: 0.9,
    cwd: projectA,
    origin: 'model',
    probe: { kind: 'file-contains', target: 'check.mjs', pattern: '--suite=all' },
  })

  const weaker = await store.write({
    scope: 'project',
    kind: 'procedure',
    trigger: 'the release checklist for this package',
    claim: 'Publish with npm publish --access public after the tag is pushed.',
    evidence: 'a guess from chat',
    confidence: 0.4,
    cwd: projectA,
    origin: 'distill:short',
    probe: { kind: 'path-exists', target: 'README.md' },
  })

  check('a low-confidence restatement cannot swap the evidence or the probe', () => {
    assert.equal(weaker.record.id, written.record.id)
    assert.equal(weaker.record.evidence, 'RELEASE.md step 4')
    assert.deepEqual(weaker.record.probe, { kind: 'file-contains', target: 'check.mjs', pattern: '--suite=all' })
  })

  const stronger = await store.write({
    scope: 'project',
    kind: 'procedure',
    trigger: 'the release checklist for this package',
    claim: 'Publish with npm publish --access public --provenance after the tag is pushed.',
    evidence: 'RELEASE.md step 5',
    confidence: 0.95,
    cwd: projectA,
    origin: 'model',
  })
  check('a higher-confidence version replaces claim, evidence, and probe together', () => {
    assert.match(stronger.record.claim, /--provenance/)
    assert.equal(stronger.record.evidence, 'RELEASE.md step 5')
    assert.equal(stronger.record.probe, undefined, 'the replaced version drops the old probe with its claim')
  })
}

// ------------------------------------------------------- packet evidence marker

{
  const { store } = makeStore()
  const dir = join(root, 'marker')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'marker.txt'), 'ok\n')

  const first = await store.write({
    scope: 'project',
    kind: 'procedure',
    trigger: 'checking the marker file before a release',
    claim: 'The marker file must contain the literal ok before the release check runs.',
    evidence: 'marker.txt',
    confidence: 0.9,
    cwd: dir,
    origin: 'test',
    probe: { kind: 'file-contains', target: 'marker.txt', pattern: 'ok' },
  })
  await store.markProbe(first.record.id, 'pass', 'contains ok')
  await store.write({
    scope: 'project',
    kind: 'procedure',
    trigger: 'verifying the release command in this repository',
    claim: 'The release command was run against the fixture and exited zero.',
    evidence: 't2(pwsh)',
    support: { class: 'verified', refs: [{ ref: 't2', tool: 'pwsh' }] },
    confidence: 0.6,
    cwd: dir,
    origin: 'distill:short',
  })

  const checked = store.recall({ query: 'checking the marker file before a release', cwd: dir })
  check('a checked record reports when its evidence was verified', () => {
    assert.equal(checked.items.length, 1)
    assert.match(checked.items[0].line, /·checked /)
  })

  const supported = store.recall({ query: 'verifying the release command', cwd: dir })
  check('a distilled record reports the class of evidence behind it', () => {
    assert.equal(supported.items.length, 1)
    assert.match(supported.items[0].line, /verified/)
    assert.match(supported.items[0].line, /0\.60 verified/)
  })
}

// ------------------------------------------------- review groups (status hint)

{
  const { store } = makeStore()
  const trigger = 'deploying this service'

  const first = await store.write({
    scope: 'project',
    kind: 'procedure',
    trigger,
    claim: 'Deploy by pushing a version tag; the release workflow does the rest.',
    evidence: 'RELEASE.md',
    confidence: 0.8,
    cwd: projectA,
    origin: 'test',
  })
  const second = await store.write({
    scope: 'project',
    kind: 'procedure',
    trigger,
    claim: 'The helm chart under infra/ is the only supported deployment path.',
    evidence: 'infra/README.md',
    confidence: 0.7,
    cwd: projectA,
    origin: 'test',
  })

  check('dissimilar claims under one scope+trigger stay separate and are reported', () => {
    assert.notEqual(first.record.id, second.record.id)
    const groups = store.reviewGroups()
    assert.equal(groups.length, 1)
    assert.equal(groups[0].ids.length, 2)
    assert.equal(groups[0].owner, ownerFor('project', projectA))
    assert.deepEqual(new Set(groups[0].ids), new Set([first.record.id, second.record.id]))
  })

  await store.write({
    scope: 'project',
    kind: 'procedure',
    trigger,
    claim: 'Deploy by pushing a version tag; the release workflow does the rest.',
    evidence: 'RELEASE.md',
    confidence: 0.8,
    cwd: projectB,
    origin: 'test',
  })
  check('the same trigger in another project is not the same group', () => {
    const groups = store.reviewGroups()
    assert.equal(groups.length, 1)
    assert.equal(groups[0].owner, ownerFor('project', projectA))
  })

  await store.setStatus(second.record.id, 'superseded')
  check('retired or inactive records leave the review list', () => {
    assert.equal(store.reviewGroups().length, 0)
    assert.equal(reviewLines([]).length, 0)
  })

  check('the hint states the fact without calling it a conflict', () => {
    const text = reviewLines([{ owner: 'project:x', trigger, ids: ['mem_aaa111', 'mem_bbb222'] }]).join('\n')
    assert.match(text, /more than one active record/)
    assert.match(text, /may legitimately apply to different conditions/)
    assert.doesNotMatch(text, /conflict/i)
    assert.match(text, /aaa111/)
    assert.match(text, /bbb222/)
  })
}

// ------------------------------------------- probe outcomes are three-valued

{
  const dir = join(root, 'probe-3')
  mkdirSync(dir, { recursive: true })
  // NEEDLE sits beyond the 256 KiB head window, so a head-only read cannot see it.
  writeFileSync(join(dir, 'big.txt'), `${'a'.repeat(300_000)}NEEDLE${'b'.repeat(200_000)}`)
  // NEEDLE sits at the very end, inside the tail window.
  writeFileSync(join(dir, 'tail.txt'), `${'a'.repeat(300_000)}NEEDLE`)
  writeFileSync(join(dir, 'small.txt'), 'nothing here')

  check('a pattern outside the head window is inconclusive, not a failure', () => {
    const result = runProbe({ kind: 'file-contains', target: 'big.txt', pattern: 'NEEDLE' }, dir)
    assert.equal(result.status, 'inconclusive')
    assert.match(result.detail, /not seen/)
  })

  check('a pattern in the tail window is found', () => {
    const result = runProbe({ kind: 'file-contains', target: 'tail.txt', pattern: 'NEEDLE' }, dir)
    assert.equal(result.status, 'pass')
  })

  check('a small file that lost the pattern still fails', () => {
    assert.equal(runProbe({ kind: 'file-contains', target: 'small.txt', pattern: 'NEEDLE' }, dir).status, 'fail')
    assert.equal(runProbe({ kind: 'path-exists', target: 'missing.txt' }, dir).status, 'fail')
  })

  const { store } = makeStore()
  await store.write({
    scope: 'project',
    kind: 'fact',
    trigger: 'the big fixture file contains the needle marker',
    claim: 'The big fixture file contains the NEEDLE marker used by the importer.',
    evidence: 'big.txt',
    confidence: 0.8,
    cwd: dir,
    origin: 'test',
    probe: { kind: 'file-contains', target: 'big.txt', pattern: 'NEEDLE' },
  })
  const recalled = store.recall({ query: 'big fixture file contains the needle marker', cwd: dir, probeTtlMs: 0 })
  check('an inconclusive probe keeps serving the record and advances its check clock', () => {
    assert.equal(recalled.items.length, 1)
    assert.equal(recalled.probeInconclusive, 1)
    assert.equal(recalled.probeFails, 0)
    assert.equal(store.list({ status: 'stale' }).length, 0)
    assert.equal(typeof store.list({ status: 'active' })[0].lastCheckedAt, 'number')
  })
}

// ------------------------------------------------- confidence can go down now

{
  const { store } = makeStore()
  const trigger = 'the staging database size'
  const written = await store.write({
    scope: 'project',
    kind: 'fact',
    trigger,
    claim: 'The staging database was about 40 GB when this was recorded.',
    evidence: 'snapshot 2026-11-01',
    confidence: 0.9,
    cwd: projectA,
    origin: 'test',
  })

  await store.setConfidence(written.record.id, 0.6, 'snapshot is stale')
  check('set_confidence lowers confidence without touching the claim', () => {
    const current = store.list({ status: 'active' }).find(record => record.id === written.record.id)
    assert.equal(current.confidence, 0.6)
    assert.match(current.claim, /40 GB/)
  })

  const restated = await store.write({
    scope: 'project',
    kind: 'fact',
    trigger,
    claim: 'The staging database was about 40 GB when this was recorded.',
    confidence: 0.3,
    cwd: projectA,
    origin: 'test',
  })
  check('a plain restatement still cannot lower confidence', () => {
    assert.equal(restated.record.confidence, 0.6)
  })

  const demoted = await store.write({
    scope: 'project',
    kind: 'fact',
    trigger,
    claim: 'The staging database was about 40 GB when this was recorded.',
    confidence: 0.3,
    demote: true,
    cwd: projectA,
    origin: 'test',
  })
  check('an explicit demote write lowers it', () => {
    assert.equal(demoted.record.confidence, 0.3)
  })
}

// ------------------------------------------------ user probes and cwd casing

{
  const { store } = makeStore()
  let failure
  try {
    await store.write({
      scope: 'user',
      kind: 'preference',
      trigger: 'handling his personal photos',
      claim: 'Never touch his personal photos without asking first.',
      probe: { kind: 'path-exists', target: 'photos' },
      origin: 'test',
    })
  } catch (error) {
    failure = error
  }
  check('a user-scope probe must use an absolute path', () => {
    assert.match(String(failure?.message ?? ''), /absolute/)
  })

  check('path case folding follows the platform', () => {
    assert.equal(normalizeCwdOn('linux', '/srv/Data/App'), '/srv/Data/App')
    assert.equal(normalizeCwdOn('linux', '/srv/Data/App/'), '/srv/Data/App')
    assert.equal(normalizeCwdOn('win32', 'C:\\Data\\App'), 'c:\\data\\app')
    assert.equal(normalizeCwdOn('darwin', '/Users/Me/App'), '/users/me/app')
  })
}

// ------------------------------------------- checkpoint precedence and budget

{
  const now = 1_800_000_000_000
  const fresh = { sessionId: 'other', updatedAt: now - 60_000, nextAction: 'continue' }
  const old = { sessionId: 'other', updatedAt: now - 7 * 3_600_000, nextAction: 'continue' }
  check('checkpoint guard: curated wins, another session’s fresh one is skipped', () => {
    assert.equal(evaluateCheckpointGuard(undefined, 'me', now).action, 'write')
    assert.equal(evaluateCheckpointGuard(fresh, 'me', now).action, 'skip')
    assert.equal(evaluateCheckpointGuard(fresh, 'me', now).reason, 'other-session-fresh')
    assert.equal(evaluateCheckpointGuard(fresh, 'other', now).action, 'write')
    assert.equal(evaluateCheckpointGuard(fresh, 'me', now, { curated: true }).action, 'skip')
    assert.equal(evaluateCheckpointGuard(old, 'me', now).action, 'write')
  })

  const day = '2026-11-18'
  const at = Date.parse(`${day}T03:00:00Z`)
  const rows = [
    { sessionId: 'a', updatedAt: at, distillCalls: 2, distillInputTokens: 10, distillOutputTokens: 5 },
    { sessionId: 'a', updatedAt: at + 1000, distillCalls: 1, distillInputTokens: 1, distillOutputTokens: 1 },
    { sessionId: 'b', updatedAt: at, distillCalls: 1, distillInputTokens: 2, distillOutputTokens: 2 },
    { sessionId: 'c', updatedAt: at - 86_400_000, distillCalls: 9 },
  ]
  check('the daily distill budget is reconstructed from ledger rows', () => {
    const sum = summarizeDistillLedger(rows, day)
    assert.equal(sum.calls, 4)
    assert.equal(sum.bySession.get('a'), 3)
    assert.equal(sum.bySession.get('b'), 1)
    assert.equal(sum.bySession.has('c'), false)
    assert.equal(sum.inputTokens, 13)
    assert.equal(sum.outputTokens, 8)
  })
}

// ------------------------------------------------------- host contract check

{
  const messages = []
  const ctx = { logger: { error: message => messages.push(message), warn: message => messages.push(message) } }
  check('a missing host surface degrades the row instead of throwing', () => {
    assert.equal(checkContract(ctx, 'memory-core', { 'ctx.on': true }), true)
    assert.equal(checkContract(ctx, 'memory-core', { 'ctx.on': true, 'ctx.tools.register': false }), false)
    assert.match(messages[0], /DSH version incompatible, memory-core degraded \(missing: ctx\.tools\.register\)/)
  })
}

// ---------------------------------------------------------- read-only export

{
  const { store } = makeStore()
  const first = await store.write({
    scope: 'project',
    kind: 'procedure',
    trigger: 'exporting the fixture project',
    claim: 'Run node scripts/export.mjs to produce the fixture bundle.',
    evidence: 'scripts/export.mjs',
    confidence: 0.9,
    tags: ['export', 'fixtures'],
    cwd: projectA,
    origin: 'test',
  })
  await store.write({
    scope: 'project',
    kind: 'fact',
    trigger: 'exporting the fixture project',
    claim: 'The fixture bundle is written under build/fixtures only.',
    evidence: 'build/README.md',
    confidence: 0.6,
    status: 'proposed',
    cwd: projectA,
    origin: 'test',
  })
  await store.write({
    scope: 'user',
    kind: 'preference',
    trigger: 'reading long diffs',
    claim: 'Long diffs should be read with the whitespace-ignoring flag first.',
    evidence: 'user note',
    confidence: 0.8,
    origin: 'test',
  })

  check('export reports the total and pages without gaps or overlaps', () => {
    const all = store.exportRecords({})
    assert.equal(all.total, 3)
    assert.equal(all.rows.length, 3)
    const paged = [
      ...store.exportRecords({ limit: 2 }).rows,
      ...store.exportRecords({ limit: 2, offset: 2 }).rows,
    ].map(record => record.id)
    assert.equal(new Set(paged).size, 3)
    assert.deepEqual(paged, all.rows.map(record => record.id))
  })

  check('export is stable across calls and filters by owner, scope and status', () => {
    const firstIds = store.exportRecords({}).rows.map(record => record.id)
    const secondIds = store.exportRecords({}).rows.map(record => record.id)
    assert.deepEqual(firstIds, secondIds)
    assert.equal(store.exportRecords({ scope: 'user' }).total, 1)
    assert.equal(store.exportRecords({ status: 'proposed' }).total, 1)
    assert.equal(store.exportRecords({ owner: ownerFor('project', projectA) }).total, 2)
  })

  check('an export row carries the identity an import needs', () => {
    const row = store.exportRow(first.record)
    assert.equal(row.format, 1)
    assert.equal(row.type, 'memory')
    assert.equal(row.id, first.record.id)
    assert.equal(row.dedupeKey, first.record.key)
    assert.equal(row.owner, ownerFor('project', projectA))
    assert.equal(row.scope, 'project')
    assert.equal(row.kind, 'procedure')
    assert.equal(row.trigger, 'exporting the fixture project')
    assert.equal(row.status, 'active')
    assert.equal(row.confidence, 0.9)
    assert.deepEqual(row.tags, ['export', 'fixtures'])
    assert.equal(Object.values(row).includes(undefined), false)
    assert.deepEqual(JSON.parse(JSON.stringify(row)), row)
    // ledger/event telemetry is not part of an export row
    assert.equal('turns' in row, false)
    assert.equal('steps' in row, false)
  })
}

// ---------------------------------------------------------------- config gate

check('recall.enabled: false really disables the recall listener', () => {
  // Documented, printed in the boot line, and previously ignored: the listener
  // ran anyway, which silently invalidated a control run.
  assert.equal(recallEnabled({ recall: { enabled: false } }), false)
  assert.equal(recallEnabled({ recall: {} }), true)
  assert.equal(recallEnabled({}), true)
  assert.equal(recallEnabled(undefined), true)
})

rmSync(root, { recursive: true, force: true })
check.report('regression')