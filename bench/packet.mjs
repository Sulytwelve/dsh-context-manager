/**
 * Print the exact recall packet a session would receive, without DSH.
 *
 *   node bench/packet.mjs <storageDir> "<query>" [--cwd <dir>] [--session <id>]
 *
 * Use it to see what one turn pays for before opening a session.
 */

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import { buildPacket } from '../index.js'
import { createStore } from '../lib/store.js'

function loadTable(directory, name) {
  const map = new Map()
  let files = []
  try {
    files = readdirSync(join(directory, name))
  } catch {
    return map
  }
  for (const file of files) {
    if (!file.endsWith('.json')) continue
    const document = JSON.parse(readFileSync(join(directory, name, file), 'utf8'))
    const record = document.record
    // The per-record backend names the document after the record key.
    map.set(document.key ?? file.slice(0, -'.json'.length), record)
  }
  return map
}

function asTable(map) {
  return {
    get: key => map.get(key),
    entries: () => [...map.entries()][Symbol.iterator](),
    keys: () => [...map.keys()][Symbol.iterator](),
    get size() {
      return map.size
    },
    async put(key, value) {
      map.set(key, value)
    },
    async delete(key) {
      return map.delete(key)
    },
    async deleteMany(keys) {
      let removed = 0
      for (const key of keys) if (map.delete(key)) removed += 1
      return removed
    },
    async update(key, fn) {
      const next = fn(map.get(key))
      map.set(key, next)
      return next
    },
  }
}

const [directory, query] = process.argv.slice(2)
if (directory === undefined || query === undefined) {
  console.error('usage: node bench/packet.mjs <storageDir> "<query>" [--cwd <dir>] [--session <id>]')
  process.exit(2)
}

const rest = process.argv.slice(4)
const flag = name => {
  const index = rest.indexOf(name)
  return index >= 0 ? rest[index + 1] : undefined
}

const tables = {
  memories: asTable(loadTable(directory, 'memories')),
  tasks: asTable(loadTable(directory, 'tasks')),
  ledger: asTable(loadTable(directory, 'ledger')),
  events: asTable(loadTable(directory, 'events')),
}
const store = createStore({
  domain: { name: 'agent_memory', table: name => tables[name], async close() {} },
  config: { maxRecordChars: 2_000, probeMaxBytes: 262_144 },
})

const packet = buildPacket(store, {
  query,
  cwd: flag('--cwd'),
  sessionId: flag('--session'),
  excludeIds: new Set(),
  includeResume: true,
  recall: {
    limit: 3,
    tokenBudget: 220,
    minRelevance: 2.5,
    probeOnRecall: true,
    probeTtlMs: 86_400_000,
    probeBudget: 5,
    resumeMaxAgeMs: 604_800_000,
  },
})

console.log(`packet tokens: ${packet.tokens ?? 0} (budget 220), items: ${packet.used ?? 0}, `
  + `candidates: ${packet.considered}, rejected: ${packet.rejected}, probes: ${packet.probeLines?.length ?? 0}`)
console.log('---')
console.log(packet.text === '' ? '(nothing injected)' : packet.text)
