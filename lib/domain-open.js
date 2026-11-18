/**
 * Open the storage domain across a hot reload.
 *
 * The domain facility allows exactly one live handle per domain name
 * (`already-open`). A config edit reloads the row: the new instance applies
 * while the previous fiber is still tearing down, so an immediate `open()` can
 * lose the race to the old handle and the row comes up without its tool.
 *
 * Two things make that window safe:
 *
 * - the row's disposer now *awaits* `domain.close()`, so the old handle is
 *   released as soon as teardown runs;
 * - this helper retries only the `already-open` rejection, for a bounded time,
 *   and lets every other failure through unchanged. A permanent failure is
 *   reported by the caller as a degraded row, not retried forever.
 */

/**
 * @param facility - `ctx.storageDomain`.
 * @param spec - the domain spec to open.
 * @param options - `timeoutMs` (default 2000) and `delayMs` (default 25).
 * @returns the opened domain.
 * @throws the last error once the deadline passes or the error is not retryable.
 */
export async function openDomainWithRetry(facility, spec, options = {}) {
  const timeoutMs = options.timeoutMs ?? 2_000
  const delayMs = options.delayMs ?? 25
  const started = Date.now()
  for (;;) {
    try {
      return await facility.open(spec)
    } catch (error) {
      const retryable = /already[- ]open/i.test(String(error?.message ?? ''))
      if (!retryable || Date.now() - started >= timeoutMs) throw error
      await new Promise(resolve => setTimeout(resolve, delayMs))
    }
  }
}
