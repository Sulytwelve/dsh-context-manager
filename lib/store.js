/**
 * The memory store: retrieval scoring, record lifecycle, durable task
 * checkpoints, and the measurement ledger.
 *
 * Reads are served synchronously from the storage-domain in-memory state, so a
 * recall costs no model call and no I/O unless a due probe reads its target.
 * Writes are queued on the domain's single write chain and land atomically per
 * record.
 */

import { isAbsolute } from 'node:path'
import {
  age, dedupeKey, estimateTokens, normalizeCwd, nowMs, oneLine, runProbe, safeKey, similarity, slug, tokenize, uuid,
} from './util.js'
import { probeDue, selectProbeCandidates } from './probe-plan.js'
import { KINDS, PROBE_KINDS, SCOPES, STATUSES } from './domain.js'

const EVENT_RING_LIMIT = 260
const EVENT_PRUNE_BATCH = 60

/** Export line format version; bump only for an incompatible field change. */
export const EXPORT_FORMAT = 1

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

/**
 * The unified isolation identity of a record.
 *
 * `user` is global; `project` belongs to one normalized working directory;
 * `session` belongs to one session id. Write-time dedupe, index rebuild, and
 * recall all use this one rule, so a record can never be merged, ranked, or
 * served outside the boundary it was recorded in.
 */
export function ownerFor(scope, cwd, sessionId) {
  if (scope === 'session') {
    return sessionId === undefined || sessionId === '' ? 'session:unknown' : `session:${sessionId}`
  }
  if (scope === 'user') return 'user'
  const normalized = normalizeCwd(cwd)
  return normalized === undefined ? 'project:unscoped' : `project:${normalized}`
}

/** Owner of a stored record, deriving it for records written before the field existed. */
export function ownerOf(record) {
  if (typeof record?.owner === 'string' && record.owner !== '') return record.owner
  return ownerFor(record?.scope, record?.cwd, record?.sessionId)
}

/**
 * Whether a record must be kept out of public conversations.
 *
 * `sensitivity` is independent of owner scope: a user-scope record can be
 * private and a project-scope one can be public. Records written before the
 * field existed are classified by the migration default: a personal preference
 * (`scope: user`, `kind: preference`) is private until an explicit
 * `sensitivity: "public"` review, because that is exactly the class that leaked
 * in the field audit; everything else stays public.
 */
export function isPrivateRecord(record) {
  if (record?.sensitivity === 'private') return true
  if (record?.sensitivity === 'public') return false
  return record?.scope === 'user' && record?.kind === 'preference'
}

/** One-line packet rendering of a memory record. */
export function renderItem(record, now = Date.now()) {
  const scope = record.scope === 'user' ? '' : `·${record.scope}`
  const used = record.uses > 0 ? ` ·${record.uses}x` : ''
  const feedback = record.wins > 0 ? ' +' : record.harms > 0 ? ' -' : ''
  // What kind of evidence backs it, and when that evidence was last checked:
  // the two facts a verifier needs before deciding how much to re-derive.
  const supportClass = record.support?.class === undefined ? '' : ` ${record.support.class}`
  const privateMark = isPrivateRecord(record) ? ' private' : ''
  const checked = record.lastCheckedAt === undefined ? '' : ` ·checked ${age(now - record.lastCheckedAt)}`
  const evidence = record.evidence ? ` — ${oneLine(record.evidence, 140)}` : ''
  return `- [${shortId(record.id)}] ${record.kind}${scope}${privateMark} (${record.confidence.toFixed(2)}${supportClass}${used}${feedback}${checked}): `
    + `${oneLine(record.trigger, 160)} → ${oneLine(record.claim, 420)}${evidence}`
}

/** Create the store over an opened domain. */
export function createStore({ domain, config, logger }) {
  const memories = domain.table('memories')
  const tasks = domain.table('tasks')
  const ledgerTable = domain.table('ledger')
  const events = domain.table('events')

  // Sessions explicitly declared private by config; the runtime setter can add
  // more (see setSessionVisibility). No host-side "public conversation" signal
  // exists, so this is the only way to declare one.

  /** id → { trigger: string[], triggerSet: Set<string>, all: Set<string> } */
  const index = new Map()
  /** term → document frequency */
  const df = new Map()
  /** memory.key → id of the single active record */
  const byKey = new Map()
  /** sessionId → ledger record (authoritative while live) */
  const ledgers = new Map()
  /** sessionId → the last recall's rejection summary (in-memory diagnostic). */
  const lastRejects = new Map()
  const dirtyLedgers = new Set()
  const curatedCheckpoints = new Set()
  /**
   * Sessions declared private (one-to-one) or public (group). Anything absent is
   * treated as public. A public declaration always wins over a private one: a
   * group/public signal beats a conflicting private mapping, which is the
   * fail-closed direction for audience.
   */
  const privateSessions = new Set()
  const publicSessions = new Set()
  /**
   * Sessions declared by the opt-in QQ bridge. Kept apart from the sets above
   * so replacing the bridge snapshot can withdraw its own declarations without
   * erasing a config seed or a transport's runtime declaration.
   */
  const bridgePrivate = new Set()
  const bridgePublic = new Set()
  const bridgeScopes = new Map()
  const seedVisibility = (ids, target) => {
    for (const sessionId of ids ?? []) {
      if (typeof sessionId === 'string' && sessionId !== '') target.add(sessionId)
    }
  }
  seedVisibility(config?.recall?.privateSessions, privateSessions)
  seedVisibility(config?.recall?.publicSessions, publicSessions)
  let eventCount = 0

  const log = (level, text) => {
    try {
      logger?.[level]?.(`[context-manager] ${text}`)
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
   * Asynchronous because a due probe reads a file: the Host event loop must not
   * wait on a network filesystem for a bounded check. Scoring itself is pure
   * in-memory work; only the probe section awaits.
   *
   * Every rejection is counted so the ledger can distinguish "nothing matched"
   * from "matched but did not earn its tokens".
   */
  async function recall(options) {
    const started = nowMs()
    const query = String(options.query ?? '')
    const cwd = normalizeCwd(options.cwd)
    const limit = options.limit ?? 3
    const budgetTokens = options.budgetTokens ?? 220
    const minRelevance = options.minRelevance ?? 2.5
    const exclude = options.excludeIds ?? new Set()
    const probeOnRecall = options.probeOnRecall !== false
    const probeTtlMs = options.probeTtlMs ?? 86_400_000
    const probeBudget = options.probeBudget ?? 5
    // Private records stay out of automatic packets unless the session is
    // explicitly private. The tool always passes `gatePrivate: true`; the
    // parameter remains as the low-level store switch the tests use, but no
    // configuration reaches it.
    const gatePrivate = options.gatePrivate !== false
    const privateSession = options.visibility === 'private'
    let gatedPrivate = 0
    /**
     * Why candidates did not make it, for `report`. Four classes the operator
     * asked for (no lexical overlap, below threshold, budget, probe) plus the
     * private gate and the packet limits; counts are cheap, the top three are
     * kept by relevance for one-line drill-down.
     */
    const rejectedByReason = {}
    const rejectedTop = []
    const noteReject = (record, relevance, reason) => {
      if (reason !== 'probe-budget') rejected += 1
      rejectedByReason[reason] = (rejectedByReason[reason] ?? 0) + 1
      const entry = {
        id: record?.id ?? '?',
        relevance: Math.round(Math.max(0, Number(relevance) || 0) * 100) / 100,
        reason,
      }
      if (rejectedTop.length < 3 || entry.relevance > rejectedTop[rejectedTop.length - 1].relevance) {
        rejectedTop.push(entry)
        rejectedTop.sort((left, right) => right.relevance - left.relevance)
        if (rejectedTop.length > 3) rejectedTop.pop()
      }
    }
    const now = Date.now()
    const queryOwner = {
      project: cwd === undefined ? undefined : `project:${cwd}`,
      session: options.sessionId === undefined ? undefined : `session:${options.sessionId}`,
    }

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
        // One isolation rule, shared verbatim with write() and the index:
        // `user` is global, `project` belongs to one normalized directory,
        // `session` belongs to one session id.
        const owner = ownerOf(record)
        if (record.scope === 'project' && owner !== queryOwner.project) continue
        if (record.scope === 'session' && owner !== queryOwner.session) continue
        if (gatePrivate && !privateSession && isPrivateRecord(record)) {
          gatedPrivate += 1
          noteReject(record, 0, 'private')
          explain?.push({ id, relevance: 0, reason: 'private-gated' })
          continue
        }
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
          noteReject(record, 0, 'no-term-overlap')
          explain?.push({ id, relevance: 0, reason: 'no-term-overlap' })
          continue
        }
        const triggerScore = triggerHits / (triggerHits + 5)
        const queryCoverage = queryHits / queryMass
        // Trigger coverage leads (0.6) and query coverage supports (0.4); the
        // 10-point scale and +5 softening are calibrated in bench/score.mjs.
        let score = 10 * (0.6 * triggerScore + 0.4 * queryCoverage)
        const lowerQuery = query.toLowerCase()
        if (record.trigger.length >= 8 && lowerQuery.includes(record.trigger.toLowerCase())) score += 2
        // Quality, feedback, and freshness are multipliers on the lexical score;
        // confidence moves it by at most ±20%, so a weak lexical match cannot be
        // rescued by a high confidence alone.
        const quality = 0.6 + 0.4 * record.confidence
        const feedback = 1 + Math.min(record.wins, 3) * 0.05 - Math.min(record.harms, 2) * 0.15
        const ageDays = Math.max(0, now - (record.updatedAt ?? now)) / 86_400_000
        const freshness = ageDays <= 7 ? 1 : ageDays <= 30 ? 0.95 : 0.85
        const relevance = score * quality * feedback * freshness
        explain?.push({ id, relevance, score, triggerHits, triggerScore, queryCoverage })
        if (relevance < minRelevance) {
          noteReject(record, relevance, 'below-threshold')
          continue
        }
        scored.push({ record, relevance })
      }
    }

    scored.sort((left, right) => right.relevance - left.relevance)

    // Probe the head of the ranking, least-recently-checked first, under a
    // fixed budget. A candidate that is still due when the budget runs out is
    // skipped rather than admitted unprobed: an unverified record in the packet
    // is worse than one fewer line.
    const probeStarted = nowMs()
    const alive = []
    let probeBudgetLeft = probeBudget
    let probeSkipped = 0
    let probeInconclusive = 0
    for (const candidate of scored) {
      const record = candidate.record
      if (probeOnRecall && probeDue(record, now, probeTtlMs)) {
        if (probeBudgetLeft <= 0) {
          probeSkipped += 1
          noteReject(record, candidate.relevance, 'probe-budget')
          continue
        }
        probeBudgetLeft -= 1
        const result = await runProbe(record.probe, record.cwd ?? options.cwd, config.probeMaxBytes)
        probeLines.push(`${shortId(record.id)} ${result.status}: ${result.detail}`)
        if (result.status === 'fail') {
          probeFails += 1
          noteReject(record, candidate.relevance, 'probe-failed')
          void markProbe(record.id, 'fail', result.detail, record.probe).catch(() => {})
          continue
        }
        if (result.status === 'inconclusive') {
          // "Could not see it" is not "it is gone": keep serving the record,
          // but advance its check clock so it is not re-read on every turn.
          probeInconclusive += 1
          void markProbe(record.id, 'inconclusive', result.detail, record.probe).catch(() => {})
        } else {
          void markProbe(record.id, 'pass', result.detail, record.probe).catch(() => {})
        }
      }
      alive.push(candidate)
    }
    probeMs += nowMs() - probeStarted

    const items = []
    let usedTokens = 0
    for (const candidate of alive) {
      if (items.length >= limit) {
        noteReject(candidate.record, candidate.relevance, 'packet-limit')
        continue
      }
      const line = renderItem(candidate.record)
      const tokens = estimateTokens(line)
      if (tokens > budgetTokens) {
        noteReject(candidate.record, candidate.relevance, 'token-budget')
        continue
      }
      if (usedTokens + tokens > budgetTokens) {
        noteReject(candidate.record, candidate.relevance, 'token-budget')
        continue
      }
      usedTokens += tokens
      items.push({ record: candidate.record, relevance: candidate.relevance, line, tokens })
    }

    if (options.sessionId !== undefined) {
      lastRejects.set(options.sessionId, {
        at: now,
        considered,
        rejected,
        gatedPrivate,
        top: rejectedTop,
        byReason: rejectedByReason,
      })
    }

    return {
      items,
      considered,
      rejected,
      rejectedTop,
      rejectedByReason,
      probeFails,
      probeInconclusive,
      probeSkipped,
      gatedPrivate,
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
    // `private` records are still scoped normally; they are withheld from
    // automatic injection unless the session is explicitly private, and remain
    // reachable only from a private conversation. `public` is an explicit
    // review that clears the legacy personal-preference default.
    const sensitivity = input.sensitivity === 'private'
      ? 'private'
      : input.sensitivity === 'public' ? 'public' : undefined
    const owner = ownerFor(scope, input.cwd, input.sessionId)
    const triggerKey = `${owner}|${dedupeKey(scope, kind, trigger)}`

    // A user-scope record has no directory of its own, so a relative probe would
    // resolve against whichever session happens to recall it. Require an
    // absolute target instead of letting the check mean different things.
    if (scope === 'user' && input.probe !== undefined
      && typeof input.probe?.target === 'string' && !isAbsolute(input.probe.target)) {
      throw new Error('a user-scope probe target must be an absolute path (it has no project directory to resolve against)')
    }

    // One active record per trigger *within one owner*. The owner filter is the
    // whole point: two projects that both record "how to run the full suite"
    // must not merge into a record that cites the other project's command.
    let mergeTarget
    let sameTrigger
    for (const [, record] of memories.entries()) {
      if (record.status !== 'active' || record.scope !== scope || record.kind !== kind) continue
      if (ownerOf(record) !== owner) continue
      if (record.key !== triggerKey && !record.key.startsWith(`${triggerKey}|`)) continue
      if (sameTrigger === undefined) sameTrigger = record
      // 0.35 term overlap is the restatement floor: below it the two claims are
      // treated as different lessons under one trigger (which `status` then
      // reports for review) rather than one version overwriting the other.
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
      // Confidence only rises on an ordinary restatement: a later write must not
      // quietly claim more certainty than the first. An explicit `demote` write
      // (or `setConfidence`) is the way down.
      const demote = input.demote === true
      const nextConfidence = demote
        ? incomingConfidence
        : Math.max(existing.confidence, incomingConfidence)
      // The claim, its evidence, its probe, and its support are one version:
      // take all of them or none. Keeping a new claim with the old evidence (or
      // the reverse) leaves a record whose wording and proof disagree. The 0.05
      // tolerance keeps a measurement-level drop from silently dropping the
      // evidence line; a deliberate downgrade uses `demote`.
      const preferIncoming = demote || incomingConfidence >= existing.confidence - 0.05
      const probeChanges = preferIncoming
        && JSON.stringify(input.probe ?? null) !== JSON.stringify(existing.probe ?? null)
      const merged = {
        ...existing,
        owner,
        trigger,
        confidence: nextConfidence,
        updatedAt: now,
        sensitivity: input.sensitivity === undefined ? existing.sensitivity : sensitivity,
        note: input.note ? oneLine(input.note, 380) : existing.note,
        ...(preferIncoming
          ? {
            claim,
            evidence: input.evidence ? oneLine(input.evidence, 900) : existing.evidence,
            probe: input.probe ?? (demote ? existing.probe : undefined),
            support: input.support ?? (demote ? existing.support : undefined),
            tags: Array.isArray(input.tags) && input.tags.length > 0 ? input.tags.slice(0, 12) : existing.tags,
          }
          : {}),
      }
      // A replaced (or dropped) probe invalidates the previous check.
      if (probeChanges) delete merged.lastCheckedAt
      dropIndex(existing)
      await memories.put(merged.id, merged)
      addIndex(merged)
      return { record: merged, created: false }
    }

    // Superseding is a management operation: the old record must belong to the
    // same owner as the new one, or a project could retire another project's
    // (or another session's) knowledge by guessing an id.
    let supersededRecord
    if (typeof input.supersedes === 'string') {
      supersededRecord = memories.get(input.supersedes)
      if (supersededRecord !== undefined && ownerOf(supersededRecord) !== owner) {
        throw new Error('supersedes must reference a record in the same owner scope')
      }
    }

    const record = {
      id: `mem_${now.toString(36)}_${uuid().slice(0, 8)}`,
      key,
      scope,
      kind,
      owner,
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
      cwd: scope !== 'user' && typeof input.cwd === 'string' ? input.cwd : undefined,
      tags: Array.isArray(input.tags) ? input.tags.slice(0, 12) : [],
      origin: oneLine(input.origin ?? 'model', 40),
      sessionId: input.sessionId,
      supersedes: input.supersedes,
      probe: input.probe,
      support: input.support,
      sensitivity,
      note: input.note ? oneLine(input.note, 380) : undefined,
    }
    // Strip undefined keys so the stored record is lossless JSON.
    for (const key of Object.keys(record)) if (record[key] === undefined) delete record[key]

    await memories.put(record.id, record)
    addIndex(record)

    if (supersededRecord !== undefined && supersededRecord.status !== 'superseded') {
      const next = { ...supersededRecord, status: 'superseded', supersededBy: record.id, updatedAt: now }
      dropIndex(supersededRecord)
      await memories.put(next.id, next)
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

  /**
   * Set a record's confidence directly, including downwards.
   *
   * A plain re-write only ever raises confidence (a later restatement must not
   * quietly claim more certainty), so correcting an over-confident import needs
   * this explicit path. Confidence feeds the ranking quality factor, so this
   * changes future ranking; it never changes the claim, evidence, probe, or
   * status.
   */
  async function setConfidence(id, confidence, note) {
    const current = memories.get(id)
    if (current === undefined) throw new Error(`unknown memory '${id}'`)
    const value = Number(confidence)
    if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error('confidence must be a number between 0 and 1')
    const next = { ...current, confidence: Math.min(1, Math.max(0, value)) }
    if (typeof note === 'string' && note !== '') next.note = oneLine(note, 380)
    dropIndex(current)
    await memories.put(next.id, next)
    addIndex(next)
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

  /**
   * Apply one probe outcome.
   *
   * `pass` advances the check clock (and revives a stale record); `fail` marks
   * it stale; `inconclusive` only advances the check clock, because failing to
   * see the evidence is not evidence that it is gone. A stale record stays
   * stale on `inconclusive` — it takes a real pass to revive.
   */
  async function markProbe(id, status, detail, expectedProbe) {
    const current = memories.get(id)
    if (current === undefined) return undefined
    // A probe runs asynchronously; by the time it finishes, the record's claim
    // or probe may have been replaced. Its verdict belongs to the old version,
    // so it must not retire the newer one.
    if (expectedProbe !== undefined
      && JSON.stringify(current.probe ?? null) !== JSON.stringify(expectedProbe ?? null)) {
      return current
    }
    const checkedAt = Date.now()
    if (status === 'pass') {
      // A passing check advances only the check clock. Bumping `updatedAt` here
      // would make a verified record look freshly written and reset its
      // ranking, and it would keep the sweep from ever reaching older records.
      const revived = current.status === 'stale'
      const next = revived
        ? { ...current, lastCheckedAt: checkedAt, status: 'active', updatedAt: checkedAt, note: oneLine(`probe passed: ${detail}`, 300) }
        : { ...current, lastCheckedAt: checkedAt }
      dropIndex(current)
      await memories.put(next.id, next)
      addIndex(next)
      return next
    }
    if (status === 'inconclusive') {
      return (await memories.update(id, current2 => ({
        ...current2,
        lastCheckedAt: checkedAt,
        note: oneLine(`probe inconclusive: ${detail}`, 300),
      })))
    }
    if (current.status === 'stale') {
      // Already retired and still failing: advance the check clock so the
      // record observes its cooldown, but do not re-stamp freshness. The
      // status transition event is emitted by the caller, not by this path.
      return (await memories.update(id, current2 => ({
        ...current2,
        lastCheckedAt: checkedAt,
        note: oneLine(`probe failed: ${detail}`, 300),
      })))
    }
    const next = {
      ...current,
      status: 'stale',
      lastCheckedAt: checkedAt,
      updatedAt: checkedAt,
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

  function getCheckpoint(cwd, sessionId) {
    if (typeof cwd !== 'string' || cwd === '') return undefined
    // A private checkpoint has its own key, so it neither leaks to other
    // sessions nor blocks (or is blocked by) the shared one for this directory.
    if (typeof sessionId === 'string' && sessionId !== '') {
      const own = tasks.get(privateCheckpointKey(cwd, sessionId))
      if (own !== undefined) return own
    }
    const shared = tasks.get(checkpointKey(cwd))
    if (shared === undefined) return undefined
    if (shared.sensitivity === 'public') return shared
    // Private, or legacy with no classification: only its own session may read
    // it. A mixed/unknown checkpoint is withheld as a whole.
    return shared.sessionId === sessionId ? shared : undefined
  }

  /** Whether a checkpoint exists for this directory but was withheld from this session. */
  function hasWithheldCheckpoint(cwd, sessionId) {
    if (typeof cwd !== 'string' || cwd === '') return false
    const shared = tasks.get(checkpointKey(cwd))
    if (shared === undefined || shared.sessionId === sessionId) return false
    return shared.sensitivity !== 'public'
  }

  function privateCheckpointKey(cwd, sessionId) {
    // Underscores only: the per-record JSON backend turns a key into a path
    // segment and rejects anything outside [a-zA-Z0-9_-]. The previous `|`
    // form made every private checkpoint write fail against the real backend.
    return `${checkpointKey(cwd)}_private_${safeKey(String(sessionId ?? 'unknown'))}`
  }

  async function checkpoint(cwd, patch) {
    if (typeof cwd !== 'string' || cwd === '') return undefined
    const isPrivate = patch?.private === true
    const key = isPrivate ? privateCheckpointKey(cwd, patch?.sessionId) : checkpointKey(cwd)
    const previous = tasks.get(key)
    const next = {
      ...previous,
      cwd: previous?.cwd ?? cwd,
      updatedAt: Date.now(),
      ...Object.fromEntries(Object.entries(patch ?? {}).filter(([, value]) => value !== undefined)),
      sessionId: patch?.sessionId ?? previous?.sessionId,
      // Classify every write so a later reader can decide. A legacy checkpoint
      // with no field stays unknown, and is therefore withheld from other
      // sessions instead of being assumed safe.
      sensitivity: patch?.sensitivity ?? (isPrivate ? 'private' : 'public'),
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

  /**
   * Declare whether a session is a private (one-to-one) conversation.
   *
   * DSH exposes no "group chat" metadata — the SessionHeader has cwd, parent,
   * origin and preset, nothing about audience — so this is the explicit
   * signal. The transport that does know (e.g. a chat plugin) should call
   * this, or the ids can be listed in `recall.privateSessions`. Anything not
   * declared is treated as public, because leaking a private preference into a
   * shared conversation costs much more than withholding it.
   */
  function setSessionVisibility(sessionId, value) {
    if (typeof sessionId !== 'string' || sessionId === '') return
    if (value === 'private') {
      // A public declaration is sticky: it wins over any private mapping.
      if (!publicSessions.has(sessionId)) privateSessions.add(sessionId)
      return
    }
    publicSessions.add(sessionId)
    privateSessions.delete(sessionId)
  }

  /**
   * Replace the bridge's previous session→scope snapshot with a new one.
   *
   * A removed or reclassified mapping withdraws the old bridge declaration;
   * declarations from config or a transport are untouched. Public still wins
   * over private across sources (the fail-closed direction), and a duplicate
   * session id inside the bridge map is resolved by the parser before it gets
   * here.
   */
  function applyBridgeScopes(scopes) {
    let applied = 0
    for (const [sessionId, scope] of [...bridgeScopes]) {
      if (scopes?.get(sessionId) === scope) continue
      bridgeScopes.delete(sessionId)
      if (scope === 'public') bridgePublic.delete(sessionId)
      else bridgePrivate.delete(sessionId)
    }
    for (const [sessionId, scope] of scopes ?? []) {
      if (typeof sessionId !== 'string' || sessionId === '') continue
      if (scope !== 'private' && scope !== 'public') continue
      if (bridgeScopes.get(sessionId) === scope) continue
      bridgeScopes.set(sessionId, scope)
      if (scope === 'public') {
        bridgePublic.add(sessionId)
        bridgePrivate.delete(sessionId)
      } else if (!bridgePublic.has(sessionId)) {
        bridgePrivate.add(sessionId)
      }
      applied += 1
    }
    return applied
  }

  function sessionVisibility(sessionId) {
    const id = String(sessionId)
    if (publicSessions.has(id) || bridgePublic.has(id)) return 'public'
    return privateSessions.has(id) || bridgePrivate.has(id) ? 'private' : 'public'
  }

  // ---------------------------------------------------------------- ledger ----

  /** The last recall's rejection summary for one session, or undefined. */
  function rejectsOf(sessionId) {
    return lastRejects.get(sessionId)
  }

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

  /**
   * Reserve one distillation attempt before the model request is made.
   *
   * The attempt is persisted (not just counted in memory) so a process restart
   * cannot hand the session a fresh daily or per-session budget, and so the
   * cross-turn cooldown survives a reload. A failed or interrupted request
   * still consumed the attempt — that is the point.
   */
  async function recordDistillAttempt(sessionId, at = Date.now()) {
    const day = new Date(at).toISOString().slice(0, 10)
    const current = ledgerOf(sessionId)
    const sameDay = current.distillDay === day
    const next = {
      ...current,
      distillDay: day,
      distillCallsToday: (sameDay ? current.distillCallsToday ?? 0 : 0) + 1,
      lastDistillAt: at,
      updatedAt: at,
    }
    ledgers.set(sessionId, next)
    dirtyLedgers.add(sessionId)
    await flushLedger(sessionId)
    return next
  }

  // ---------------------------------------------------------------- events ----

  async function event(kind, detail, sessionId, options = {}) {
    eventCount += 1
    try {
      if (events.size > EVENT_RING_LIMIT) {
        const oldest = [...events.entries()].sort((left, right) => left[1].at - right[1].at)
        const doomed = oldest.slice(0, EVENT_PRUNE_BATCH).map(([key]) => key)
        await events.deleteMany(doomed)
      }
      const key = `evt_${Date.now().toString(36)}_${uuid().slice(0, 6)}`
      const record = { at: Date.now(), kind: oneLine(kind, 38), detail: oneLine(detail, 480), sessionId }
      // Audience of the diagnostic, independent of the record it mentions:
      // `true` never leaves a private session, `false` is explicitly safe to
      // show, absent is legacy/unknown and is hidden from shared transcripts.
      if (typeof options.private === 'boolean') record.private = options.private
      await events.put(key, record)
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

  /** One record by exact id, or undefined. O(1): the table is the index. */
  function get(id) {
    return memories.get(id)
  }

  /**
   * Probe candidates across the whole store, least-recently-checked first.
   *
   * The background sweep used to start from `list({ limit: 5000 })`, which is
   * sorted by `updatedAt`: any record older than that window could never be
   * swept, no matter how overdue. Filtering by due state first is the fix; the
   * batch cap is applied only after the whole store is considered.
   */
  function probeCandidates(options = {}) {
    const now = options.now ?? Date.now()
    const recheckMs = options.recheckMs ?? 3_600_000
    const max = options.max ?? 40
    const all = []
    for (const [, record] of memories.entries()) all.push(record)
    return selectProbeCandidates(all, { now, recheckMs, max })
  }

  /**
   * Resolve a tool-supplied id to the full record id.
   *
   * Accepts the full id or an unambiguous suffix (`shortId`, or any trailing
   * fragment). One pass over the table keys, no sorting: this runs only on an
   * explicit tool operation, but it must not rebuild the whole list to do it.
   * An unknown id is returned unchanged so the caller's own "unknown memory"
   * error names what the user actually passed.
   */
  function resolveId(raw) {
    if (typeof raw !== 'string' || raw === '') throw new Error('"id" is required')
    if (memories.get(raw) !== undefined) return raw
    const suffix = raw.toLowerCase()
    let match
    for (const id of memories.keys()) {
      if (shortId(id) !== suffix && !id.endsWith(raw)) continue
      if (match !== undefined) throw new Error(`id "${raw}" is ambiguous; use the full id`)
      match = id
    }
    return match ?? raw
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

  /**
   * Scope+trigger groups that hold more than one active record.
   *
   * This is a *fact to review*, not a conflict verdict: one trigger may
   * legitimately cover different conditions, and both records may be correct.
   * Nothing here changes state, ranking, or recall; only `status` reads it.
   * Private records are excluded unless the reader is in a private session: the
   * hint would otherwise reveal their ids and triggers to a shared transcript.
   */
  function reviewGroups(visibility = 'public') {
    const groups = new Map()
    for (const [, record] of memories.entries()) {
      if (record.status !== 'active') continue
      if (visibility !== 'private' && isPrivateRecord(record)) continue
      const owner = ownerOf(record)
      const trigger = String(record.trigger ?? '').trim().toLowerCase()
      const key = `${owner}\u0000${trigger}`
      let group = groups.get(key)
      if (group === undefined) {
        group = { owner, trigger: record.trigger, ids: [] }
        groups.set(key, group)
      }
      group.ids.push(record.id)
    }
    return [...groups.values()]
      .filter(group => group.ids.length > 1)
      .sort((left, right) => right.ids.length - left.ids.length)
  }

  /**
   * Read-only export row for one record.
   *
   * The fields are the ones a later import would need: the record's own id and
   * its `dedupeKey`, so an importer can map a row back to the same record
   * instead of letting write-time dedupe merge two different ids. Ledger and
   * event rows are deliberately absent — they are local telemetry.
   */
  function exportRecords(filter = {}) {
    const rows = []
    let omitted = 0
    for (const [, record] of memories.entries()) {
      if (filter.status !== undefined && record.status !== filter.status) continue
      if (filter.scope !== undefined && record.scope !== filter.scope) continue
      if (filter.owner !== undefined && ownerOf(record) !== filter.owner) continue
      if (filter.owners !== undefined && !filter.owners.includes(ownerOf(record))) continue
      if (filter.includePrivate === false && isPrivateRecord(record)) {
        omitted += 1
        continue
      }
      rows.push(record)
    }
    rows.sort((left, right) => {
      const leftOwner = ownerOf(left)
      const rightOwner = ownerOf(right)
      if (leftOwner !== rightOwner) return leftOwner < rightOwner ? -1 : 1
      if (left.key !== right.key) return left.key < right.key ? -1 : 1
      if (left.id !== right.id) return left.id < right.id ? -1 : 1
      return 0
    })
    const offset = Math.max(0, filter.offset ?? 0)
    const limit = Math.min(500, Math.max(1, filter.limit ?? 100))
    return { total: rows.length, omitted, offset, limit, rows: rows.slice(offset, offset + limit) }
  }

  /** Stable JSON-able projection of one record for export. */
  function exportRow(record) {
    const row = {
      type: 'memory',
      format: EXPORT_FORMAT,
      id: record.id,
      dedupeKey: record.key,
      owner: ownerOf(record),
      scope: record.scope,
      kind: record.kind,
      trigger: record.trigger,
      claim: record.claim,
      evidence: record.evidence,
      confidence: record.confidence,
      status: record.status,
      sensitivity: record.sensitivity,
      tags: record.tags,
      probe: record.probe,
      support: record.support,
      cwd: record.cwd,
      sessionId: record.sessionId,
      origin: record.origin,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      lastUsedAt: record.lastUsedAt,
      lastCheckedAt: record.lastCheckedAt,
      uses: record.uses,
      wins: record.wins,
      harms: record.harms,
      supersedes: record.supersedes,
      supersededBy: record.supersededBy,
      note: record.note,
    }
    for (const key of Object.keys(row)) if (row[key] === undefined) delete row[key]
    return row
  }

  /** Ranking used when an import and the local record disagree about status. */
  const STATUS_STRENGTH = { active: 3, proposed: 2, stale: 1, superseded: 0 }

  function strongerStatus(current, incoming) {
    return (STATUS_STRENGTH[current] ?? 0) >= (STATUS_STRENGTH[incoming] ?? 0) ? current : incoming
  }

  /** Record ids must be path-safe storage keys, as every id-derived table key is. */
  const IMPORT_ID_RE = /^[A-Za-z0-9_-]{1,80}$/
  /** Owner prefixes the store itself can produce. */
  const IMPORT_OWNER_RE = /^(?:user|project:.+|session:.+)$/

  /** Keep only the probe fields the runtime understands; undefined if invalid. */
  function importProbe(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
    if (!PROBE_KINDS.includes(value.kind)) return undefined
    if (typeof value.target !== 'string' || value.target === '') return undefined
    const probe = { kind: value.kind, target: oneLine(value.target, 500) }
    if (typeof value.pattern === 'string' && value.pattern !== '') probe.pattern = oneLine(value.pattern, 500)
    if (value.ignoreCase === true) probe.ignoreCase = true
    return probe
  }

  /**
   * Import exported rows, keyed by `(owner, dedupeKey)`.
   *
   * The contract: a row whose `updatedAt` is newer wins; an older or equal row
   * is skipped (which makes a repeated import a no-op); and an import must
   * never *demote* local state — confidence keeps the higher value and status
   * keeps the stronger one, so importing an old export cannot un-verify or
   * un-retire anything here. Rows are rejected (never partially applied) when
   * their format, identity, or probe is wrong.
   *
   * Import is a write-class capability: the caller could already call `write`,
   * but a row also carries id, timestamps, and counters. Guards keep a bad row
   * from becoming permanent or crossing an owner boundary:
   *
   * - a timestamp that is missing or more than a day in the future is rejected,
   *   because such a row would always win the "newer wins" comparison;
   * - id, owner, and scope must agree with each other (and with the existing
   *   record when one is matched), so an import cannot reparent a record;
   * - the claim, evidence, probe, support, and check time are applied as one
   *   version: a newer claim never inherits an older probe's evidence.
   *
   * Confidence is still only lowered explicitly (`set_confidence` / `demote`).
   */
  async function importRows(rows) {
    const summary = { inserted: 0, updated: 0, skipped: 0, rejected: 0 }
    const now = Date.now()
    for (const row of rows ?? []) {
      if (row === null || typeof row !== 'object' || row.type !== 'memory' || row.format !== EXPORT_FORMAT) {
        summary.rejected += 1
        continue
      }
      const id = typeof row.id === 'string' ? row.id.trim() : ''
      const key = typeof row.dedupeKey === 'string' ? row.dedupeKey.trim() : ''
      const trigger = typeof row.trigger === 'string' ? oneLine(row.trigger, 500) : ''
      const claim = typeof row.claim === 'string' ? oneLine(row.claim, config.maxRecordChars) : ''
      if (!IMPORT_ID_RE.test(id) || key === '' || key.length > 200 || trigger.length < 3 || claim.length < 12) {
        summary.rejected += 1
        continue
      }
      const scope = SCOPES.includes(row.scope) ? row.scope : 'project'
      const kind = KINDS.includes(row.kind) ? row.kind : 'fact'
      const confidence = Math.min(1, Math.max(0, Number(row.confidence ?? 0) || 0))
      const status = STATUSES.includes(row.status) ? row.status : 'active'
      const updatedAt = Number(row.updatedAt)
      // Clock skew is allowed for a day; anything beyond that is either a bad
      // clock or a row designed to outrank every future import forever.
      if (!Number.isFinite(updatedAt) || updatedAt <= 0 || updatedAt > now + 86_400_000) {
        summary.rejected += 1
        continue
      }
      const createdAt = Math.min(Number(row.createdAt ?? updatedAt) || updatedAt, updatedAt)
      const sensitivity = row.sensitivity === 'private' || row.sensitivity === 'public' ? row.sensitivity : undefined
      const owner = typeof row.owner === 'string' && row.owner !== '' ? row.owner : ownerFor(scope, row.cwd, row.sessionId)
      if (!IMPORT_OWNER_RE.test(owner) || owner.length > 640) {
        summary.rejected += 1
        continue
      }
      // The owner prefix has to match the scope it claims; otherwise a row could
      // place a project record in another project's owner namespace.
      if (scope === 'user' ? owner !== 'user'
        : scope === 'project' ? !owner.startsWith('project:')
          : !owner.startsWith('session:')) {
        summary.rejected += 1
        continue
      }
      let probe
      if (row.probe !== undefined) {
        probe = importProbe(row.probe)
        if (probe === undefined) {
          summary.rejected += 1
          continue
        }
      }
      if (row.support !== undefined && (row.support === null || typeof row.support !== 'object' || Array.isArray(row.support))) {
        summary.rejected += 1
        continue
      }
      const lastCheckedAt = probe === undefined ? undefined : (Number(row.lastCheckedAt ?? 0) || undefined)

      const byId = memories.get(id)
      const byKeyId = byKey.get(key)
      // The same row matching two different local records is ambiguous; reject
      // rather than pick one.
      if (byId !== undefined && byKeyId !== undefined && byId.id !== byKeyId) {
        summary.rejected += 1
        continue
      }
      // A row's id and dedupeKey are one identity; an existing id under a
      // different key is a forged or damaged row, not an update.
      if (byId !== undefined && byId.key !== key) {
        summary.rejected += 1
        continue
      }
      const existing = byId ?? (byKeyId === undefined ? undefined : memories.get(byKeyId))
      if (existing !== undefined && ownerOf(existing) !== owner) {
        summary.rejected += 1
        continue
      }
      if (existing === undefined) {
        const record = {
          id,
          key,
          owner,
          scope,
          kind,
          trigger,
          claim,
          evidence: typeof row.evidence === 'string' ? oneLine(row.evidence, 900) : undefined,
          confidence,
          status,
          tags: Array.isArray(row.tags) ? row.tags.slice(0, 12) : [],
          probe,
          support: row.support,
          sensitivity,
          cwd: typeof row.cwd === 'string' ? row.cwd : undefined,
          sessionId: typeof row.sessionId === 'string' ? row.sessionId : undefined,
          // Keep the original provenance so export → import → export is byte
          // identical; the import itself is recorded in the event ring.
          origin: typeof row.origin === 'string' && row.origin !== '' ? row.origin : 'import',
          createdAt,
          updatedAt,
          lastUsedAt: Number(row.lastUsedAt ?? 0) || undefined,
          lastCheckedAt,
          uses: Number(row.uses ?? 0) || 0,
          wins: Number(row.wins ?? 0) || 0,
          harms: Number(row.harms ?? 0) || 0,
          supersedes: typeof row.supersedes === 'string' ? row.supersedes : undefined,
          supersededBy: typeof row.supersededBy === 'string' ? row.supersededBy : undefined,
          note: typeof row.note === 'string' ? oneLine(row.note, 380) : undefined,
        }
        for (const field of Object.keys(record)) if (record[field] === undefined) delete record[field]
        await memories.put(record.id, record)
        addIndex(record)
        summary.inserted += 1
        continue
      }

      if (updatedAt <= (existing.updatedAt ?? 0)) {
        summary.skipped += 1
        continue
      }

      // Claim + evidence + probe + support + check time are one version. Taking
      // the row's versions (including dropping fields the row does not carry)
      // is what keeps a newer claim from citing the old probe's evidence.
      const next = {
        ...existing,
        scope,
        kind,
        trigger,
        claim,
        evidence: typeof row.evidence === 'string' ? oneLine(row.evidence, 900) : undefined,
        probe,
        support: row.support,
        confidence: Math.max(existing.confidence ?? 0, confidence),
        status: strongerStatus(existing.status, status),
        sensitivity: sensitivity ?? existing.sensitivity,
        cwd: typeof row.cwd === 'string' ? row.cwd : existing.cwd,
        sessionId: typeof row.sessionId === 'string' ? row.sessionId : existing.sessionId,
        updatedAt,
        createdAt: Math.min(existing.createdAt ?? createdAt, createdAt),
        lastUsedAt: Math.max(existing.lastUsedAt ?? 0, Number(row.lastUsedAt ?? 0)) || undefined,
        lastCheckedAt,
        uses: Math.max(existing.uses ?? 0, Number(row.uses ?? 0) || 0),
        wins: Math.max(existing.wins ?? 0, Number(row.wins ?? 0) || 0),
        harms: Math.max(existing.harms ?? 0, Number(row.harms ?? 0) || 0),
        supersedes: existing.supersedes ?? row.supersedes,
        supersededBy: existing.supersededBy ?? row.supersededBy,
        note: typeof row.note === 'string' ? oneLine(row.note, 380) : existing.note,
        tags: Array.isArray(row.tags) ? row.tags.slice(0, 12) : existing.tags,
      }
      for (const field of Object.keys(next)) if (next[field] === undefined) delete next[field]
      dropIndex(existing)
      await memories.put(next.id, next)
      addIndex(next)
      summary.updated += 1
    }
    return summary
  }

  /**
   * Recent diagnostics visible to one reader.
   *
   * The event ring is global, but `status` is rendered into the calling
   * conversation. Two filters keep another session's content out of it:
   *
   * - only events for the calling session (or global events with no session);
   * - outside a private session, only events explicitly marked public. Legacy
   *   free-text events carry no audience, so they are treated as unknown and
   *   hidden rather than guessed safe.
   */
  function recentEvents(limit = 10, options = {}) {
    const sessionId = options.sessionId
    const includePrivate = options.visibility === 'private'
    const out = []
    for (const [, record] of events.entries()) {
      if (sessionId === undefined || sessionId === '') {
        if (record.sessionId !== undefined) continue
      } else if (record.sessionId !== undefined && record.sessionId !== sessionId) {
        continue
      }
      if (!includePrivate && record.private !== false) continue
      out.push(record)
    }
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
    setConfidence,
    forget,
    feedback,
    recordUses,
    markProbe,
    checkpoint,
    getCheckpoint,
    markCurated,
    isCurated,
    setSessionVisibility,
    sessionVisibility,
    applyBridgeScopes,
    hasWithheldCheckpoint,
    allCheckpoints,
    ledgerOf,
    bump,
    recordDistillAttempt,
    flushLedger,
    flushAll,
    event,
    list,
    get,
    probeCandidates,
    resolveId,
    stats,
    reviewGroups,
    exportRecords,
    exportRow,
    importRows,
    recentEvents,
    ledgerRows,
    rejectsOf,
    log,
    async close() {
      await flushAll()
    },
  }
}
