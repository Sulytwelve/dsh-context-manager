/**
 * Distillation budget recovery and evaluation.
 *
 * A turn may spend at most one model call, governed by a per-session cooldown,
 * a per-session cap, and a daily cap. An attempt is reserved and persisted in
 * the ledger *before* the request, so a crash or a failed stream cannot refund
 * it. Recovery reads those per-day counters back on start; deriving the day
 * from `updatedAt` misfiled calls around UTC midnight and lost attempts.
 */

/** UTC calendar day of an instant, matching the persisted counter. */
export function dayOf(instant = Date.now()) {
  return new Date(instant).toISOString().slice(0, 10)
}

/**
 * Read the persisted per-day attempts back into process state.
 *
 * @param rows - `store.ledgerRows()` output.
 * @param day - UTC calendar day (`YYYY-MM-DD`).
 * @returns `{ calls, bySession: Map, lastAt: Map, inputTokens, outputTokens }`.
 */
export function summarizeDistillLedger(rows, day) {
  const bySession = new Map()
  const lastAt = new Map()
  let calls = 0
  let inputTokens = 0
  let outputTokens = 0
  for (const row of rows ?? []) {
    const sessionId = String(row?.sessionId ?? '')
    if (sessionId === '') continue
    const savedDay = typeof row?.distillDay === 'string' ? row.distillDay : undefined
    if (savedDay === day) {
      const sessionCalls = Number(row?.distillCallsToday ?? 0) || 0
      if (sessionCalls > 0) {
        calls += sessionCalls
        bySession.set(sessionId, sessionCalls)
      }
      inputTokens += Number(row?.distillInputTokens ?? 0) || 0
      outputTokens += Number(row?.distillOutputTokens ?? 0) || 0
    }
    const last = Number(row?.lastDistillAt ?? 0)
    if (Number.isFinite(last) && last > 0) lastAt.set(sessionId, last)
  }
  return { calls, bySession, lastAt, inputTokens, outputTokens }
}

/**
 * Whether one turn may reserve a distillation call now.
 *
 * @returns `{ allowed: boolean, reason?: string }`.
 */
export function evaluateDistillBudget({ budgets, config, sessionId, isSubagent, now = Date.now() }) {
  const llm = config.llm
  if (isSubagent && !config.includeSubagents) return { allowed: false, reason: 'subagent' }
  const day = dayOf(now)
  if (budgets.day !== day) {
    budgets.day = day
    budgets.calls = 0
    budgets.bySession.clear()
  }
  const cooldownMs = Number(llm.minIntervalMs ?? 0)
  const last = budgets.lastAt?.get(sessionId) ?? 0
  if (cooldownMs > 0 && now - last < cooldownMs) return { allowed: false, reason: 'cooldown' }
  if (budgets.calls >= Number(llm.maxCallsPerDay ?? 0)) return { allowed: false, reason: 'daily-cap' }
  if ((budgets.bySession.get(sessionId) ?? 0) >= Number(llm.maxCallsPerSession ?? 0)) {
    return { allowed: false, reason: 'session-cap' }
  }
  return { allowed: true }
}

/** Reserve one attempt in process state; the caller persists it before the request. */
export function reserveDistillBudget(budgets, sessionId, now = Date.now()) {
  const day = dayOf(now)
  if (budgets.day !== day) {
    budgets.day = day
    budgets.calls = 0
    budgets.bySession.clear()
  }
  budgets.calls += 1
  budgets.bySession.set(sessionId, (budgets.bySession.get(sessionId) ?? 0) + 1)
  budgets.lastAt?.set(sessionId, now)
}

// ------------------------------------------------------- enrichment budget --

/**
 * Read the persisted per-day enrichment attempts back into process state.
 *
 * Same scheme as the distillation recovery, over the enrich-prefixed ledger
 * fields.
 *
 * @returns `{ calls, bySession: Map, lastAt: Map }`.
 */
export function summarizeEnrichLedger(rows, day) {
  const bySession = new Map()
  const lastAt = new Map()
  let calls = 0
  for (const row of rows ?? []) {
    const sessionId = String(row?.sessionId ?? '')
    if (sessionId === '') continue
    if (typeof row?.enrichDay === 'string' && row.enrichDay === day) {
      const sessionCalls = Number(row?.enrichCallsToday ?? 0) || 0
      if (sessionCalls > 0) {
        calls += sessionCalls
        bySession.set(sessionId, sessionCalls)
      }
    }
    const last = Number(row?.lastEnrichAt ?? 0)
    if (Number.isFinite(last) && last > 0) lastAt.set(sessionId, last)
  }
  return { calls, bySession, lastAt }
}

/**
 * Whether one failed recall may spend an alias-enrichment call now.
 *
 * Enrichment is failure-driven, so its caps are separate from (and tighter
 * than) the distillation caps: it only ever fires after a recall produced
 * zero hits against non-empty candidates, and its cooldown is short.
 *
 * @returns `{ allowed: boolean, reason?: string }`.
 */
export function evaluateEnrichBudget({ budgets, config, sessionId, isSubagent, now = Date.now() }) {
  const llm = config.llm
  if (isSubagent && !config.includeSubagents) return { allowed: false, reason: 'subagent' }
  const day = dayOf(now)
  if (budgets.enrichDay !== day) {
    budgets.enrichDay = day
    budgets.enrichCalls = 0
    budgets.enrichBySession.clear()
  }
  const cooldownMs = Number(llm.enrichMinIntervalMs ?? 0)
  const last = budgets.enrichLastAt?.get(sessionId) ?? 0
  if (cooldownMs > 0 && now - last < cooldownMs) return { allowed: false, reason: 'cooldown' }
  if (budgets.enrichCalls >= Number(llm.enrichMaxPerDay ?? 0)) return { allowed: false, reason: 'daily-cap' }
  if ((budgets.enrichBySession.get(sessionId) ?? 0) >= Number(llm.enrichMaxPerSession ?? 0)) {
    return { allowed: false, reason: 'session-cap' }
  }
  return { allowed: true }
}

/** Reserve one enrichment attempt; the caller persists it before the request. */
export function reserveEnrichBudget(budgets, sessionId, now = Date.now()) {
  const day = dayOf(now)
  if (budgets.enrichDay !== day) {
    budgets.enrichDay = day
    budgets.enrichCalls = 0
    budgets.enrichBySession.clear()
  }
  budgets.enrichCalls += 1
  budgets.enrichBySession.set(sessionId, (budgets.enrichBySession.get(sessionId) ?? 0) + 1)
  budgets.enrichLastAt?.set(sessionId, now)
}
