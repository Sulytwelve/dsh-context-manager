/**
 * Shared test harness: an in-memory stand-in for the storage-domain facility.
 *
 * The domain only calls `get`/`entries`/`keys`/`size`/`put`/`delete`/
 * `deleteMany`/`update`, so a Map-backed table is a faithful substitute and the
 * tests stay independent of DSH.
 */

import { createStore } from '../lib/store.js'
import { DOMAIN_SPEC } from '../lib/domain.js'

export class FakeTable {
  constructor() {
    this.map = new Map()
  }

  get(key) {
    return this.map.get(key)
  }

  entries() {
    return [...this.map.entries()][Symbol.iterator]()
  }

  keys() {
    return [...this.map.keys()][Symbol.iterator]()
  }

  get size() {
    return this.map.size
  }

  async put(key, value) {
    this.map.set(key, value)
  }

  async delete(key) {
    return this.map.delete(key)
  }

  async deleteMany(keys) {
    let removed = 0
    for (const key of keys) if (this.map.delete(key)) removed += 1
    return removed
  }

  async update(key, fn) {
    const next = fn(this.map.get(key))
    this.map.set(key, next)
    return next
  }
}

/** One fake storage domain with every declared table. */
export function fakeDomain() {
  const tables = {}
  for (const name of Object.keys(DOMAIN_SPEC.tables)) tables[name] = new FakeTable()
  return {
    name: DOMAIN_SPEC.name,
    tables,
    table: name => tables[name],
    async close() {},
  }
}

export const TEST_CONFIG = { maxRecordChars: 2_000, probeMaxBytes: 262_144 }

/** Build a store over a fresh fake domain. */
export function makeStore(config = TEST_CONFIG) {
  const domain = fakeDomain()
  return { store: createStore({ domain, config, logger: undefined }), domain }
}

/**
 * Re-open a store over the same tables, rebuilding its index from the records —
 * the equivalent of a DSH restart against the same storage.
 */
export function reopen(domain, config = TEST_CONFIG) {
  return createStore({ domain, config, logger: undefined })
}

/** Tiny assertion runner that keeps every failure instead of stopping at the first. */
export function createChecker() {
  const results = []
  const pending = []
  const record = (label, error) => {
    if (error === undefined) {
      results.push(`PASS ${label}`)
      return
    }
    results.push(`FAIL ${label}: ${error?.message ?? error}`)
    process.exitCode = 1
  }
  /**
   * Run one assertion. A synchronous callback reports immediately; an async
   * callback returns a promise. `report` waits for every one of them, so a
   * missing `await` at a call site cannot hide a slow failure.
   */
  const check = (label, fn) => {
    try {
      const value = fn()
      if (value !== null && typeof value?.then === 'function') {
        const task = value.then(() => record(label), error => record(label, error))
        pending.push(task)
        return task
      }
      record(label)
    } catch (error) {
      record(label, error)
    }
  }
  check.report = async title => {
    await Promise.all(pending)
    console.log(results.join('\n'))
    const passed = results.filter(line => line.startsWith('PASS')).length
    console.log(`\n${title}: ${passed}/${results.length} checks passed`)
    return passed === results.length
  }
  return check
}
