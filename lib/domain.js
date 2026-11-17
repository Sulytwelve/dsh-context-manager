/**
 * Domain declaration and validators for the memory store.
 *
 * The storage-domain facility only calls `valueSchema.parse(stored)` on open,
 * so a duck-typed schema object is enough and this package keeps zero
 * `@deepseek-ai/*` imports.
 */

import { clip, oneLine } from './util.js'

const SCOPES = ['user', 'project', 'session']
const KINDS = ['preference', 'procedure', 'fact', 'decision', 'pitfall', 'hypothesis']
const STATUSES = ['active', 'stale', 'superseded', 'proposed']
const PROBE_KINDS = ['path-exists', 'file-contains']

function checkField(key, field, raw) {
  switch (field.kind) {
    case 'string': {
      if (typeof raw !== 'string') throw new TypeError(`${key} must be a string`)
      const value = clip(raw, field.max ?? 4000)
      if (field.enum !== undefined && !field.enum.includes(value)) throw new TypeError(`${key} has unsupported value '${value}'`)
      return value
    }
    case 'number': {
      if (typeof raw !== 'number' || !Number.isFinite(raw)) throw new TypeError(`${key} must be a finite number`)
      const low = field.min ?? -Infinity
      const high = field.max ?? Infinity
      return Math.min(high, Math.max(low, raw))
    }
    case 'boolean': {
      if (typeof raw !== 'boolean') throw new TypeError(`${key} must be a boolean`)
      return raw
    }
    case 'string[]': {
      if (!Array.isArray(raw)) throw new TypeError(`${key} must be an array`)
      return raw
        .filter(item => typeof item === 'string')
        .slice(0, field.maxItems ?? 12)
        .map(item => clip(item, field.maxItem ?? 80))
    }
    case 'object': {
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new TypeError(`${key} must be an object`)
      return raw
    }
    default:
      throw new TypeError(`unsupported field kind for ${key}`)
  }
}

/** Build a zod-shaped schema that validates and normalizes one record. */
function makeSchema(fields) {
  return {
    parse(value) {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new TypeError('record must be an object')
      }
      const out = {}
      for (const [key, field] of Object.entries(fields)) {
        const raw = value[key]
        if (raw === undefined || raw === null) {
          if (field.optional === true) continue
          throw new TypeError(`field ${key} is required`)
        }
        out[key] = checkField(key, field, raw)
      }
      return out
    },
    safeParse(value) {
      try {
        return { success: true, data: this.parse(value) }
      } catch (error) {
        return { success: false, error }
      }
    },
  }
}

const MEMORY_SCHEMA = makeSchema({
  id: { kind: 'string', max: 80 },
  key: { kind: 'string', max: 200 },
  scope: { kind: 'string', enum: SCOPES, max: 20 },
  kind: { kind: 'string', enum: KINDS, max: 20 },
  trigger: { kind: 'string', max: 600 },
  claim: { kind: 'string', max: 4000 },
  evidence: { kind: 'string', max: 1000, optional: true },
  status: { kind: 'string', enum: STATUSES, max: 20 },
  confidence: { kind: 'number', min: 0, max: 1 },
  createdAt: { kind: 'number' },
  updatedAt: { kind: 'number' },
  lastUsedAt: { kind: 'number', optional: true },
  uses: { kind: 'number', min: 0 },
  wins: { kind: 'number', min: 0 },
  harms: { kind: 'number', min: 0 },
  cwd: { kind: 'string', max: 500, optional: true },
  tags: { kind: 'string[]', maxItems: 12, maxItem: 60 },
  origin: { kind: 'string', max: 40 },
  sessionId: { kind: 'string', max: 80, optional: true },
  supersedes: { kind: 'string', max: 80, optional: true },
  supersededBy: { kind: 'string', max: 80, optional: true },
  probe: { kind: 'object', optional: true },
  note: { kind: 'string', max: 400, optional: true },
})

const TASK_SCHEMA = makeSchema({
  cwd: { kind: 'string', max: 500 },
  milestone: { kind: 'string', max: 900, optional: true },
  nextAction: { kind: 'string', max: 500, optional: true },
  openQuestion: { kind: 'string', max: 500, optional: true },
  acceptance: { kind: 'string', max: 500, optional: true },
  sessionId: { kind: 'string', max: 80, optional: true },
  turn: { kind: 'number', min: 0, optional: true },
  updatedAt: { kind: 'number' },
})

const LEDGER_SCHEMA = makeSchema({
  sessionId: { kind: 'string', max: 80 },
  cwd: { kind: 'string', max: 500, optional: true },
  origin: { kind: 'string', max: 20, optional: true },
  startedAt: { kind: 'number' },
  updatedAt: { kind: 'number' },
  turns: { kind: 'number', min: 0 },
  steps: { kind: 'number', min: 0 },
  inputTokens: { kind: 'number', min: 0 },
  outputTokens: { kind: 'number', min: 0 },
  cacheReadTokens: { kind: 'number', min: 0 },
  reasoningTokens: { kind: 'number', min: 0 },
  injections: { kind: 'number', min: 0 },
  injectionTokens: { kind: 'number', min: 0 },
  injectionMs: { kind: 'number', min: 0 },
  recallCandidates: { kind: 'number', min: 0 },
  recallRejected: { kind: 'number', min: 0 },
  probeRuns: { kind: 'number', min: 0 },
  probeFails: { kind: 'number', min: 0 },
  probeMs: { kind: 'number', min: 0 },
  distillCalls: { kind: 'number', min: 0 },
  distillInputTokens: { kind: 'number', min: 0 },
  distillOutputTokens: { kind: 'number', min: 0 },
  distillMs: { kind: 'number', min: 0 },
  written: { kind: 'number', min: 0 },
})

const EVENT_SCHEMA = makeSchema({
  at: { kind: 'number' },
  kind: { kind: 'string', max: 40 },
  sessionId: { kind: 'string', max: 80, optional: true },
  detail: { kind: 'string', max: 500 },
})

/** The declared domain: four tables, per-record layout, invalid records skipped. */
export const DOMAIN_SPEC = {
  name: 'agent_memory',
  version: 1,
  layout: 'per-record',
  invalidRecords: 'backup-and-skip',
  tables: {
    memories: { valueSchema: MEMORY_SCHEMA },
    tasks: { valueSchema: TASK_SCHEMA },
    ledger: { valueSchema: LEDGER_SCHEMA },
    events: { valueSchema: EVENT_SCHEMA },
  },
}

export { SCOPES, KINDS, STATUSES, PROBE_KINDS, MEMORY_SCHEMA, TASK_SCHEMA, LEDGER_SCHEMA, EVENT_SCHEMA, oneLine }
