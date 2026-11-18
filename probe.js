/**
 * `memory-probe` — background revalidation, no model calls.
 *
 * A memory that names a file or a substring can be invalidated by a change
 * elsewhere in the repository. This row sweeps those records on a timer, marks
 * the ones whose check no longer holds as `stale`, and revives a stale record
 * once its check passes again. `memory-core` also probes on the recall path;
 * this row is the low-priority hygiene loop for records nobody has asked for.
 */

import { checkContract } from './lib/contract.js'
import { isPrivateRecord } from './lib/store.js'
import { nowMs, oneLine, runProbe } from './lib/util.js'

export const name = 'memory-probe'

/** The store is provided by `memory-core`; without it this row stays inactive. */
export const inject = ['memoryStore']

const DEFAULTS = {
  enabled: true,
  intervalMs: 900_000,
  initialDelayMs: 8_000,
  maxPerSweep: 40,
  recheckMs: 3_600_000,
  maxBytes: 262_144,
}

function normalizeConfig(raw) {
  const input = raw !== null && typeof raw === 'object' ? raw : {}
  return {
    ...DEFAULTS,
    ...input,
    enabled: input.enabled !== false,
    // `graceMs` was the old name for the minimum age between checks.
    recheckMs: Number(input.recheckMs ?? input.graceMs ?? DEFAULTS.recheckMs),
  }
}

export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig)
  const store = ctx.get('memoryStore')
  if (store === undefined) {
    ctx.logger?.warn?.('[context-manager] probe inactive: memoryStore missing')
    return
  }
  if (config.enabled === false) {
    ctx.logger?.info?.('[context-manager] probe disabled by config')
    return
  }
  const compatible = checkContract(ctx, 'memory-probe', {
    'ctx.get': typeof ctx.get === 'function',
    'ctx.effect': typeof ctx.effect === 'function',
  })
  if (!compatible) return

  let running = false

  async function sweep(reason) {
    if (running) return { checked: 0, failed: 0, revived: 0, inconclusive: 0, ms: 0 }
    running = true
    const started = nowMs()
    let checked = 0
    let failed = 0
    let revived = 0
    let inconclusive = 0
    try {
      const now = Date.now()
      // Filter by due state across the whole store, then take the batch. The
      // previous form took the 5,000 most recently updated records first, so an
      // older overdue record could never be swept.
      const candidates = store.probeCandidates({
        now,
        recheckMs: config.recheckMs,
        max: config.maxPerSweep,
      })

      for (const record of candidates) {
        if (ctx.fiber?.assertActive !== undefined) {
          try {
            ctx.fiber.assertActive()
          } catch {
            break
          }
        }
        const result = await runProbe(record.probe, record.cwd, config.maxBytes)
        checked += 1
        // A probe verdict is valid only for the probe version that was read;
        // markProbe ignores a result whose target changed while it ran.
        const audience = {
          private: isPrivateRecord(record) || record.sessionId === undefined,
        }
        if (result.status === 'fail') {
          failed += 1
          const wasActive = record.status !== 'stale'
          await store.markProbe(record.id, 'fail', result.detail, record.probe)
          // Already-stale records still advance their check clock (above), but
          // only an actual transition emits an event.
          if (wasActive) {
            await store.event('probe-stale', `${record.id}: ${result.detail}`, record.sessionId, audience)
          }
        } else if (result.status === 'inconclusive') {
          // The check could not see the evidence (too large, unreadable, or
          // outside the scanned window). Record the attempt, change nothing.
          inconclusive += 1
          await store.markProbe(record.id, 'inconclusive', result.detail, record.probe)
        } else if (record.status === 'stale') {
          revived += 1
          await store.markProbe(record.id, 'pass', result.detail, record.probe)
          await store.event('probe-revived', `${record.id}: ${result.detail}`, record.sessionId, audience)
        } else {
          await store.markProbe(record.id, 'pass', result.detail, record.probe)
        }
      }
      const summary = { checked, failed, revived, inconclusive, ms: nowMs() - started }
      if (checked > 0) {
        store.log('info', `probe sweep (${reason}): ${checked} checked, ${failed} failed, ${inconclusive} inconclusive, ${revived} revived in ${summary.ms.toFixed(0)}ms`)
      }
      return summary
    } catch (error) {
      store.log('warn', `probe sweep failed: ${String(error?.message ?? error)}`)
      return { checked, failed, revived, inconclusive, ms: nowMs() - started }
    } finally {
      running = false
    }
  }

  const interval = setInterval(() => { void sweep('interval') }, config.intervalMs)
  interval.unref?.()
  const initial = setTimeout(() => { void sweep('boot') }, config.initialDelayMs)
  initial.unref?.()

  ctx.effect(() => () => {
    clearInterval(interval)
    clearTimeout(initial)
  })

  // Expose the sweep for the status surface and for tests.
  if (typeof ctx.provide === 'function') {
    ctx.provide('memoryProbe', {
      sweep: () => sweep('manual'),
      config,
    })
  }

  ctx.logger?.info?.(`[context-manager] probe active every ${Math.round(config.intervalMs / 1000)}s`)
}
