/**
 * `memory-probe` — background revalidation, no model calls.
 *
 * A memory that names a file or a substring can be invalidated by a change
 * elsewhere in the repository. This row sweeps those records on a timer, marks
 * the ones whose check no longer holds as `stale`, and revives a stale record
 * once its check passes again. `memory-core` also probes on the recall path;
 * this row is the low-priority hygiene loop for records nobody has asked for.
 */

import { nowMs, oneLine, runProbe } from './lib/util.js'

export const name = 'memory-probe'

/** The store is provided by `memory-core`; without it this row stays inactive. */
export const inject = ['memoryStore']

const DEFAULTS = {
  enabled: true,
  intervalMs: 900_000,
  initialDelayMs: 8_000,
  maxPerSweep: 40,
  graceMs: 600_000,
  maxBytes: 262_144,
}

function normalizeConfig(raw) {
  const input = raw !== null && typeof raw === 'object' ? raw : {}
  return {
    ...DEFAULTS,
    ...input,
    enabled: input.enabled !== false,
  }
}

export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig)
  const store = ctx.get('memoryStore')
  if (store === undefined) {
    ctx.logger?.warn?.('[memory] probe inactive: memoryStore missing')
    return
  }
  if (config.enabled === false) {
    ctx.logger?.info?.('[memory] probe disabled by config')
    return
  }

  let running = false

  async function sweep(reason) {
    if (running) return { checked: 0, failed: 0, revived: 0, ms: 0 }
    running = true
    const started = nowMs()
    let checked = 0
    let failed = 0
    let revived = 0
    try {
      const now = Date.now()
      const candidates = store.list({ limit: 5_000 })
        .filter(record => (record.status === 'active' || record.status === 'stale')
          && record.probe !== undefined
          && now - (record.updatedAt ?? 0) > config.graceMs)
        .slice(0, config.maxPerSweep)

      for (const record of candidates) {
        if (ctx.fiber?.assertActive !== undefined) {
          try {
            ctx.fiber.assertActive()
          } catch {
            break
          }
        }
        const result = runProbe(record.probe, record.cwd, config.maxBytes)
        checked += 1
        if (!result.ok) {
          failed += 1
          if (record.status !== 'stale') {
            await store.markProbe(record.id, false, result.detail)
            await store.event('probe-stale', `${record.id}: ${result.detail}`)
          }
        } else if (record.status === 'stale') {
          revived += 1
          await store.markProbe(record.id, true, result.detail)
          await store.event('probe-revived', `${record.id}: ${result.detail}`)
        }
      }
      const summary = { checked, failed, revived, ms: nowMs() - started }
      if (checked > 0) {
        store.log('info', `probe sweep (${reason}): ${checked} checked, ${failed} failed, ${revived} revived in ${summary.ms.toFixed(0)}ms`)
      }
      return summary
    } catch (error) {
      store.log('warn', `probe sweep failed: ${String(error?.message ?? error)}`)
      return { checked, failed, revived, ms: nowMs() - started }
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

  ctx.logger?.info?.(`[memory] probe active every ${Math.round(config.intervalMs / 1000)}s`)
}
