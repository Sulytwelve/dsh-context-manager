/**
 * Host-contract checks for the three rows.
 *
 * Interface coupling is a property of this plugin category: injection, storage,
 * and the step hook all come from the host. What can be improved is the failure
 * mode — when DSH changes a contract, the row should say so once, clearly, and
 * stay out of the way, instead of throwing from a registration site and looking
 * like a plugin bug.
 */

/**
 * Verify the host surface a row needs.
 *
 * @param ctx - plugin context.
 * @param row - row name used in the message (`memory-core` etc.).
 * @param required - label → whether that capability is present.
 * @returns `true` when the row may continue; `false` after logging one line.
 */
export function checkContract(ctx, row, required) {
  const missing = Object.entries(required ?? {})
    .filter(([, present]) => present !== true)
    .map(([label]) => label)
  if (missing.length === 0) return true
  const message = `[context-manager] DSH version incompatible, ${row} degraded (missing: ${missing.join(', ')})`
  try {
    if (typeof ctx?.logger?.error === 'function') ctx.logger.error(message)
    else if (typeof ctx?.logger?.warn === 'function') ctx.logger.warn(message)
    else console.warn(message)
  } catch {
    // logging is best-effort; the important part is not registering against a
    // surface that does not exist
  }
  return false
}
