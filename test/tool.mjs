/**
 * Tool-entry contract test: apply the real `memory-core` row to a minimal fake
 * Host, then exercise the registered `memory` tool the way a model would.
 *
 * The store-level suites test the store; this one tests the boundary the review
 * flagged: owner authorization, the shared store shown by `status` and export,
 * import path/limit handling, and the semantic dictionary through the tool.
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
await apply(host.ctx, {})
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

// One shared memory: a record marked private is still stored, recalled, and
// exported from every conversation; the marker is only for an outer guard.
const privateWrite = await host.tool.execute({
  op: 'write', scope: 'project', kind: 'preference',
  trigger: 'a preference told in one chat',
  claim: 'A marked record is shared by every conversation of this bot.',
  sensitivity: 'private',
}, exec('session-one', projectA))
const privateRecord = host.store.list({ limit: 20 })
  .find(record => record.trigger === 'a preference told in one chat')
check('a marked record is stored and shared across conversations', () => {
  assert.equal(privateRecord?.sensitivity, 'private')
  assert.match(privateWrite.text, /stored mem_/)
})

const status = await host.tool.execute({ op: 'status' }, exec('session-two', projectA))
const sharedRecall = await host.tool.execute({ op: 'recall', query: 'a preference told in one chat' }, exec('session-two', projectA))
check('another session sees the same store and recalls the marked record', () => {
  assert.equal(status.text.includes('privacy:'), false)
  assert.match(sharedRecall.text, /a preference told in one chat/)
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

// The agent writes its own retrieval dictionary through the tool.
const linkWrite = await host.tool.execute({
  op: 'write', scope: 'project', kind: 'fact',
  trigger: 'the semantic link fixture record',
  claim: 'A record reached through a learned synonym group.',
  aliases: ['语义联接别名'],
}, exec('session-a', projectA))
assert.match(linkWrite.text, /^stored mem_/)
const linked = await host.tool.execute({ op: 'link', forms: ['语义联接词', 'linkfixture'] }, exec('session-a', projectA))
check('link learns a synonym group through the tool', () => {
  assert.match(linked.text, /语义联接词 = linkfixture/)
  assert.equal(host.store.stats().concepts, 1)
})
const linkRecall = await host.tool.execute({ op: 'recall', query: '语义联接词', limit: 5 }, exec('session-a', projectA))
check('a learned group changes what the tool recall finds', () => {
  assert.match(linkRecall.text, /the semantic link fixture record/)
})
const unlinked = await host.tool.execute({ op: 'link', forms: ['语义联接词'], remove: true }, exec('session-a', projectA))
check('link with remove deletes the learned group', () => {
  assert.match(unlinked.text, /removed 1/)
  assert.equal(host.store.stats().concepts, 0)
})

// One shared store: the same export arguments produce the same records and
// concept rows from any conversation.
await host.tool.execute({ op: 'link', forms: ['导出组甲', 'exportfixture'] }, exec('session-b', projectA))
const exportA = await host.tool.execute({ op: 'export', limit: 100 }, exec('session-a', projectA))
const exportB = await host.tool.execute({ op: 'export', limit: 100 }, exec('session-b', projectA))
check('the same export from two sessions has the same shared content', () => {
  const bodyA = exportA.text.split('\n').slice(1)
  const bodyB = exportB.text.split('\n').slice(1)
  assert.deepEqual(bodyA, bodyB)
  assert.ok(bodyA.some(line => line.includes('"type":"concept"')))
  const header = JSON.parse(exportA.text.split('\n')[0])
  assert.equal('privateOmitted' in header, false)
  assert.equal('conceptsOmitted' in header, false)
})

await check.report('tool')
