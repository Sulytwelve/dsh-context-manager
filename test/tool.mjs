/**
 * Tool-entry contract test: apply the real `memory-core` row to a minimal fake
 * Host, then exercise the registered `memory` tool the way a model would.
 *
 * The store-level suites test the store; this one tests the boundary the review
 * flagged: owner authorization, the audience shown by `status`, export scope,
 * import path/limit handling, and the bridge refreshing with recall off.
 */

import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply } from '../index.js'
import { createChecker, fakeDomain } from './harness.mjs'

const check = createChecker()
const root = mkdtempSync(join(tmpdir(), 'memory-tool-'))
const projectA = join(root, 'project-a')
const projectB = join(root, 'project-b')
mkdirSync(projectA, { recursive: true })
mkdirSync(projectB, { recursive: true })

/** Minimal Host surface: the row only needs these methods. */
function makeHost(config = {}) {
  const listeners = new Map()
  const provides = new Map()
  const host = {
    tool: undefined,
    store: undefined,
    ctx: {
      logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
      storageDomain: { async open() { return fakeDomain() } },
      tools: {
        register(definition) {
          host.tool = definition
          return () => {}
        },
      },
      on(event, fn) {
        listeners.set(event, fn)
        return () => {}
      },
      effect(fn) {
        const dispose = fn()
        return () => { dispose?.() }
      },
      provide(name, value) {
        provides.set(name, value)
        if (name === 'memoryStore') host.store = value
      },
      get(name) {
        return provides.get(name)
      },
      fiber: { assertActive() {} },
    },
    listeners,
  }
  return host
}

const agent = (sessionId, cwd) => ({ id: sessionId, session: { header: { cwd } } })
const exec = (sessionId, cwd) => ({ agent: agent(sessionId, cwd) })

// ------------------------------------------------------------- core row

const host = makeHost()
await apply(host.ctx, { recall: { visibilityBridge: false } })
check('the row registers the memory tool and the store', () => {
  assert.equal(host.tool?.name, 'memory')
  assert.equal(typeof host.store?.write, 'function')
})

const bWrite = await host.tool.execute({
  op: 'write', scope: 'project', kind: 'fact',
  trigger: 'a project b fact managed only from project b',
  claim: 'Project B keeps a fact that project A must not read or retire.',
  evidence: 'b/notes.md', confidence: 0.9,
}, exec('session-b', projectB))
check('a project record is written through the tool', () => {
  assert.match(bWrite.text, /^stored mem_/)
})
const bRecord = host.store.list({ limit: 20 }).find(record => record.cwd === projectB)
assert.ok(bRecord !== undefined)

let forgetFailure
try {
  await host.tool.execute({ op: 'forget', id: bRecord.id.slice(-6) }, exec('session-a', projectA))
} catch (error) {
  forgetFailure = error
}
check('an id operation from another project is refused without disclosing the record', () => {
  assert.match(String(forgetFailure?.message), /unknown memory/)
  assert.equal(host.store.get(bRecord.id).status, 'active')
})

const exportDefault = await host.tool.execute({ op: 'export', limit: 50 }, exec('session-a', projectA))
const exportAll = await host.tool.execute({ op: 'export', all: true, limit: 50 }, exec('session-a', projectA))
check('export defaults to the caller’s owners; `all` is the operator-wide path', () => {
  assert.equal(exportDefault.text.includes(bRecord.id), false)
  assert.equal(exportAll.text.includes(bRecord.id), true)
  const header = JSON.parse(exportDefault.text.split('\n')[0])
  assert.equal(header.total, 0)
})

// A private conversation's write defaults to private.
host.store.setSessionVisibility('private-session', 'private')
const privateWrite = await host.tool.execute({
  op: 'write', scope: 'project', kind: 'preference',
  trigger: 'a preference told only in a private chat',
  claim: 'Private conversations must not leak what they teach into shared recall.',
}, exec('private-session', projectA))
const privateRecord = host.store.list({ limit: 20 })
  .find(record => record.trigger === 'a preference told only in a private chat')
check('a write in a private conversation defaults to private', () => {
  assert.equal(privateRecord?.sensitivity, 'private')
  assert.match(privateWrite.text, /private/)
})

const status = await host.tool.execute({ op: 'status' }, exec('session-public', projectA))
check('a public status shows neither the private record nor its diagnostic', () => {
  assert.equal(status.text.includes(privateRecord.id.slice(-6)), false)
  assert.equal(status.text.includes('a preference told only in a private chat'), false)
})

// Import: a relative path resolves against the calling session's directory.
const row = {
  type: 'memory', format: 1, id: 'mem_tool_import', dedupeKey: 'project:fact:tool import',
  owner: `project:${projectA.replace(/\\/g, '/')}`, scope: 'project', kind: 'fact',
  trigger: 'the tool import fixture', claim: 'A row imported through the tool lands in the caller project.',
  confidence: 0.5, status: 'active', createdAt: 1_700_000_000_000, updatedAt: 1_700_000_000_000,
}
writeFileSync(join(projectA, 'import.jsonl'), `${JSON.stringify(row)}\n`)
const imported = await host.tool.execute({ op: 'import', path: 'import.jsonl' }, exec('session-a', projectA))
check('import resolves a relative path against the working directory', () => {
  assert.match(imported.text, /1 new/)
  assert.ok(host.store.get('mem_tool_import') !== undefined)
})
let oversize
try {
  await host.tool.execute({ op: 'import', payload: 'x'.repeat(8_000_001) }, exec('session-a', projectA))
} catch (error) {
  oversize = error
}
check('import measures bytes, not UTF-16 length', () => {
  assert.match(String(oversize?.message), /too large/)
})

// ---------------------------------------------- bridge refresh with recall off

const prefs = join(root, 'model-prefs.json')
const bridgeHost = makeHost()
await apply(bridgeHost.ctx, {
  recall: { enabled: false, visibilityBridge: true, visibilityBridgePath: prefs },
})
const preStep = bridgeHost.listeners.get('agent/pre-step')
writeFileSync(prefs, JSON.stringify({ sessionIds: { 'qqbot:1:c2c:peer': 'bridge-session' } }))
await preStep(
  { agent: agent('bridge-session', projectA), step: 1, turn: 1 },
  async () => ({ kind: 'accept', messages: [] }),
)
check('the bridge refreshes even when automatic recall is off', () => {
  assert.equal(bridgeHost.store.sessionVisibility('bridge-session'), 'private')
})
const preStep2 = bridgeHost.listeners.get('agent/pre-step')
writeFileSync(prefs, JSON.stringify({ sessionIds: {} }))
await preStep2(
  { agent: agent('bridge-session', projectA), step: 1, turn: 2 },
  async () => ({ kind: 'accept', messages: [] }),
)
check('removing the mapping withdraws the bridge declaration', () => {
  assert.equal(bridgeHost.store.sessionVisibility('bridge-session'), 'public')
})

await check.report('tool')
