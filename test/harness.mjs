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
  const check = (label, fn) => {
    try {
      fn()
      results.push(`PASS ${label}`)
      return true
    } catch (error) {
      results.push(`FAIL ${label}: ${error?.message ?? error}`)
      process.exitCode = 1
      return false
    }
  }
  check.report = title => {
    console.log(results.join('\n'))
    const passed = results.filter(line => line.startsWith('PASS')).length
    console.log(`\n${title}: ${passed}/${results.length} checks passed`)
    return passed === results.length
  }
  return check
}
