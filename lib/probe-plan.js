/**
 * Probe scheduling: which records are due for revalidation, and in what order.
 *
 * The check time is `lastCheckedAt`, not `updatedAt`. Conflating the two made a
 * record written and recalled in the same millisecond look freshly checked, and
 * it let a set of healthy records keep the sweep's attention forever because a
 * passing check never advanced anything the ordering looked at.
 */

/** Whether one record's declared check is due. A zero TTL means "every time". */
export function probeDue(record, now, ttlMs) {
  if (record === null || record === undefined) return false
  if (record.probe === null || record.probe === undefined) return false
  if (record.lastCheckedAt === null || record.lastCheckedAt === undefined) return true
  return now - record.lastCheckedAt >= ttlMs
}

/**
 * Pick the records a sweep should check now.
 *
 * Least-recently-checked first, so a record that keeps passing cannot starve a
 * record behind it. Records that never ran a probe sort before every checked
 * one.
 *
 * @param records - candidate records (any order).
 * @param options - `now`, `recheckMs` minimum age, and `max` batch size.
 * @returns at most `max` records, in check order.
 */
export function selectProbeCandidates(records, { now, recheckMs, max }) {
  const eligible = []
  for (const record of records ?? []) {
    const status = record?.status
    if (status !== 'active' && status !== 'stale') continue
    if (!probeDue(record, now, recheckMs)) continue
    eligible.push(record)
  }
  eligible.sort((left, right) => {
    const leftAt = left.lastCheckedAt ?? 0
    const rightAt = right.lastCheckedAt ?? 0
    if (leftAt !== rightAt) return leftAt - rightAt
    return (left.updatedAt ?? 0) - (right.updatedAt ?? 0)
  })
  return eligible.slice(0, Math.max(0, max))
}
