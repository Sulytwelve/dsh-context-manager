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

import { evaluateDistillBudget, reserveDistillBudget, summarizeDistillLedger } from '../lib/budget.js'
import { dayOf, evaluateEnrichBudget, reserveEnrichBudget, summarizeEnrichLedger } from '../lib/budget.js'
import { evaluateCheckpointGuard } from '../lib/checkpoint-guard.js'
import { checkContract } from '../lib/contract.js'
import { openDomainWithRetry } from '../lib/domain-open.js'
import { buildEnrichPrompt, enrichAfterFailure, parseEnrichResult } from '../lib/enrich.js'
import { stemLatin } from '../lib/lexicon.js'
import { applySessionScopes, bridgeStamp, qqbotScopeOfSessionKey, qqbotSessionScopes, readQqbotSessionScopes } from '../lib/visibility-bridge.js'
import { normalizeCwdOn, estimateTokens, runProbe, safeKey, normalizeCwd } from '../lib/util.js'
import { ownerFor } from '../lib/store.js'
import { probeDue, selectProbeCandidates } from '../lib/probe-plan.js'
import { evaluateSupport, toolClass } from '../lib/support.js'
import { buildPacket, recallEnabled, rejectReportLines, reviewLines } from '../index.js'
import { createChecker, makeStore, reopen, TEST_CONFIG } from './harness.mjs'

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

  await check('each project recalls only its own command', async () => {
    const a = await store.recall({ query: 'full test suite command', cwd: projectA })
    const b = await store.recall({ query: 'full test suite command', cwd: projectB })
    assert.equal(a.items.length, 1)
    assert.equal(b.items.length, 1)
    assert.match(a.items[0].record.claim, /--workers=2/)
    assert.match(b.items[0].record.claim, /--workers=4/)
  })

  // A restart rebuilds the index from the records: the isolation must survive it.
  const reopened = reopen(domain)
  await check('project isolation survives an index rebuild', async () => {
    const a = await reopened.recall({ query: 'full test suite command', cwd: projectA })
    const b = await reopened.recall({ query: 'full test suite command', cwd: projectB })
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
  await check('a restatement still merges inside its own project only', async () => {
    assert.equal(third.record.id, first.record.id)
    assert.equal(store.list({ status: 'active' }).length, 2)
    const b = await store.recall({ query: 'full test suite command', cwd: projectB })
    assert.match(b.items[0].record.claim, /--workers=4/)
  })

  // Legacy rows written before `owner` existed derive their owner from cwd.
  const legacy = store.list({ status: 'active' }).find(record => record.cwd === projectB)
  const { owner, ...withoutOwner } = legacy
  await store.domain.table('memories').put(legacy.id, withoutOwner)
  await check('a record without an owner field still scopes to its directory', async () => {
    const rebuilt = reopen(store.domain)
    assert.equal((await rebuilt.recall({ query: 'full test suite command', cwd: projectA })).items.length, 1)
    assert.equal((await rebuilt.recall({ query: 'full test suite command', cwd: projectB })).items.length, 1)
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

  await check('a session recalls only its own decision', async () => {
    const one = await store.recall({ query: 'public API rename or keep', cwd: projectA, sessionId: 'session-1' })
    const two = await store.recall({ query: 'public API rename or keep', cwd: projectA, sessionId: 'session-2' })
    const none = await store.recall({ query: 'public API rename or keep', cwd: projectA, sessionId: 'session-3' })
    assert.equal(one.items.length, 1)
    assert.equal(two.items.length, 1)
    assert.match(one.items[0].record.claim, /Keep the old public API/)
    assert.match(two.items[0].record.claim, /Rename the public API/)
    assert.equal(none.items.length, 0)
  })

  await check('session records never surface without a session id', async () => {
    const anonymous = await store.recall({ query: 'public API rename or keep', cwd: projectA })
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

  await check('zero TTL checks a record written in the same millisecond', async () => {
    const result = await store.recall({ query: 'probe target file contents', cwd: dir, probeTtlMs: 0 })
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

  const all = await store.recall({ query: 'budget probe target record fixture', cwd: dir, probeTtlMs: 0, budgetTokens: 4000, limit: 10, probeBudget: 5 })
  check('a candidate still due when the probe budget runs out is skipped, not served', () => {
    assert.equal(all.probeLines.length, 5)
    assert.equal(all.probeSkipped, 1)
    assert.equal(all.items.length, 5, 'the unprobed sixth record must not appear in the packet')
    assert.ok(!all.items.some(item => /record number 5/.test(item.record.claim)))
  })

  const enough = await store.recall({ query: 'budget probe target record fixture', cwd: dir, probeTtlMs: 0, budgetTokens: 4000, limit: 10, probeBudget: 6 })
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

  const checked = await store.recall({ query: 'checking the marker file before a release', cwd: dir })
  check('a checked record reports when its evidence was verified', () => {
    assert.equal(checked.items.length, 1)
    assert.match(checked.items[0].line, /·checked /)
  })

  const supported = await store.recall({ query: 'verifying the release command', cwd: dir })
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

  await check('a pattern outside the head window is inconclusive, not a failure', async () => {
    const result = await runProbe({ kind: 'file-contains', target: 'big.txt', pattern: 'NEEDLE' }, dir)
    assert.equal(result.status, 'inconclusive')
    assert.match(result.detail, /not seen/)
  })

  await check('a pattern in the tail window is found', async () => {
    const result = await runProbe({ kind: 'file-contains', target: 'tail.txt', pattern: 'NEEDLE' }, dir)
    assert.equal(result.status, 'pass')
  })

  await check('a small file that lost the pattern still fails', async () => {
    assert.equal((await runProbe({ kind: 'file-contains', target: 'small.txt', pattern: 'NEEDLE' }, dir)).status, 'fail')
    assert.equal((await runProbe({ kind: 'path-exists', target: 'missing.txt' }, dir)).status, 'fail')
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
  const recalled = await store.recall({ query: 'big fixture file contains the needle marker', cwd: dir, probeTtlMs: 0 })
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
    { sessionId: 'a', distillDay: day, distillCallsToday: 2, lastDistillAt: at, distillInputTokens: 10, distillOutputTokens: 5 },
    { sessionId: 'b', distillDay: day, distillCallsToday: 1, lastDistillAt: at - 1000, distillInputTokens: 2, distillOutputTokens: 2 },
    { sessionId: 'c', distillDay: '2026-11-17', distillCallsToday: 9, lastDistillAt: at - 86_400_000, distillInputTokens: 99 },
  ]
  check('the daily distill budget is reconstructed from persisted per-day counters', () => {
    const sum = summarizeDistillLedger(rows, day)
    assert.equal(sum.calls, 3)
    assert.equal(sum.bySession.get('a'), 2)
    assert.equal(sum.bySession.get('b'), 1)
    assert.equal(sum.bySession.has('c'), false)
    assert.equal(sum.inputTokens, 12)
    assert.equal(sum.outputTokens, 7)
    assert.equal(sum.lastAt.get('a'), at)
  })

  check('the cooldown and caps gate one reservation', () => {
    const config = { includeSubagents: true, llm: { minIntervalMs: 120_000, maxCallsPerSession: 2, maxCallsPerDay: 5 } }
    const budgets = { day, calls: 0, bySession: new Map(), lastAt: new Map() }
    assert.equal(evaluateDistillBudget({ budgets, config, sessionId: 's', isSubagent: false, now: at }).allowed, true)
    reserveDistillBudget(budgets, 's', at)
    const cooling = evaluateDistillBudget({ budgets, config, sessionId: 's', isSubagent: false, now: at + 60_000 })
    assert.equal(cooling.allowed, false)
    assert.equal(cooling.reason, 'cooldown')
    assert.equal(evaluateDistillBudget({ budgets, config, sessionId: 's', isSubagent: false, now: at + 120_000 }).allowed, true)
    reserveDistillBudget(budgets, 's', at + 120_000)
    assert.equal(evaluateDistillBudget({ budgets, config, sessionId: 's', isSubagent: false, now: at + 240_000 }).reason, 'session-cap')
    assert.equal(evaluateDistillBudget({ budgets, config, sessionId: 'other', isSubagent: false, now: at + 240_000 }).allowed, true)
    const daily = { day, calls: 5, bySession: new Map(), lastAt: new Map() }
    assert.equal(evaluateDistillBudget({ budgets: daily, config, sessionId: 'x', isSubagent: false, now: at }).reason, 'daily-cap')
    // A new UTC day resets the day's counter.
    assert.equal(evaluateDistillBudget({ budgets: daily, config, sessionId: 'x', isSubagent: false, now: at + 86_400_000 }).allowed, true)
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

// ------------------------------------------------------ private sensitivity

{
  const { store } = makeStore()
  const privateRecord = await store.write({
    scope: 'user',
    kind: 'preference',
    trigger: 'handling his personal photos',
    claim: 'Never touch his personal photos or private messages without asking first.',
    confidence: 0.9,
    sensitivity: 'private',
    origin: 'test',
  })
  await store.write({
    scope: 'user',
    kind: 'preference',
    trigger: 'reviewing a pull request',
    claim: 'Read the failing test before commenting on a pull request.',
    confidence: 0.8,
    sensitivity: 'public',
    origin: 'test',
  })

  const autoPublic = await store.recall({
    query: 'personal photos and private messages',
    gatePrivate: true,
    visibility: 'public',
    probeOnRecall: false,
  })
  check('a private record is withheld from automatic recall in a public session', () => {
    assert.equal(autoPublic.items.length, 0)
    assert.equal(autoPublic.gatedPrivate, 1)
  })

  const explicit = await store.recall({
    query: 'personal photos and private messages',
    gatePrivate: false,
    probeOnRecall: false,
  })
  check('an explicit recall still returns a private record, marked as private', () => {
    assert.equal(explicit.items.length, 1)
    assert.match(explicit.items[0].line, / private /)
  })

  const autoPrivate = await store.recall({
    query: 'personal photos and private messages',
    gatePrivate: true,
    visibility: 'private',
    probeOnRecall: false,
  })
  check('a session declared private does receive it', () => {
    assert.equal(autoPrivate.items.length, 1)
    assert.equal(autoPrivate.gatedPrivate, 0)
  })

  check('session visibility is explicit and defaults to public', () => {
    assert.equal(store.sessionVisibility('s1'), 'public')
    store.setSessionVisibility('s1', 'private')
    assert.equal(store.sessionVisibility('s1'), 'private')
    store.setSessionVisibility('s1', 'public')
    assert.equal(store.sessionVisibility('s1'), 'public')
  })

  check('config can declare a private session before it starts', () => {
    const seeded = makeStore({ ...TEST_CONFIG, recall: { privateSessions: ['seed-session'] } })
    assert.equal(seeded.store.sessionVisibility('seed-session'), 'private')
    assert.equal(seeded.store.sessionVisibility('other'), 'public')
  })

  check('export carries the sensitivity marker', () => {
    assert.equal(store.exportRow(privateRecord.record).sensitivity, 'private')
  })

  check('a public export omits private records and reports how many', () => {
    const result = store.exportRecords({ includePrivate: false })
    assert.equal(result.omitted, 1)
    assert.equal(result.rows.some(record => record.id === privateRecord.record.id), false)
  })
}

// -------------------------------------- legacy default, review, and precedence

{
  const { store } = makeStore()
  await store.write({
    scope: 'user',
    kind: 'preference',
    trigger: 'legacy personal habit',
    claim: 'He prefers a quiet room when working late.',
    origin: 'test',
  })
  const gated = await store.recall({
    query: 'prefers a quiet room when working late',
    gatePrivate: true,
    visibility: 'public',
    probeOnRecall: false,
  })
  check('an unclassified personal preference is treated as private', () => {
    assert.equal(gated.items.length, 0)
    assert.equal(gated.gatedPrivate, 1)
  })

  await store.write({
    scope: 'user',
    kind: 'preference',
    trigger: 'legacy personal habit',
    claim: 'He prefers a quiet room when working late.',
    sensitivity: 'public',
    origin: 'test',
  })
  const reviewed = await store.recall({
    query: 'prefers a quiet room when working late',
    gatePrivate: true,
    visibility: 'public',
    probeOnRecall: false,
  })
  check('an explicit public review makes a legacy preference shareable', () => {
    assert.equal(reviewed.items.length, 1)
  })

  check('a public declaration beats a conflicting private one', () => {
    const { store: scoped } = makeStore()
    scoped.setSessionVisibility('channel-1', 'private')
    assert.equal(scoped.sessionVisibility('channel-1'), 'private')
    scoped.setSessionVisibility('channel-1', 'public')
    assert.equal(scoped.sessionVisibility('channel-1'), 'public')
    scoped.setSessionVisibility('channel-1', 'private')
    assert.equal(scoped.sessionVisibility('channel-1'), 'public')
  })
}

// --------------------------------------------------- private checkpoint keys

{
  const { store, domain } = makeStore()
  const cwd = join(root, 'private-cwd')
  mkdirSync(cwd, { recursive: true })
  await store.checkpoint(cwd, {
    milestone: 'private task state',
    nextAction: 'continue privately',
    sessionId: 'session-a',
    private: true,
  })

  check('a private checkpoint is readable only by the session that wrote it', () => {
    assert.equal(store.getCheckpoint(cwd, 'session-a')?.milestone, 'private task state')
    assert.equal(store.getCheckpoint(cwd, 'session-b'), undefined)
    assert.equal(store.getCheckpoint(cwd), undefined)
  })

  await store.checkpoint(cwd, { milestone: 'shared task state', sessionId: 'session-b' })
  check('a shared checkpoint coexists with another session’s private one', () => {
    assert.equal(store.getCheckpoint(cwd, 'session-b')?.milestone, 'shared task state')
    assert.equal(store.getCheckpoint(cwd, 'session-a')?.milestone, 'private task state')
  })

  const legacyCwd = join(root, 'legacy-cwd')
  mkdirSync(legacyCwd, { recursive: true })
  await domain.table('tasks').put(safeKey(normalizeCwd(legacyCwd)), {
    cwd: legacyCwd,
    milestone: 'legacy state from before classification',
    sessionId: 'old-session',
    updatedAt: Date.now(),
  })
  check('a legacy checkpoint with unknown sensitivity is withheld from other sessions', () => {
    assert.equal(store.getCheckpoint(legacyCwd, 'old-session')?.milestone, 'legacy state from before classification')
    assert.equal(store.getCheckpoint(legacyCwd, 'new-session'), undefined)
    assert.equal(store.hasWithheldCheckpoint(legacyCwd, 'new-session'), true)
    assert.equal(store.hasWithheldCheckpoint(legacyCwd, 'old-session'), false)
  })

  // The durable read boundary is where the 1.6.0 bug bit: `sensitivity` was not
  // declared on the task schema, so a public checkpoint reopened as "unknown"
  // and was withheld from every other session. Reopen against the same tables
  // and re-check all three classifications.
  const reopened = reopen(domain)
  await check('a public checkpoint stays readable to other sessions after a reopen', () => {
    assert.equal(reopened.getCheckpoint(cwd, 'session-c')?.milestone, 'shared task state')
    assert.equal(reopened.hasWithheldCheckpoint(cwd, 'session-c'), false)
  })
  await check('a private checkpoint stays private (and present) after a reopen', () => {
    assert.equal(reopened.getCheckpoint(cwd, 'session-a')?.milestone, 'private task state')
    // Another session sees the shared checkpoint, never the private one.
    assert.equal(reopened.getCheckpoint(cwd, 'session-c')?.milestone, 'shared task state')
    assert.equal(reopened.getCheckpoint(cwd, 'session-a')?.sensitivity, 'private')
  })
  await check('a legacy checkpoint is still withheld after a reopen', () => {
    assert.equal(reopened.getCheckpoint(legacyCwd, 'new-session'), undefined)
    assert.equal(reopened.getCheckpoint(legacyCwd, 'old-session')?.milestone, 'legacy state from before classification')
  })
}

// ---------------------------------------------- QQ bot visibility bridge

{
  const { store } = makeStore()
  const prefs = {
    sessionIds: {
      'qqbot:10001:c2c:peer-a': 'session-aaa',
      'qqbot:10001:group:group-b': 'session-bbb',
      'some-other-plugin:10001:c2c:peer-c': 'session-ccc',
      'qqbot:10001:c2c:': '',
    },
  }

  check('the QQ prefs map turns c2c into private and group into public', () => {
    const scopes = qqbotSessionScopes(prefs)
    assert.equal(scopes.get('session-aaa'), 'private')
    assert.equal(scopes.get('session-bbb'), 'public')
    assert.equal(scopes.has('session-ccc'), false)
    assert.equal(scopes.size, 2)
  })

  await check('a missing or malformed prefs file is a no-op', async () => {
    assert.equal((await readQqbotSessionScopes(join(root, 'no-such-prefs.json'))).size, 0)
    const broken = join(root, 'broken-prefs.json')
    writeFileSync(broken, '{ not json')
    assert.equal((await readQqbotSessionScopes(broken)).size, 0)
  })

  check('applying the map declares only the sessions it knows', () => {
    const applied = applySessionScopes(store, qqbotSessionScopes(prefs))
    assert.equal(applied, 2)
    assert.equal(store.sessionVisibility('session-aaa'), 'private')
    assert.equal(store.sessionVisibility('session-bbb'), 'public')
    assert.equal(store.sessionVisibility('unknown-session'), 'public')
  })

  check('QQ session keys are parsed defensively', () => {
    assert.equal(qqbotScopeOfSessionKey('qqbot:9:c2c:x'), 'private')
    assert.equal(qqbotScopeOfSessionKey('qQbOt:9:GROUP:x'), 'public')
    assert.equal(qqbotScopeOfSessionKey('qqbot:9:channel:x'), undefined)
    assert.equal(qqbotScopeOfSessionKey(undefined), undefined)
    assert.equal(qqbotScopeOfSessionKey(''), undefined)
  })

  await check('the bridge re-reads only when the preference file changes', async () => {
    const path = join(root, 'bridge-stamp.json')
    assert.equal(await bridgeStamp(path), 'missing')
    writeFileSync(path, '{"sessionIds":{}}')
    const first = await bridgeStamp(path)
    assert.notEqual(first, 'missing')
    assert.equal(await bridgeStamp(path), first)
    writeFileSync(path, '{"sessionIds":{"qqbot:1:c2c:x":"session-1"}}')
    assert.notEqual(await bridgeStamp(path), first)
  })
}

// ------------------------------------------------ hot-reload domain opening

{
  const spec = { name: 'agent_memory' }
  const retryable = new Error("already-open: domain 'agent_memory' is already open")
  let attempts = 0
  const facility = {
    async open() {
      attempts += 1
      if (attempts < 3) throw retryable
      return { name: 'agent_memory' }
    },
  }
  const opened = await openDomainWithRetry(facility, spec, { timeoutMs: 500, delayMs: 5 })
  check('a reload that loses the domain race retries until the old handle closes', () => {
    assert.equal(attempts, 3)
    assert.equal(opened.name, 'agent_memory')
  })

  let failures = 0
  const forever = { async open() { failures += 1; throw retryable } }
  let conflict
  try {
    await openDomainWithRetry(forever, spec, { timeoutMs: 30, delayMs: 5 })
  } catch (error) {
    conflict = error
  }
  check('a permanent domain conflict gives up with the original error', () => {
    assert.equal(conflict, retryable)
    assert.ok(failures >= 2)
  })

  let otherAttempts = 0
  const other = { async open() { otherAttempts += 1; throw new Error('backend-not-found: no route') } }
  let nonRetryable
  try {
    await openDomainWithRetry(other, spec, { timeoutMs: 500, delayMs: 5 })
  } catch (error) {
    nonRetryable = error
  }
  check('a non-retryable open failure is reported without retrying', () => {
    assert.match(String(nonRetryable?.message), /backend-not-found/)
    assert.equal(otherAttempts, 1)
  })
}

// ------------------------------------------------ rejection reasons and import

{
  const { store } = makeStore()
  await store.write({
    scope: 'project',
    kind: 'fact',
    trigger: 'alpha release checklist',
    claim: 'Alpha releases need the migration dry run before tagging.',
    cwd: projectA,
    origin: 'test',
  })
  await store.write({
    scope: 'project',
    kind: 'fact',
    trigger: 'unrelated beta note',
    claim: 'Beta fixtures live under build/beta on the build machine.',
    cwd: projectA,
    origin: 'test',
  })
  const privatePreference = await store.write({
    scope: 'user',
    kind: 'preference',
    trigger: 'alpha personal habit',
    claim: 'Prefers alpha builds when testing quietly at night.',
    sensitivity: 'private',
    origin: 'test',
  })

  const result = await store.recall({
    query: 'alpha release checklist',
    cwd: projectA,
    sessionId: 'reject-session',
    gatePrivate: true,
    visibility: 'public',
    probeOnRecall: false,
  })
  check('recall reports why candidates were rejected', () => {
    assert.ok((result.rejectedByReason['no-term-overlap'] ?? 0) >= 1)
    assert.equal(result.rejectedByReason.private, 1)
    assert.ok(result.rejectedTop.length >= 1)
    assert.ok(result.rejectedTop.every(item => typeof item.reason === 'string'))
    assert.ok(result.rejectedTop.some(item => item.reason === 'private'))
    assert.equal(store.rejectsOf('reject-session')?.byReason.private, 1)
  })

  check('report names a private-gated record only as withheld outside a private session', () => {
    const entry = store.rejectsOf('reject-session')
    const publicText = rejectReportLines(entry, 'public').join('\n')
    assert.match(publicText, /private 1/)
    assert.match(publicText, /\[withheld private\]/)
    assert.equal(publicText.includes(privatePreference.record.id.slice(-6)), false)
    const privateText = rejectReportLines(entry, 'private').join('\n')
    assert.equal(privateText.includes(privatePreference.record.id.slice(-6)), true)
  })

  const source = makeStore().store
  await source.write({
    scope: 'project',
    kind: 'procedure',
    trigger: 'importing an exported store',
    claim: 'Import maps rows back by owner and dedupe key, never by claim similarity.',
    evidence: 'docs/DETAIL.md',
    confidence: 0.9,
    cwd: projectA,
    origin: 'test',
  })
  await source.write({
    scope: 'user',
    kind: 'preference',
    trigger: 'reviewed preference',
    claim: 'This reviewable preference is explicitly public.',
    sensitivity: 'public',
    origin: 'test',
  })
  const exported = source.exportRecords({}).rows.map(record => source.exportRow(record))
  const target = makeStore().store
  const imported = await target.importRows(exported)
  check('an export imports into an empty store with ids, keys and timestamps intact', () => {
    assert.equal(imported.inserted, 2)
    assert.deepEqual(target.exportRecords({}).rows.map(record => target.exportRow(record)), exported)
  })
  const again = await target.importRows(exported)
  check('a repeated import is a no-op', () => {
    assert.equal(again.skipped, 2)
    assert.deepEqual(target.exportRecords({}).rows.map(record => target.exportRow(record)), exported)
  })

  const newer = exported.map(row => row.trigger === 'importing an exported store'
    ? { ...row, claim: 'Import maps rows by owner and dedupe key; never rewrite by claim.', updatedAt: row.updatedAt + 60_000, confidence: 0.2, status: 'proposed' }
    : row)
  await target.importRows(newer)
  const afterNewer = target.list({ limit: 10 }).find(record => record.key === exported.find(row => row.trigger === 'importing an exported store').dedupeKey)
  check('a newer imported row wins while confidence and status are never demoted', () => {
    assert.match(afterNewer.claim, /never rewrite by claim/)
    assert.equal(afterNewer.confidence, 0.9)
    assert.equal(afterNewer.status, 'active')
  })

  const older = exported.map(row => row.trigger === 'importing an exported store'
    ? { ...row, claim: 'An older export must not overwrite the newer one.', updatedAt: row.updatedAt - 60_000 }
    : row)
  await target.importRows(older)
  const afterOlder = target.list({ limit: 10 }).find(record => record.key === exported.find(row => row.trigger === 'importing an exported store').dedupeKey)
  check('an older imported row is skipped', () => {
    assert.match(afterOlder.claim, /never rewrite by claim/)
  })

  const rejected = await target.importRows([
    { type: 'memory', format: 2, id: 'x', dedupeKey: 'k', trigger: 'a trigger', claim: 'a claim long enough' },
    { type: 'memory', format: 1, id: 'y' },
    { type: 'export', format: 1 },
  ])
  check('import rejects wrong formats and incomplete rows', () => {
    assert.equal(rejected.rejected, 3)
    assert.equal(rejected.inserted, 0)
  })

  const ladder = makeStore().store
  const retired = await ladder.write({
    scope: 'project',
    kind: 'fact',
    trigger: 'the retired deployment note',
    claim: 'The deployment note was retired after the migration.',
    cwd: projectA,
    origin: 'test',
  })
  await ladder.setStatus(retired.record.id, 'superseded')
  const retiredRow = ladder.exportRecords({}).rows
    .map(record => ladder.exportRow(record))
    .find(row => row.id === retired.record.id)
  await ladder.importRows([{ ...retiredRow, status: 'active', updatedAt: retiredRow.updatedAt + 1_000 }])
  check('a newer active row revives a superseded record', () => {
    assert.equal(ladder.list({ status: 'active' }).some(record => record.id === retired.record.id), true)
  })

  const failed = await ladder.write({
    scope: 'project',
    kind: 'fact',
    trigger: 'the stale probe note',
    claim: 'The stale probe note is checked against a marker file.',
    cwd: projectA,
    origin: 'test',
  })
  await ladder.markProbe(failed.record.id, 'fail', 'marker missing')
  const staleRow = ladder.exportRecords({}).rows
    .map(record => ladder.exportRow(record))
    .find(row => row.id === failed.record.id)
  await ladder.importRows([{ ...staleRow, status: 'proposed', updatedAt: staleRow.updatedAt + 1_000 }])
  check('a newer proposed row reopens a stale record for review, not to active', () => {
    const current = ladder.list({ limit: 20 }).find(record => record.id === failed.record.id)
    assert.equal(current.status, 'proposed')
  })
}

// ------------------------------------------- import trust boundary and ids

{
  const { store, domain } = makeStore()
  const base = {
    type: 'memory',
    format: 1,
    id: 'mem_import_guard',
    dedupeKey: 'project:fact:import guard',
    owner: 'project:C:/fixture',
    scope: 'project',
    kind: 'fact',
    trigger: 'the import guard fixture',
    claim: 'An imported row must carry a plausible timestamp to be accepted.',
    confidence: 0.5,
    status: 'active',
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
  }

  const future = await store.importRows([{ ...base, updatedAt: Date.now() + 2 * 86_400_000 }])
  check('import rejects a row stamped far in the future', () => {
    assert.equal(future.rejected, 1)
    assert.equal(store.list({ limit: 10 }).length, 0)
  })

  const undated = await store.importRows([{ ...base, updatedAt: undefined }])
  check('import rejects a row without a usable timestamp', () => {
    assert.equal(undated.rejected, 1)
    assert.equal(store.list({ limit: 10 }).length, 0)
  })

  const accepted = await store.importRows([base])
  check('a plausibly dated row still imports', () => {
    assert.equal(accepted.inserted, 1)
  })

  check('resolveId accepts an exact id, a short id, and passes an unknown one through', () => {
    assert.equal(store.resolveId(base.id), base.id)
    assert.equal(store.resolveId(base.id.slice(-6)), base.id)
    assert.equal(store.resolveId('nope'), 'nope')
    assert.throws(() => store.resolveId(''), /"id" is required/)
  })

  const stub = id => ({
    id, key: `stub:${id}`, scope: 'project', kind: 'fact', trigger: 'stub trigger',
    claim: 'stub claim long enough', status: 'active', confidence: 0.5,
    createdAt: 1, updatedAt: 1, uses: 0, wins: 0, harms: 0, tags: [], origin: 'test', cwd: 'C:/stub',
  })
  await domain.table('memories').put('mem_aaaaaaaa_abc123', stub('mem_aaaaaaaa_abc123'))
  await domain.table('memories').put('mem_bbbbbbbb_abc123', stub('mem_bbbbbbbb_abc123'))
  check('an ambiguous id suffix is refused instead of guessing', () => {
    assert.throws(() => store.resolveId('abc123'), /ambiguous/)
  })
}

// --------------------------------------------- diagnostics audience filtering

{
  const { store } = makeStore()
  await store.event('write', 'created mine (private) mem_aaaaaa', 'private-session', { private: true })
  await store.event('write', 'created ours mem_bbbbbb', 'public-session', { private: false })
  await store.event('legacy', 'old free text mem_cccccc', 'public-session')
  await store.event('boot', 'memory core ready', undefined, { private: false })

  check('a public session never sees another session’s private diagnostics', () => {
    const visible = store.recentEvents(10, { sessionId: 'public-session', visibility: 'public' })
    const text = visible.map(item => item.detail).join('|')
    assert.equal(text.includes('mem_aaaaaa'), false)
    assert.equal(text.includes('mem_bbbbbb'), true)
    // Legacy free text has no audience; it is hidden outside a private session.
    assert.equal(text.includes('mem_cccccc'), false)
    assert.equal(text.includes('memory core ready'), true)
  })

  check('a private session sees its own private diagnostics', () => {
    const visible = store.recentEvents(10, { sessionId: 'private-session', visibility: 'private' })
    assert.equal(visible.some(item => item.detail.includes('mem_aaaaaa')), true)
  })
}

// ------------------------------------------------ packet budget (CJK and caps)

{
  const { store } = makeStore()
  const dir = join(root, 'packet-budget')
  mkdirSync(dir, { recursive: true })
  const long = '检查点'.repeat(220)
  await store.checkpoint(dir, {
    milestone: long, nextAction: long, openQuestion: long, acceptance: long, sessionId: 'writer',
  })
  await store.write({
    scope: 'project', kind: 'procedure', trigger: 'deploy the packet budget fixture',
    claim: 'Run node deploy.mjs and then verify the marker file before reporting success.',
    evidence: 'deploy.mjs', confidence: 0.9, cwd: dir, origin: 'test',
  })
  const recallConfig = {
    limit: 3, tokenBudget: 220, minRelevance: 2.5, probeOnRecall: false, probeTtlMs: 86_400_000,
    probeBudget: 5, resumeMaxAgeMs: 604_800_000,
  }
  const packet = await buildPacket(store, {
    query: 'resume the last checkpoint and deploy the fixture',
    cwd: dir, excludeIds: new Set(), includeResume: true, sessionId: 'reader', recall: recallConfig,
  })
  check('a Chinese checkpoint cannot push the packet over its token budget', () => {
    assert.ok(packet.text.length > 0)
    assert.ok(estimateTokens(packet.text) <= 220, `packet ${estimateTokens(packet.text)} > 220`)
    assert.ok(packet.tokens <= 220)
  })
  check('only rendered records are reported as used', () => {
    assert.equal(packet.usedIds.length, packet.used)
    for (const id of packet.usedIds) assert.ok(packet.text.includes(id.slice(-6)))
  })
  const tight = await buildPacket(store, {
    query: 'resume the last checkpoint and deploy the fixture',
    cwd: dir, excludeIds: new Set(), includeResume: true, sessionId: 'reader', recall: recallConfig,
    sessionRemainingTokens: 120,
  })
  check('the remaining session allowance caps a packet below the per-packet budget', () => {
    assert.ok(tight.text === '' || estimateTokens(tight.text) <= 120)
  })
}

// ------------------------------------------------------ probe scheduling fixes

{
  const { store } = makeStore()
  const dir = join(root, 'probe-sweep')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'ok.txt'), 'ok')
  for (let index = 0; index < 20; index += 1) {
    await store.write({
      scope: 'project', kind: 'fact', trigger: `filler probe record ${index}`,
      claim: `Filler record ${index} exists only to fill the recent window.`,
      cwd: dir, origin: 'test',
    })
  }
  const old = await store.write({
    scope: 'project', kind: 'fact', trigger: 'old probe target',
    claim: 'The old record points at a marker that should be checked.',
    probe: { kind: 'file-contains', target: 'ok.txt', pattern: 'ok' },
    cwd: dir, origin: 'test',
  })
  const raw = store.get(old.record.id)
  await store.domain.table('memories').put(raw.id, { ...raw, updatedAt: 1, createdAt: 1 })
  const picked = store.probeCandidates({ now: Date.now(), recheckMs: 3_600_000, max: 1 })
  check('the sweep selects an old never-checked record, not only recent ones', () => {
    assert.equal(picked.length, 1)
    assert.equal(picked[0].id, old.record.id)
  })

  const failing = await store.write({
    scope: 'project', kind: 'fact', trigger: 'a marker that is already gone',
    claim: 'This record is checked against a marker that has already been removed.',
    probe: { kind: 'path-exists', target: 'gone.txt' }, cwd: dir, origin: 'test',
  })
  await store.markProbe(failing.record.id, 'fail', 'missing', failing.record.probe)
  const staleBefore = store.get(failing.record.id)
  await new Promise(resolve => setTimeout(resolve, 5))
  await store.markProbe(staleBefore.id, 'fail', 'still missing', staleBefore.probe)
  check('a stale record that fails again advances its check clock without re-stamping freshness', () => {
    const staleAfter = store.get(staleBefore.id)
    assert.equal(staleAfter.status, 'stale')
    assert.ok(staleAfter.lastCheckedAt > staleBefore.lastCheckedAt)
    assert.equal(staleAfter.updatedAt, staleBefore.updatedAt)
  })
  await check('a probe verdict for a replaced probe is ignored', async () => {
    await store.markProbe(staleBefore.id, 'pass', 'old target appeared', { kind: 'path-exists', target: 'other.txt' })
    assert.equal(store.get(staleBefore.id).status, 'stale')
  })

  const sessionRecord = await store.write({
    scope: 'session', kind: 'fact', trigger: 'a session-scoped probe target',
    claim: 'The session record resolves its probe against the captured directory.',
    probe: { kind: 'file-contains', target: 'ok.txt', pattern: 'ok' },
    cwd: dir, sessionId: 'session-probe', origin: 'test',
  })
  check('a session-scope record keeps the directory its probe was written against', () => {
    assert.equal(store.get(sessionRecord.record.id).cwd, dir)
    assert.equal(ownerFor('session', undefined, 'session-probe'), 'session:session-probe')
  })
}

// ------------------------------------ owner boundaries, bridge, import guards

{
  const { store } = makeStore()
  const b = await store.write({
    scope: 'project', kind: 'fact', trigger: 'a record in project b',
    claim: 'Project B has its own fact that project A must not retire.',
    cwd: projectB, origin: 'test',
  })
  let crossOwner
  try {
    await store.write({
      scope: 'project', kind: 'fact', trigger: 'a project a record',
      claim: 'Project A record that tries to retire a project B record.',
      cwd: projectA, supersedes: b.record.id, origin: 'test',
    })
  } catch (error) {
    crossOwner = error
  }
  check('supersedes cannot retire a record from another owner', () => {
    assert.match(String(crossOwner?.message), /same owner/)
  })
}

{
  const { store } = makeStore()
  applySessionScopes(store, new Map([['bridge-a', 'private'], ['bridge-b', 'public']]))
  check('the bridge declares both scopes', () => {
    assert.equal(store.sessionVisibility('bridge-a'), 'private')
    assert.equal(store.sessionVisibility('bridge-b'), 'public')
  })
  applySessionScopes(store, new Map([['bridge-a', 'public']]))
  check('replacing the bridge snapshot withdraws a mapping that disappeared', () => {
    assert.equal(store.sessionVisibility('bridge-a'), 'public')
    assert.equal(store.sessionVisibility('bridge-b'), 'public')
  })
  check('a conflicting c2c and group mapping resolves to public', () => {
    const scopes = qqbotSessionScopes({ sessionIds: { 'qqbot:1:c2c:x': 'same', 'qqbot:1:group:y': 'same' } })
    assert.equal(scopes.get('same'), 'public')
  })
  const seeded = makeStore({ ...TEST_CONFIG, recall: { privateSessions: ['seeded-session'] } })
  applySessionScopes(seeded.store, new Map())
  check('the bridge snapshot never erases a config-declared private session', () => {
    assert.equal(seeded.store.sessionVisibility('seeded-session'), 'private')
  })
}

{
  const { store } = makeStore()
  const base = {
    type: 'memory', format: 1, id: 'mem_import_guard',
    dedupeKey: 'project:fact:import guard', owner: 'project:C:/fixture', scope: 'project', kind: 'fact',
    trigger: 'the import guard fixture', claim: 'An imported row must carry a valid identity and timestamp.',
    confidence: 0.5, status: 'active', createdAt: 1_700_000_000_000, updatedAt: 1_700_000_000_000,
  }
  check('import rejects an id that is not a storage-safe key', async () => {
    const result = await store.importRows([{ ...base, id: 'mem_bad|id' }])
    assert.equal(result.rejected, 1)
  })
  check('import rejects an owner that disagrees with its scope', async () => {
    const result = await store.importRows([{ ...base, id: 'mem_import_owner', scope: 'user', owner: 'project:C:/fixture' }])
    assert.equal(result.rejected, 1)
  })
  await store.importRows([base])
  check('import refuses to reparent an existing id', async () => {
    const result = await store.importRows([{ ...base, owner: 'project:C:/other', updatedAt: base.updatedAt + 10_000 }])
    assert.equal(result.rejected, 1)
  })
  const versioned = {
    ...base, id: 'mem_import_version', dedupeKey: 'project:fact:import version',
    probe: { kind: 'path-exists', target: 'C:/fixture/file.txt' }, lastCheckedAt: base.updatedAt + 500,
  }
  await store.importRows([versioned])
  await store.importRows([{
    ...versioned, claim: 'A newer claim that no longer carries the old probe.',
    probe: undefined, lastCheckedAt: undefined, updatedAt: versioned.updatedAt + 1000,
  }])
  check('a newer import replaces claim and probe as one version', () => {
    const record = store.get('mem_import_version')
    assert.match(record.claim, /newer claim/)
    assert.equal(record.probe, undefined)
    assert.equal(record.lastCheckedAt, undefined)
  })
}

// ------------------------------------------------------ semantic retrieval
//
// The retrieval vocabulary is not built into the package: the agent writes it
// at runtime. These blocks pin the three layers — generic Latin stem folding,
// the learned concept dictionary (`link` / enrichment), and per-record
// aliases — plus the failure-driven call that fills the layers.

{
  const { store } = makeStore()

  check('latin stems fold to a shared base form', () => {
    assert.equal(stemLatin('backups'), 'backup')
    assert.equal(stemLatin('restarting'), 'restart')
    assert.equal(stemLatin('running'), 'run')
    assert.equal(stemLatin('stopped'), 'stop')
    assert.equal(stemLatin('proxies'), 'proxy')
    assert.equal(stemLatin('notes'), 'note')
    assert.equal(stemLatin('classes'), 'class')
    // Words the rules must leave alone.
    assert.equal(stemLatin('status'), 'status')
    assert.equal(stemLatin('alias'), 'alias')
    assert.equal(stemLatin('dns'), 'dns')
  })

  await check('an inflected query matches the base form on the record', async () => {
    await store.write({
      scope: 'project', kind: 'fact',
      trigger: 'vaultwarden backups are encrypted',
      claim: 'The backup job encrypts every archive before upload.',
      confidence: 0.9,
      cwd: projectA, origin: 'test',
    })
    const result = await store.recall({ query: 'how to restore a backup', cwd: projectA })
    assert.ok(result.items.length >= 1)
    assert.match(result.items[0].record.trigger, /vaultwarden/)
  })

  check('link rejects a single form', async () => {
    let failure
    try {
      await store.linkForms({ forms: ['密码库'] })
    } catch (error) {
      failure = error
    }
    assert.match(String(failure?.message), /at least 2/)
  })

  const linked = await store.linkForms({ forms: ['密码库', 'vaultwarden', 'bitwarden'], origin: 'test' })
  check('a learned group bridges wordings in both directions', () => {
    assert.equal(linked.forms.length, 3)
    assert.equal(store.stats().concepts, 1)
  })

  await check('the english record is recalled by its chinese name', async () => {
    const result = await store.recall({ query: '密码库的备份放在哪', cwd: projectA, minRelevance: 1 })
    assert.ok(result.items.length >= 1)
    assert.match(result.items[0].record.trigger, /vaultwarden/)
  })

  await store.write({
    scope: 'project', kind: 'fact',
    trigger: '密码库导出流程的说明',
    claim: 'Use the admin UI export before upgrading the vault.',
    cwd: projectA, origin: 'test',
  })
  await check('the chinese record is recalled by its english name', async () => {
    const result = await store.recall({ query: 'vaultwarden export steps', cwd: projectA, minRelevance: 1 })
    // The english record matches literally and may rank first; the learned
    // group must at least pull the chinese-only record into the results.
    assert.ok(result.items.some(item => /密码库/.test(item.record.trigger)))
  })
}

{
  const { store } = makeStore()
  const written = await store.write({
    scope: 'project', kind: 'fact',
    trigger: '甲乙丙丁专属流程',
    claim: 'A literal trigger with a separately written alias wording.',
    cwd: projectA, origin: 'test',
  })
  await store.updateAliases(written.record.id, ['戊己庚辛的说法'])

  await check('an alias-only query reaches the record', async () => {
    const result = await store.recall({ query: '戊己庚辛', cwd: projectA, minRelevance: 1 })
    assert.ok(result.items.length >= 1)
    assert.equal(result.items[0].record.id, written.record.id)
  })

  await check('a literal trigger match outranks an alias match', async () => {
    const literal = await store.recall({ query: '甲乙丙丁', cwd: projectA, minRelevance: 1, explain: true })
    const aliased = await store.recall({ query: '戊己庚辛', cwd: projectA, minRelevance: 1, explain: true })
    const literalRow = (literal.explain ?? []).find(row => row.id === written.record.id)
    const aliasRow = (aliased.explain ?? []).find(row => row.id === written.record.id)
    assert.ok(literalRow !== undefined && aliasRow !== undefined)
    assert.ok(literalRow.relevance > aliasRow.relevance)
    assert.ok(aliasRow.aliasHits > 0)
  })

  await check('re-writing merges aliases instead of replacing them', async () => {
    await store.updateAliases(written.record.id, ['戊己庚辛的说法', '新的别名说法'])
    const record = store.get(written.record.id)
    assert.deepEqual(record.aliases, ['戊己庚辛的说法', '新的别名说法'])
    assert.ok(record.aliasAt > 0)
  })
}

{
  const { store } = makeStore()

  await store.linkForms({ forms: ['甲乙', '丙丁'], origin: 'test' })
  await store.linkForms({ forms: ['丙丁', '戊己'], origin: 'test' })
  check('overlapping groups merge into one learned group', () => {
    assert.equal(store.stats().concepts, 1)
    assert.deepEqual(store.exportConcepts()[0].forms.sort(), ['丙丁', '戊己', '甲乙'].sort())
  })

  const removed = await store.removeConcepts(['丙丁'])
  check('unlink removes the group holding the form', () => {
    assert.equal(removed, 1)
    assert.equal(store.stats().concepts, 0)
  })
}

{
  const { store, domain } = makeStore()
  await store.write({
    scope: 'project', kind: 'fact',
    trigger: 'the persistent concept fixture',
    claim: 'A learned dictionary must survive a restart.',
    cwd: projectA, origin: 'test',
  })
  await store.linkForms({ forms: ['持久概念甲', 'persistent'], origin: 'test' })
  const reopened = reopen(domain)
  await check('the learned dictionary survives a restart', async () => {
    assert.equal(reopened.stats().concepts, 1)
    const hit = await reopened.recall({ query: '持久概念甲怎么用', cwd: projectA, minRelevance: 1 })
    assert.ok(hit.items.length >= 1)
    assert.match(hit.items[0].record.trigger, /persistent/)
  })
}

{
  const { store } = makeStore()
  const missed = await store.recall({ query: '完全无关的查询语句', cwd: projectA, sessionId: 's-reject' })
  assert.equal(missed.items.length, 0)
  check('the rejection summary remembers the failed query and the hit count', () => {
    const rejects = store.rejectsOf('s-reject')
    assert.equal(rejects.query, '完全无关的查询语句')
    assert.equal(rejects.hits, 0)
    assert.ok((rejects.top ?? []).length >= 0)
  })
}

// ------------------------------------------------------------ enrichment ----

{
  const { store } = makeStore()
  const written = await store.write({
    scope: 'project', kind: 'fact',
    trigger: 'vaultwarden exports its data weekly',
    claim: 'The export job runs on Sunday night and encrypts everything.',
    cwd: projectA, origin: 'test',
  })

  check('the enrichment prompt carries the failed question and the record', () => {
    const prompt = buildEnrichPrompt('密码库怎么导出', [written.record])
    assert.match(prompt, /密码库怎么导出/)
    assert.match(prompt, new RegExp(written.record.id))
    assert.match(prompt, /exports its data weekly/)
  })

  check('the enrichment answer parses leniently', () => {
    const parsed = parseEnrichResult(
      'noise {"records":[{"id":" a ","aliases":["好别名","xy",42,""]},{"id":"","aliases":["yz"]}],"links":[["甲乙","丙丁"],["只有一个"],[]]} tail',
    )
    assert.deepEqual(parsed.records, [{ id: 'a', aliases: ['好别名', 'xy'] }])
    assert.deepEqual(parsed.links, [['甲乙', '丙丁']])
    assert.deepEqual(parseEnrichResult('not json'), { records: [], links: [] })
  })

  // A recall that misses: the Chinese wording shares nothing with the record.
  const coldMiss = await store.recall({ query: '密码库怎么导出', cwd: projectA, sessionId: 's-enrich' })
  assert.equal(coldMiss.items.length, 0)

  const fakeLlm = {
    calls: 0,
    async *stream() {
      fakeLlm.calls += 1
      yield {
        type: 'text-delta',
        text: JSON.stringify({
          records: [{ id: written.record.id, aliases: ['密码库导出方法', 'password vault export'] }],
          links: [['密码库', 'vaultwarden']],
        }),
      }
      yield { type: 'usage', usage: { inputTokens: 120, outputTokens: 60 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  const ctx = {
    get: name => (name === 'llm'
      ? fakeLlm
      : name === 'agentDefaultModel'
        ? { currentSelection: () => ({ provider: 'fake', model: 'fake-model' }) }
        : undefined),
  }
  const config = {
    includeSubagents: true,
    llm: {
      enabled: true, enrich: true,
      enrichMaxPerSession: 4, enrichMaxPerDay: 6, enrichMinIntervalMs: 0,
      enrichMaxTokens: 500, enrichMaxRecords: 2, enrichTtlMs: 604_800_000,
    },
  }
  const budgets = { enrichDay: '', enrichCalls: 0, enrichBySession: new Map(), enrichLastAt: new Map() }
  const outcome = await enrichAfterFailure({
    ctx, store, config, sessionId: 's-enrich', startedAt: 0, budgets, visibility: 'public',
  })

  check('a missed recall spends one enrich call and writes aliases plus a learned group', () => {
    assert.equal(fakeLlm.calls, 1)
    assert.ok(outcome.enriched >= 1)
    assert.ok(outcome.linked >= 1)
    assert.ok((store.get(written.record.id).aliases ?? []).some(alias => alias.includes('密码库')))
    assert.equal(store.stats().concepts, 1)
  })

  await check('the same wording now recalls without any model call', async () => {
    const hit = await store.recall({ query: '密码库怎么导出', cwd: projectA })
    assert.ok(hit.items.length >= 1)
    assert.match(hit.items[0].record.trigger, /vaultwarden/)
  })

  check('the enrichment call is billed to the ledger', () => {
    const ledger = store.ledgerOf('s-enrich')
    assert.equal(ledger.enrichCalls, 1)
    assert.equal(ledger.enrichInputTokens, 120)
    assert.equal(ledger.enrichOutputTokens, 60)
  })

  const again = await enrichAfterFailure({
    ctx, store, config, sessionId: 's-enrich', startedAt: 0, budgets, visibility: 'public',
  })
  check('a record enriched once is not re-billed within the cooldown', () => {
    assert.equal(again.reason, 'no-targets')
    assert.equal(fakeLlm.calls, 1)
  })

  check('enrichment stays off with the model call disabled', async () => {
    const off = await enrichAfterFailure({
      ctx, store, config: { includeSubagents: true, llm: { enabled: false, enrich: true } },
      sessionId: 's-enrich', startedAt: 0, budgets, visibility: 'public',
    })
    assert.equal(off.reason, 'disabled')
  })
}

{
  // The audience rule outranks the repair: a private record's text never goes
  // to a model call made from a public conversation, even when it is the one
  // that missed.
  const { store } = makeStore()
  store.setSessionVisibility('s-private', 'private')
  await store.write({
    scope: 'project', kind: 'preference',
    trigger: '隐私触发的专属说法',
    claim: 'A private record must not be sent to a model from a public chat.',
    sensitivity: 'private',
    cwd: projectA, origin: 'test',
  })
  const missed = await store.recall({ query: '毫无关联的词句', cwd: projectA, sessionId: 's-private', visibility: 'private' })
  assert.equal(missed.items.length, 0)
  assert.ok((store.rejectsOf('s-private').top ?? []).some(entry => entry.reason === 'no-term-overlap'))

  const fakeLlm = {
    calls: 0,
    async *stream() {
      fakeLlm.calls += 1
      yield { type: 'text-delta', text: '{"records":[],"links":[]}' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  const ctx = {
    get: name => (name === 'llm'
      ? fakeLlm
      : name === 'agentDefaultModel'
        ? { currentSelection: () => ({ provider: 'fake', model: 'fake-model' }) }
        : undefined),
  }
  const outcome = await enrichAfterFailure({
    ctx, store,
    config: {
      includeSubagents: true,
      llm: {
        enabled: true, enrich: true,
        enrichMaxPerSession: 4, enrichMaxPerDay: 6, enrichMinIntervalMs: 0,
        enrichMaxTokens: 500, enrichMaxRecords: 2, enrichTtlMs: 604_800_000,
      },
    },
    sessionId: 's-private', startedAt: 0,
    budgets: { enrichDay: '', enrichCalls: 0, enrichBySession: new Map(), enrichLastAt: new Map() },
    visibility: 'public',
  })
  check('a private record is never enriched from a public conversation', () => {
    assert.equal(outcome.reason, 'no-targets')
    assert.equal(fakeLlm.calls, 0)
  })
}

{
  const config = { includeSubagents: false, llm: { enrichMinIntervalMs: 60_000, enrichMaxPerDay: 1, enrichMaxPerSession: 1 } }
  const budgets = { enrichDay: dayOf(Date.now()), enrichCalls: 0, enrichBySession: new Map(), enrichLastAt: new Map() }
  check('the enrich budget blocks subagents, cooldowns, and caps', () => {
    assert.equal(evaluateEnrichBudget({ budgets, config, sessionId: 'a', isSubagent: true }).allowed, false)
    assert.equal(evaluateEnrichBudget({ budgets, config, sessionId: 'a', isSubagent: false }).allowed, true)
    reserveEnrichBudget(budgets, 'a')
    assert.equal(evaluateEnrichBudget({ budgets, config, sessionId: 'a', isSubagent: false }).reason, 'cooldown')
    assert.equal(evaluateEnrichBudget({ budgets, config, sessionId: 'b', isSubagent: false }).reason, 'daily-cap')
  })
  const { store } = makeStore()
  await store.recordEnrichAttempt('s1')
  check('enrich reservations recover from the ledger', () => {
    const recovered = summarizeEnrichLedger(store.ledgerRows(), dayOf(Date.now()))
    assert.equal(recovered.calls, 1)
    assert.equal(recovered.bySession.get('s1'), 1)
    assert.ok(recovered.lastAt.get('s1') > 0)
  })
}

// -------------------------------------------------------- export migration

{
  const first = makeStore()
  const written = await first.store.write({
    scope: 'project', kind: 'fact',
    trigger: 'the fixtureword export fixture',
    claim: 'A record whose aliases and learned groups survive a migration.',
    aliases: ['语义导出别名'],
    cwd: projectA, origin: 'test',
  })
  await first.store.linkForms({ forms: ['语义词甲', 'fixtureword'], origin: 'test' })
  const rows = first.store.exportRecords({}).rows.map(record => first.store.exportRow(record))
  const conceptRows = first.store.exportConcepts().map(group => ({
    type: 'concept', format: 1, id: group.id, forms: group.forms,
    origin: group.origin, createdAt: group.createdAt, updatedAt: group.updatedAt,
  }))

  const second = makeStore()
  const summary = await second.store.importRows([...rows, ...conceptRows])
  await check('aliases and learned groups migrate through export/import', async () => {
    assert.equal(summary.linked, 1)
    const migrated = second.store.get(written.record.id)
    assert.deepEqual(migrated.aliases, ['语义导出别名'])
    assert.ok(migrated.aliasAt > 0)
    assert.equal(second.store.stats().concepts, 1)
    // Both migration fruits are live retrieval in the new store.
    const byAlias = await second.store.recall({ query: '语义导出', cwd: projectA, minRelevance: 1 })
    assert.ok(byAlias.items.length >= 1)
    const byConcept = await second.store.recall({ query: '语义词甲在哪', cwd: projectA, minRelevance: 1 })
    assert.ok(byConcept.items.length >= 1)
    assert.match(byConcept.items[0].record.trigger, /fixtureword/)
  })
  check('a newer import row replaces aliases as part of its version', async () => {
    const updated = await second.store.importRows([{
      ...rows[0],
      claim: 'A newer claim with new aliases.',
      aliases: ['更新后的别名'],
      updatedAt: rows[0].updatedAt + 10_000,
    }])
    assert.equal(updated.updated, 1)
    assert.deepEqual(second.store.get(written.record.id).aliases, ['更新后的别名'])
  })
}

// ---------------------------------------------- the reported field failures

{
  // The four reworded queries from the operator's live test, against a store
  // shaped like the one that failed: proxy restart, the ssh box, the hotspot,
  // the vaultwarden backup, and three backup distractors that used to crowd it
  // out.
  const { store } = makeStore()
  const write = (trigger, claim) => store.write({ scope: 'project', kind: 'fact', trigger, claim, cwd: projectA, origin: 'test' })
  await write('代理服务的重启步骤', 'Restart the proxy with systemctl restart nginx-proxy.')
  await write('玩客云盒子 ssh 连不上的排查', 'The box drops ssh when the MTU is wrong; set MTU 1400.')
  await write('手机热点连不上时切换信道', 'Channel congestion; switch the hotspot to channel 36.')
  const vault = await write('vaultwarden 备份脚本每周日运行', 'The vaultwarden backup script runs every Sunday at 3am.')
  await write('R2 存储桶的备份策略', 'R2 buckets use lifecycle rules, not scripts.')
  await write('加密照片包的备份位置', 'Encrypted photo archives live on the NAS.')
  await write('Hermes 旧数据的备份归档', 'Old Hermes data is archived in cold storage.')

  await check('the three queries that already worked keep working', async () => {
    const proxyHit = await store.recall({ query: '代理重启怎么弄', cwd: projectA })
    assert.match(proxyHit.items[0].record.trigger, /代理/)
    const sshHit = await store.recall({ query: '玩客云 ssh 连不上', cwd: projectA })
    assert.match(sshHit.items[0].record.trigger, /玩客云/)
    const hotspotHit = await store.recall({ query: '热点连不上', cwd: projectA })
    assert.match(hotspotHit.items[0].record.trigger, /热点/)
  })

  await check('before learning, the vaultwarden record is missed exactly as reported', async () => {
    const cold = await store.recall({ query: '密码库备份在哪', cwd: projectA })
    assert.ok(cold.items.every(item => item.record.id !== vault.record.id))
  })

  // The post-enrichment state: the agent has linked the product names and the
  // record carries the aliases the model wrote for the missed wording.
  await store.linkForms({ forms: ['密码库', 'vaultwarden', 'bitwarden', '密码管理器'], origin: 'test' })
  await store.updateAliases(vault.record.id, ['密码库备份在哪看', 'password vault backup location'])

  await check('after learning, the vaultwarden record answers the reworded query first', async () => {
    const learned = await store.recall({ query: '密码库备份在哪', cwd: projectA })
    assert.equal(learned.items[0].record.id, vault.record.id)
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
await check.report('regression')