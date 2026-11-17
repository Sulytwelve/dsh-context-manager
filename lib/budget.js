/**
 * Distillation budget recovery.
 *
 * The per-day call counter is a process value, but the ledger already records
 * every distillation call per session. Rebuilding the day's usage from those
 * rows at plugin start means a restart no longer resets the budget.
 *
 * The ledger has no per-day breakdown, so a session that spans midnight counts
 * against the day its row was last updated. That is an approximation; the
 * alternative — losing the budget entirely on restart — is worse.
 */

/**
 * Sum distillation calls and tokens for rows last updated on the given day.
 *
 * @param rows - `store.ledgerRows()` output.
 * @param day - UTC calendar day (`YYYY-MM-DD`), matching the counter's own clock.
 * @returns `{ calls, bySession: Map<string, number>, inputTokens, outputTokens }`.
 */
export function summarizeDistillLedger(rows, day) {
  const bySession = new Map()
  let calls = 0
  let inputTokens = 0
  let outputTokens = 0
  for (const row of rows ?? []) {
    const updated = Number(row?.updatedAt ?? 0)
    if (!Number.isFinite(updated) || updated <= 0) continue
    const rowDay = new Date(updated).toISOString().slice(0, 10)
    if (rowDay !== day) continue
    const sessionCalls = Number(row?.distillCalls ?? 0)
    if (!Number.isFinite(sessionCalls) || sessionCalls <= 0) continue
    calls += sessionCalls
    bySession.set(String(row.sessionId), (bySession.get(String(row.sessionId)) ?? 0) + sessionCalls)
    inputTokens += Number(row?.distillInputTokens ?? 0) || 0
    outputTokens += Number(row?.distillOutputTokens ?? 0) || 0
  }
  return { calls, bySession, inputTokens, outputTokens }
}
