/**
 * Local smoke test for the memory store, run with plain Node (no DSH Host).
 * Exercises retrieval, dedupe, probes, checkpoints, and the ledger fold.
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { buildPacket } from '../index.js'
import { createChecker, makeStore } from './harness.mjs'

const check = createChecker()
const { store } = makeStore()
const workspace = mkdtempSync(join(tmpdir(), 'memory-smoke-'))
writeFileSync(join(workspace, 'fixture.js'), 'export const checkpointCoordinator = true\n')

await store.write({
  scope: 'project',
  kind: 'procedure',
  trigger: 'debugging resume offsets in the parallel importer',
  claim: 'Run the integration fixture with two workers; the single-worker fixture bypasses the checkpoint coordinator.',
  evidence: 'tests/resume.test.ts',
  confidence: 0.85,
  cwd: workspace,
  origin: 'test',
  probe: { kind: 'file-contains', target: 'fixture.js', pattern: 'checkpointCoordinator' },
})
await store.write({
  scope: 'user',
  kind: 'preference',
  trigger: 'commit messages',
  claim: 'Write commit messages in Chinese and keep them to one line.',
  evidence: 'explicit user instruction',
  confidence: 0.95,
  sensitivity: 'public',
  origin: 'test',
})
await store.write({
  scope: 'project',
  kind: 'pitfall',
  trigger: 'exporting Office documents to PDF on Windows',
  claim: 'The bundled rasterizer needs a 300 DPI source or tables lose their borders.',
  evidence: 'office/render.ts',
  confidence: 0.6,
  cwd: workspace,
  origin: 'test',
})
await store.write({
  scope: 'project',
  kind: 'fact',
  trigger: '检查点协调器的偏移规则',
  claim: '检查点只能跨过分区内已持久完成偏移的连续前缀。',
  evidence: 'imports/coordinator.ts',
  confidence: 0.9,
  cwd: workspace,
  origin: 'test',
})

const englishQuery = await store.recall({ query: 'resume offsets fixture workers', cwd: workspace })
check('english recall finds the procedure', () => {
  assert.ok(englishQuery.items.length >= 1)
  assert.match(englishQuery.items[0].record.trigger, /resume offsets/)
})

const preferenceQuery = await store.recall({ query: 'what commit message style should I use', cwd: workspace })
check('user-scope preference is global', () => {
  assert.ok(preferenceQuery.items.some(item => item.record.kind === 'preference'))
})

const chineseQuery = await store.recall({ query: '检查点 偏移 分区', cwd: workspace })
check('cjk bigrams retrieve the chinese record', () => {
  assert.ok(chineseQuery.items.some(item => /检查点/.test(item.record.trigger)))
})

const unrelated = await store.recall({ query: 'quantum chromodynamics lattice spacing', cwd: workspace })
check('unrelated query injects nothing', () => {
  assert.equal(unrelated.items.length, 0)
  assert.ok(unrelated.rejected > 0)
})

const otherWorkspace = await store.recall({ query: 'resume offsets fixture workers', cwd: join(workspace, 'elsewhere') })
check('project scope does not leak across directories', () => {
  assert.equal(otherWorkspace.items.length, 0)
})

const writeResult = await store.write({
  scope: 'project',
  kind: 'procedure',
  trigger: 'debugging resume offsets in the parallel importer',
  claim: 'Run the integration fixture with two workers; the single-worker fixture bypasses the checkpoint coordinator.',
  evidence: 'tests/resume.test.ts',
  cwd: workspace,
  origin: 'test',
})
check('dedupe keeps one active record', () => {
  const active = store.list({ status: 'active' })
  const matching = active.filter(record => /resume offsets/.test(record.trigger))
  assert.equal(matching.length, 1)
  assert.equal(matching[0].id, writeResult.record.id)
})

const weaker = await store.write({
  scope: 'project',
  kind: 'procedure',
  trigger: 'debugging resume offsets in the parallel importer',
  claim: 'Run the fixture with two workers, because one worker hides the coordinator.',
  confidence: 0.4,
  cwd: workspace,
  origin: 'distill:short',
})
check('a lower-confidence restatement merges without overwriting the verified claim', () => {
  assert.equal(weaker.record.id, writeResult.record.id)
  assert.equal(weaker.created, false)
  assert.match(weaker.record.claim, /single-worker fixture bypasses/)
})

rmSync(join(workspace, 'fixture.js'))
const afterDelete = await store.recall({
  query: 'debugging resume offsets in the parallel importer',
  cwd: workspace,
  // Zero TTL means "check every time", including a record written this instant.
  probeTtlMs: 0,
})
check('a failed probe retires the record', () => {
  assert.ok(!afterDelete.items.some(item => /resume offsets/.test(item.record.trigger)))
  const stale = store.list({ status: 'stale' })
  assert.ok(stale.some(record => /resume offsets/.test(record.trigger)))
})

await store.checkpoint(workspace, {
  milestone: 'reproduced the offset skip',
  nextAction: 'add the barrier test',
  openQuestion: 'does checkpoint 81 persist before offset 80 commits?',
  acceptance: 'barrier test fails before the fix and recovers offset 80 after',
  sessionId: 'session-a',
})
const checkpoint = store.getCheckpoint(workspace)
check('checkpoint round-trips', () => {
  assert.equal(checkpoint.milestone, 'reproduced the offset skip')
  assert.match(checkpoint.acceptance, /barrier test/)
})

check('per-record keys stay path-safe for an absolute windows cwd', () => {
  const keys = [...store.domain.table('tasks').keys()]
  assert.ok(keys.length > 0)
  for (const key of keys) assert.match(key, /^[a-zA-Z0-9_-]+$/, `unsafe key: ${key}`)
})

const recallConfig = {
  limit: 3,
  tokenBudget: 220,
  minRelevance: 2.5,
  probeOnRecall: false,
  probeTtlMs: 86_400_000,
  resumeMaxAgeMs: 604_800_000,
}

await check('an unrelated prompt gets no packet even when a checkpoint exists', async () => {
  const packet = await buildPacket(store, {
    query: 'compute 17 * 23',
    cwd: workspace,
    excludeIds: new Set(),
    includeResume: true,
    sessionId: 'session-b',
    recall: recallConfig,
  })
  assert.equal(packet.text, '')
})

await check('a continuation prompt gets the resume line', async () => {
  const packet = await buildPacket(store, {
    query: 'resume the offset skip debugging: add the barrier test and reproduce the offset',
    cwd: workspace,
    excludeIds: new Set(),
    includeResume: true,
    sessionId: 'session-b',
    recall: recallConfig,
  })
  assert.match(packet.text, /Resume/)
  assert.match(packet.text, /barrier test/)
})

await check('an explicit resume request survives a checkpoint with no shared words', async () => {
  const packet = await buildPacket(store, {
    query: 'What was the last checkpoint here?',
    cwd: workspace,
    excludeIds: new Set(),
    includeResume: true,
    sessionId: 'session-b',
    recall: recallConfig,
  })
  assert.match(packet.text, /Resume/)
})

await check('a Chinese resume request is recognised too', async () => {
  const packet = await buildPacket(store, {
    query: '上次的进度到哪了？继续吧',
    cwd: workspace,
    excludeIds: new Set(),
    includeResume: true,
    sessionId: 'session-b',
    recall: recallConfig,
  })
  assert.match(packet.text, /Resume/)
})

await store.checkpoint(workspace, {
  milestone: 'done-marker '.repeat(40),
  nextAction: 'next-marker '.repeat(40),
  openQuestion: 'open-marker '.repeat(40),
  acceptance: 'accept-marker '.repeat(40),
  sessionId: 'session-a',
})
await check('a chatty checkpoint cannot consume the whole packet budget', async () => {
  const packet = await buildPacket(store, {
    query: 'What was the last checkpoint here?',
    cwd: workspace,
    excludeIds: new Set(),
    includeResume: true,
    sessionId: 'session-b',
    recall: recallConfig,
  })
  assert.match(packet.text, /Resume/)
  assert.ok(packet.tokens <= recallConfig.tokenBudget, `packet ${packet.tokens} > budget ${recallConfig.tokenBudget}`)
})

store.bump('session-a', { turns: 2, steps: 5, inputTokens: 12_000, outputTokens: 800, injections: 2, injectionTokens: 180 })
await store.flushLedger('session-a')
check('ledger flushes counters', () => {
  const ledger = store.ledgerOf('session-a')
  assert.equal(ledger.turns, 2)
  assert.equal(ledger.inputTokens, 12_000)
})

await store.event('test', 'smoke finished')
const stats = store.stats()
check('stats count every table', () => {
  assert.ok(stats.memories >= 4)
  assert.equal(stats.checkpoints, 1)
  assert.equal(stats.byStatus.stale, 1)
})

await check('one-line packet rendering is bounded', async () => {
  const english = await store.recall({ query: 'commit message style', cwd: workspace })
  const line = english.items[0]?.line ?? ''
  assert.ok(line.length < 900, `line too long: ${line.length}`)
})

rmSync(workspace, { recursive: true, force: true })
await store.close()

await check.report('smoke')
