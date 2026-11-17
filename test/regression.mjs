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

import { probeDue, selectProbeCandidates } from '../lib/probe-plan.js'
import { evaluateSupport, toolClass } from '../lib/support.js'
import { recallEnabled } from '../index.js'
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
  await store.markProbe(first.record.id, true, 'contains ok')
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