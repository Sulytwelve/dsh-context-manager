/**
 * The memory store: retrieval scoring, record lifecycle, durable task
 * checkpoints, and the measurement ledger.
 *
 * Reads are served synchronously from the storage-domain in-memory state, so a
 * recall costs no I/O and no model call. Writes are queued on the domain's
 * single write chain and land atomically per record.
 */

import {
  dedupeKey, estimateTokens, normalizeCwd, nowMs, oneLine, runProbe, safeKey, similarity, slug, tokenize, uuid,
} from './util.js'
import { KINDS, SCOPES, STATUSES } from './domain.js'

const EVENT_RING_LIMIT = 260
const EVENT_PRUNE_BATCH = 60

/** Normalize caller input into a bounded confidence. */
function confidenceOf(value, fallback) {
  const number = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(1, Math.max(0, number))
}

/** Term sets of one record: the trigger (plus tags) decides applicability, the claim adds recall. */
function termsOf(record) {
  const trigger = new Set(tokenize(record.trigger))
  for (const tag of record.tags ?? []) for (const term of tokenize(tag)) trigger.add(term)
  const all = new Set(trigger)
  for (const term of tokenize(record.claim)) all.add(term)
  return { trigger: [...trigger], all }
}

/** Short stable id shown in a recall packet. */
export function shortId(id) {
  return String(id).slice(-6)
}

/** One-line packet rendering of a memory record. */
export function renderItem(record) {
  const scope = record.scope === 'user' ? '' : `·${record.scope}`
  const used = record.uses > 0 ? ` ·${record.uses}x` : ''
  const feedback = record.wins > 0 ? ' +' : record.harms > 0 ? ' -' : ''
  const evidence = record.evidence ? ` — ${oneLine(record.evidence, 140)}` : ''
  return `- [${shortId(record.id)}] ${record.kind}${scope} (${record.confidence.toFixed(2)}${used}${feedback}): `
    + `${oneLine(record.trigger, 160)} → ${oneLine(record.claim, 420)}${evidence}`
}

/** Create the store over an opened domain. */
export function createStore({ domain, config, logger }) {
  const memories = domain.table('memories')
  const tasks = domain.table('tasks')
  const ledgerTable = domain.table('ledger')
  const events = domain.table('events')

  /** id → { trigger: string[], triggerSet: Set<string>, all: Set<string> } */
  const index = new Map()
  /** term → document frequency */
  const df = new Map()
  /** memory.key → id of the single active record */
  const byKey = new Map()
  /** sessionId → ledger record (authoritative while live) */
  const ledgers = new Map()
  const dirtyLedgers = new Set()
  const curatedCheckpoints = new Set()
  let eventCount = 0

  const log = (level, text) => {
    try {
      logger?.[level]?.(`[memory] ${text}`)
    } catch {
      // logging must never break the caller
    }
  }

  // ---------------------------------------------------------------- index ----

  function addIndex(record) {
    if (record.status === 'superseded') return
    const terms = termsOf(record)
    index.set(record.id, { trigger: terms.trigger, triggerSet: new Set(terms.trigger), all: terms.all })
    for (const term of terms.all) df.set(term, (df.get(term) ?? 0) + 1)
    byKey.set(record.key, record.id)
  }

  function dropIndex(record) {
    const entry = index.get(record.id)
    if (entry !== undefined) {
      for (const term of entry.all) {
        const next = (df.get(term) ?? 1) - 1
        if (next <= 0) df.delete(term)
        else df.set(term, next)
      }
      index.delete(record.id)
    }
    if (byKey.get(record.key) === record.id) byKey.delete(record.key)
  }

  function rebuild() {
    index.clear()
    df.clear()
    byKey.clear()
    for (const [, record] of memories.entries()) addIndex(record)
    log('debug', `opened with ${memories.size} memories, ${tasks.size} task checkpoints`)
  }

  // --------------------------------------------------------------- recall ----

  function idf(term) {
    const total = Math.max(1, memories.size)
    return Math.log(1 + total / Math.max(1, df.get(term) ?? 0))
  }

  /**
   * Score and pack a recall packet.
   *
   * Every rejection is counted so the ledger can distinguish "nothing matched"
   * from "matched but did not earn its tokens".
   */
  function recall(options) {
    const started = nowMs()
    const query = String(options.query ?? '')
    const cwd = normalizeCwd(options.cwd)
    const limit = options.limit ?? 3
    const budgetTokens = options.budgetTokens ?? 220
    const minRelevance = options.minRelevance ?? 2.5
    const exclude = options.excludeIds ?? new Set()
    const probeOnRecall = options.probeOnRecall !== false
    const probeTtlMs = options.probeTtlMs ?? 86_400_000
    const now = Date.now()

    const terms = tokenize(query)
    let queryMass = 0
    for (const term of terms) queryMass += idf(term)
    queryMass = queryMass || 1

    const scored = []
    const explain = options.explain === true ? [] : undefined
    let considered = 0
    let rejected = 0
    let probeFails = 0
    const probeLines = []
    let probeMs = 0

    if (terms.length > 0) {
      for (const [id, record] of memories.entries()) {
        if (record.status !== 'active') continue
        if (exclude.has(id)) continue
        const memoryCwd = normalizeCwd(record.cwd)
        if (record.scope === 'project' && memoryCwd !== undefined && memoryCwd !== cwd) continue
        considered += 1
        const entry = index.get(id)
        if (entry === undefined) continue

        // Coverage, not cosine: the trigger asks "does this record apply to
        // this situation?", the claim only adds supporting vocabulary. The
        // trigger contribution saturates so a verbose trigger is not punished
        // for the words it does not share with the query.
        let triggerHits = 0
        for (const term of terms) {
          if (entry.triggerSet.has(term)) triggerHits += idf(term)
        }
        let queryHits = 0
        for (const term of terms) if (entry.all.has(term)) queryHits += idf(term)
        if (triggerHits === 0 && queryHits === 0) {
          rejected += 1
          explain?.push({ id, relevance: 0, reason: 'no-term-overlap' })
          continue
        }
        const triggerScore = triggerHits / (triggerHits + 5)
        const queryCoverage = queryHits / queryMass
        let score = 10 * (0.6 * triggerScore + 0.4 * queryCoverage)
        const lowerQuery = query.toLowerCase()
        if (record.trigger.length >= 8 && lowerQuery.includes(record.trigger.toLowerCase())) score += 2
        const quality = 0.6 + 0.4 * record.confidence
        const feedback = 1 + Math.min(record.wins, 3) * 0.05 - Math.min(record.harms, 2) * 0.15
        const ageDays = Math.max(0, now - (record.updatedAt ?? now)) / 86_400_000
        const freshness = ageDays <= 7 ? 1 : ageDays <= 30 ? 0.95 : 0.85
        const relevance = score * quality * feedback * freshness
        explain?.push({ id, relevance, score, triggerHits, triggerScore, queryCoverage })
        if (relevance < minRelevance) {
          rejected += 1
          continue
        }
        scored.push({ record, relevance })
      }
    }

    scored.sort((left, right) => right.relevance - left.relevance)

    // Probe only the head of the ranking: the cheap observation must stay cheap.
    const probeHead = Math.min(scored.length, 5)
    const probeStarted = nowMs()
    const alive = []
    for (let position = 0; position < scored.length; position += 1) {
      const candidate = scored[position]
      const record = candidate.record
      if (position < probeHead && probeOnRecall && record.probe !== undefined) {
        const stale = now - (record.updatedAt ?? 0) > probeTtlMs
        if (stale) {
          const result = runProbe(record.probe, record.cwd ?? options.cwd, config.probeMaxBytes)
          if (!result.ok) {
            probeFails += 1
            probeLines.push(`${shortId(record.id)} ${result.detail}`)
            void markProbe(record.id, false, result.detail).catch(() => {})
            continue
          }
          probeLines.push(`${shortId(record.id)} ${result.detail}`)
          void markProbe(record.id, true, result.detail).catch(() => {})
        }
      }
      alive.push(candidate)
    }
    probeMs += nowMs() - probeStarted

    const items = []
    let usedTokens = 0
    for (const candidate of alive) {
      if (items.length >= limit) break
      const line = renderItem(candidate.record)
      const tokens = estimateTokens(line)
      if (tokens > budgetTokens) {
        rejected += 1
        continue
      }
      if (usedTokens + tokens > budgetTokens) break
      usedTokens += tokens
      items.push({ record: candidate.record, relevance: candidate.relevance, line, tokens })
    }
    if (alive.length > items.length) rejected += alive.length - items.length

    return {
      items,
      considered,
      rejected,
      probeFails,
      probeLines,
      tokens: usedTokens,
      ms: nowMs() - started,
      probeMs,
      terms: terms.length,
      ...(explain === undefined ? {} : { explain: explain.sort((left, right) => right.relevance - left.relevance) }),
    }
  }

  // ---------------------------------------------------------------- write ----

  async function write(input) {
    const now = Date.now()
    const claim = oneLine(input.claim, config.maxRecordChars)
    const trigger = oneLine(input.trigger, 500)
    if (claim.length < 12) throw new Error('memory claim is too short to be transferable (min 12 chars)')
    if (trigger.length < 3) throw new Error('memory trigger is too short (min 3 chars) — name when it applies')
    const scope = SCOPES.includes(input.scope) ? input.scope : 'project'
    const kind = KINDS.includes(input.kind) ? input.kind : 'fact'
    const triggerKey = dedupeKey(scope, kind, trigger)

    // One active record per trigger. A restated claim merges into it — that is
    // how an explicit write and a later distillation of the same lesson stay a
    // single record instead of two near-duplicates.
    let mergeTarget
    let sameTrigger
    for (const [, record] of memories.entries()) {
      if (record.status !== 'active' || record.scope !== scope || record.kind !== kind) continue
      if (record.key !== triggerKey && !record.key.startsWith(`${triggerKey}|`)) continue
      if (sameTrigger === undefined) sameTrigger = record
      if (similarity(record.claim, claim) >= 0.35) {
        mergeTarget = record
        break
      }
    }

    const key = mergeTarget !== undefined
      ? mergeTarget.key
      : sameTrigger === undefined
        ? triggerKey
        : `${triggerKey}|${slug(claim, 40)}`
    const existingId = byKey.get(key)
    const existing = mergeTarget ?? (existingId === undefined ? undefined : memories.get(existingId))

    if (existing !== undefined && existing.status === 'active') {
      const incomingConfidence = confidenceOf(input.confidence, 0.6)
      // Keep the better-supported wording: a lower-confidence restatement must
      // not overwrite a verified claim.
      const preferIncoming = incomingConfidence >= existing.confidence - 0.05
      const merged = {
        ...existing,
        trigger,
        claim: preferIncoming ? claim : existing.claim,
        evidence: input.evidence ? oneLine(input.evidence, 900) : existing.evidence,
        confidence: Math.max(existing.confidence, incomingConfidence),
        updatedAt: now,
        tags: Array.isArray(input.tags) && input.tags.length > 0 ? input.tags.slice(0, 12) : existing.tags,
        probe: input.probe ?? existing.probe,
        note: input.note ? oneLine(input.note, 380) : existing.note,
      }
      dropIndex(existing)
      await memories.put(merged.id, merged)
      addIndex(merged)
      return { record: merged, created: false }
    }

    const record = {
      id: `mem_${now.toString(36)}_${uuid().slice(0, 8)}`,
      key,
      scope,
      kind,
      trigger,
      claim,
      evidence: input.evidence ? oneLine(input.evidence, 900) : undefined,
      status: input.status === 'proposed' ? 'proposed' : 'active',
      confidence: confidenceOf(input.confidence, input.evidence ? 0.7 : 0.55),
      createdAt: now,
      updatedAt: now,
      uses: 0,
      wins: 0,
      harms: 0,
      cwd: scope === 'project' && typeof input.cwd === 'string' ? input.cwd : undefined,
      tags: Array.isArray(input.tags) ? input.tags.slice(0, 12) : [],
      origin: oneLine(input.origin ?? 'model', 40),
      sessionId: input.sessionId,
      supersedes: input.supersedes,
      probe: input.probe,
      note: input.note ? oneLine(input.note, 380) : undefined,
    }
    // Strip undefined keys so the stored record is lossless JSON.
    for (const key of Object.keys(record)) if (record[key] === undefined) delete record[key]

    await memories.put(record.id, record)
    addIndex(record)

    if (typeof input.supersedes === 'string') {
      const previous = memories.get(input.supersedes)
      if (previous !== undefined && previous.status !== 'superseded') {
        const next = { ...previous, status: 'superseded', supersededBy: record.id, updatedAt: now }
        dropIndex(previous)
        await memories.put(next.id, next)
      }
    }
    return { record, created: true }
  }

  async function setStatus(id, status, note) {
    if (!STATUSES.includes(status)) throw new Error(`unsupported status '${status}'`)
    const current = memories.get(id)
    if (current === undefined) throw new Error(`unknown memory '${id}'`)
    const next = { ...current, status, updatedAt: Date.now() }
    if (typeof note === 'string' && note !== '') next.note = oneLine(note, 380)
    if (status === 'superseded' && current.status !== 'superseded') next.supersededBy = 'manual'
    dropIndex(current)
    await memories.put(next.id, next)
    if (status !== 'superseded') addIndex(next)
    return next
  }

  async function forget(id, reason) {
    return setStatus(id, 'superseded', reason ?? 'forgotten by request')
  }

  async function feedback(id, useful) {
    const current = memories.get(id)
    if (current === undefined) throw new Error(`unknown memory '${id}'`)
    const next = {
      ...current,
      wins: current.wins + (useful ? 1 : 0),
      harms: current.harms + (useful ? 0 : 1),
      updatedAt: Date.now(),
    }
    dropIndex(current)
    await memories.put(next.id, next)
    addIndex(next)
    return next
  }

  async function recordUses(ids) {
    const now = Date.now()
    for (const id of ids) {
      const current = memories.get(id)
      if (current === undefined) continue
      const next = { ...current, uses: current.uses + 1, lastUsedAt: now }
      await memories.put(next.id, next)
    }
  }

  async function markProbe(id, ok, detail) {
    const current = memories.get(id)
    if (current === undefined) return undefined
    if (ok) {
      if (current.status !== 'stale') return current
      const next = { ...current, status: 'active', updatedAt: Date.now(), note: oneLine(`probe passed: ${detail}`, 300) }
      dropIndex(current)
      await memories.put(next.id, next)
      addIndex(next)
      return next
    }
    const next = {
      ...current,
      status: 'stale',
      updatedAt: Date.now(),
      note: oneLine(`probe failed: ${detail}`, 300),
    }
    dropIndex(current)
    await memories.put(next.id, next)
    return next
  }

  // ----------------------------------------------------------- checkpoint ----

  function checkpointKey(cwd) {
    // The record key must be path-safe; the human-readable cwd lives in the value.
    return safeKey(normalizeCwd(cwd) ?? String(cwd ?? 'unknown'))
  }

  function getCheckpoint(cwd) {
    if (typeof cwd !== 'string' || cwd === '') return undefined
    return tasks.get(checkpointKey(cwd))
  }

  async function checkpoint(cwd, patch) {
    if (typeof cwd !== 'string' || cwd === '') return undefined
    const key = checkpointKey(cwd)
    const previous = tasks.get(key)
    const next = {
      ...previous,
      cwd: previous?.cwd ?? cwd,
      updatedAt: Date.now(),
      ...Object.fromEntries(Object.entries(patch ?? {}).filter(([, value]) => value !== undefined)),
      sessionId: patch?.sessionId ?? previous?.sessionId,
    }
    await tasks.put(key, next)
    return next
  }

  /** Record that this session wrote a curated checkpoint, so automation must not overwrite it. */
  function markCurated(sessionId) {
    if (typeof sessionId === 'string' && sessionId !== '') curatedCheckpoints.add(sessionId)
  }

  function isCurated(sessionId) {
    return curatedCheckpoints.has(sessionId)
  }

  // ---------------------------------------------------------------- ledger ----

  function ledgerOf(sessionId) {
    let record = ledgers.get(sessionId)
    if (record === undefined) {
      const stored = ledgerTable.get(sessionId)
      record = stored ?? {
        sessionId,
        startedAt: Date.now(),
        updatedAt: Date.now(),
        turns: 0,
        steps: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        reasoningTokens: 0,
        injections: 0,
        injectionTokens: 0,
        injectionMs: 0,
        recallCandidates: 0,
        recallRejected: 0,
        probeRuns: 0,
        probeFails: 0,
        probeMs: 0,
        distillCalls: 0,
        distillInputTokens: 0,
        distillOutputTokens: 0,
        distillMs: 0,
        written: 0,
      }
      ledgers.set(sessionId, record)
    }
    return record
  }

  function bump(sessionId, patch) {
    if (typeof sessionId !== 'string' || sessionId === '') return
    const current = ledgerOf(sessionId)
    let changed = false
    const next = { ...current }
    for (const [key, value] of Object.entries(patch)) {
      if (key === 'cwd' || key === 'origin') {
        if (value !== undefined && next[key] !== value) {
          next[key] = value
          changed = true
        }
        continue
      }
      if (typeof value !== 'number' || !Number.isFinite(value)) continue
      next[key] = (typeof current[key] === 'number' ? current[key] : 0) + value
      changed = true
    }
    if (!changed) return
    next.updatedAt = Date.now()
    ledgers.set(sessionId, next)
    dirtyLedgers.add(sessionId)
  }

  async function flushLedger(sessionId) {
    if (!dirtyLedgers.has(sessionId)) return
    const record = ledgers.get(sessionId)
    if (record === undefined) return
    dirtyLedgers.delete(sessionId)
    try {
      const stored = ledgerTable.get(sessionId)
      const merged = stored === undefined ? record : {
        ...record,
        startedAt: Math.min(stored.startedAt, record.startedAt),
        turns: Math.max(stored.turns, record.turns),
        steps: Math.max(stored.steps, record.steps),
      }
      await ledgerTable.put(sessionId, merged)
      ledgers.set(sessionId, merged)
    } catch (error) {
      log('warn', `ledger flush failed: ${String(error?.message ?? error)}`)
    }
  }

  async function flushAll() {
    for (const sessionId of [...dirtyLedgers]) await flushLedger(sessionId)
  }

  // ---------------------------------------------------------------- events ----

  async function event(kind, detail, sessionId) {
    eventCount += 1
    try {
      if (events.size > EVENT_RING_LIMIT) {
        const oldest = [...events.entries()].sort((left, right) => left[1].at - right[1].at)
        const doomed = oldest.slice(0, EVENT_PRUNE_BATCH).map(([key]) => key)
        await events.deleteMany(doomed)
      }
      const key = `evt_${Date.now().toString(36)}_${uuid().slice(0, 6)}`
      await events.put(key, { at: Date.now(), kind: oneLine(kind, 38), detail: oneLine(detail, 480), sessionId })
    } catch (error) {
      log('debug', `event write failed: ${String(error?.message ?? error)}`)
    }
  }

  // ----------------------------------------------------------------- reads ----

  function list(filter = {}) {
    const out = []
    for (const [, record] of memories.entries()) {
      if (filter.status !== undefined && record.status !== filter.status) continue
      if (filter.scope !== undefined && record.scope !== filter.scope) continue
      if (filter.cwd !== undefined && normalizeCwd(record.cwd) !== normalizeCwd(filter.cwd) && record.scope === 'project') continue
      out.push(record)
    }
    out.sort((left, right) => right.updatedAt - left.updatedAt)
    return out.slice(0, filter.limit ?? 20)
  }

  function stats() {
    const byStatus = { active: 0, stale: 0, superseded: 0, proposed: 0 }
    const byKind = {}
    for (const [, record] of memories.entries()) {
      byStatus[record.status] = (byStatus[record.status] ?? 0) + 1
      byKind[record.kind] = (byKind[record.kind] ?? 0) + 1
    }
    return {
      memories: memories.size,
      byStatus,
      byKind,
      checkpoints: tasks.size,
      sessions: ledgerTable.size,
      events: events.size,
    }
  }

  function recentEvents(limit = 10) {
    const out = []
    for (const [, record] of events.entries()) out.push(record)
    out.sort((left, right) => right.at - left.at)
    return out.slice(0, limit)
  }

  /** Every persisted per-session ledger row, newest first. */
  function ledgerRows() {
    const out = []
    for (const [, record] of ledgerTable.entries()) out.push(record)
    out.sort((left, right) => right.updatedAt - left.updatedAt)
    return out
  }

  function allCheckpoints() {
    const out = []
    for (const [, record] of tasks.entries()) out.push(record)
    out.sort((left, right) => right.updatedAt - left.updatedAt)
    return out
  }

  rebuild()

  return {
    domain,
    recall,
    write,
    setStatus,
    forget,
    feedback,
    recordUses,
    markProbe,
    checkpoint,
    getCheckpoint,
    markCurated,
    isCurated,
    allCheckpoints,
    ledgerOf,
    bump,
    flushLedger,
    flushAll,
    event,
    list,
    stats,
    recentEvents,
    ledgerRows,
    log,
    async close() {
      await flushAll()
    },
  }
}
