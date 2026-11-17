/**
 * Checkpoint precedence rules, as a pure decision.
 *
 * `memory-distill` writes a checkpoint at every completed turn unless doing so
 * would replace better state. Two cases must skip it:
 *
 * - this session wrote a checkpoint through the tool (curated wins);
 * - another session wrote one with a next action less than `freshMs` ago.
 *
 * The second case used to be silent, which made a concurrent session look like
 * it had lost its state. It now produces an event and the caller records it.
 */

/**
 * Decide whether the turn-end heuristic may write the checkpoint.
 *
 * @param existing - the stored checkpoint for this directory, if any.
 * @param currentSessionId - the session considering a write.
 * @param now - wall clock in milliseconds.
 * @param options - `curated` (this session wrote one) and `freshMs`.
 * @returns `{ action: 'write' | 'skip', reason, ageMs? }`.
 */
export function evaluateCheckpointGuard(existing, currentSessionId, now, options = {}) {
  const freshMs = options.freshMs ?? 21_600_000
  if (options.curated === true) return { action: 'skip', reason: 'curated-by-this-session' }
  if (existing === undefined || existing === null) return { action: 'write', reason: 'no-checkpoint' }
  const ageMs = Math.max(0, now - (existing.updatedAt ?? 0))
  const otherSession = existing.sessionId !== undefined && existing.sessionId !== currentSessionId
  if (otherSession && typeof existing.nextAction === 'string' && existing.nextAction !== '' && ageMs < freshMs) {
    return { action: 'skip', reason: 'other-session-fresh', ageMs }
  }
  return { action: 'write', reason: otherSession ? 'other-session-stale' : 'same-session', ageMs }
}
