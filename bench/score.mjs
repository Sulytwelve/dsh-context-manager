/**
 * Score a query against a live memory store directory, without DSH.
 *
 *   node bench/score.mjs <storageDir> "<query>" [--cwd <dir>] [--threshold 2.5]
 *
 * `storageDir` is `$DSH_HOME/storages/agent_memory`. Prints every candidate
 * with its raw relevance so retrieval can be tuned against real records.
 */

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
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
    const key = document.key ?? record?.id ?? record?.sessionId ?? record?.cwd
    map.set(key, record)
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
  console.error('usage: node bench/score.mjs <storageDir> "<query>" [--cwd <dir>] [--threshold <n>]')
  process.exit(2)
}

const rest = process.argv.slice(4)
const cwdFlag = rest.indexOf('--cwd')
const thresholdFlag = rest.indexOf('--threshold')
const cwd = cwdFlag >= 0 ? rest[cwdFlag + 1] : undefined
const threshold = thresholdFlag >= 0 ? Number(rest[thresholdFlag + 1]) : 2.5

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

const result = store.recall({ query, cwd, budgetTokens: 220, minRelevance: threshold, explain: true })
console.log(`query terms: ${result.terms}, considered: ${result.considered}, rejected: ${result.rejected}`)
for (const row of result.explain ?? []) {
  const record = tables.memories.get(row.id)
  const marker = row.relevance >= threshold ? 'IN ' : '   '
  const parts = row.reason !== undefined
    ? row.reason
    : `trigger=${row.triggerScore.toFixed(2)} (hits ${row.triggerHits.toFixed(1)}) query=${row.queryCoverage.toFixed(2)}`
  console.log(`${marker} ${row.relevance.toFixed(3).padStart(7)} ${parts} ${row.id} ${record?.status} ${record?.kind} :: ${String(record?.trigger ?? '').slice(0, 90)}`)
}
console.log(`\nitems: ${result.items.length}, tokens: ${result.tokens}`)
for (const item of result.items) console.log(`  ${item.line}`)
