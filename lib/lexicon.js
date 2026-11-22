/**
 * Learned-concept matching machinery for semantic retrieval.
 *
 * No vocabulary is built into this module. Every synonym group is written at
 * runtime by the agent — through `memory{op:"link"}` or by the failure-driven
 * alias enrichment — and stored in the `concepts` table of the memory domain.
 * This file holds only the matching rules: how a surface form (a CJK phrase or
 * a Latin word) maps to a learned concept id.
 *
 * Latin word forms are folded with a small morphological stemmer so an
 * inflected query still hits the learned base form (`backups` → `backup`,
 * `restarting` → `restart`). That is generic morphology, not semantic
 * knowledge: nothing here decides which words mean the same thing.
 */

/**
 * Fold one lowercase Latin token to a shared base form.
 *
 * Deliberately crude and consistency-first: a form and its inflections must
 * fold to the same token on both the query and the record side. Irregular
 * verbs and other linguistic niceties are out of scope — an unmatched word
 * simply stays itself, which is always consistent.
 */
export function stemLatin(word) {
  const value = String(word ?? '')
  if (value.length >= 5 && value.endsWith('ies')) return `${value.slice(0, -3)}y`
  const undouble = stem => (/(.)\1$/.test(stem) && !/(?:ss|ll|ff|zz)$/.test(stem) ? stem.slice(0, -1) : stem)
  if (value.length >= 6 && value.endsWith('ing')) {
    const stem = value.slice(0, -3)
    if (stem.length >= 3) return undouble(stem)
  }
  if (value.length >= 5 && value.endsWith('ed')) {
    const stem = value.slice(0, -2)
    if (stem.length >= 3) return undouble(stem)
  }
  if (value.length >= 5 && value.endsWith('es')) {
    // Only the sibilant plural folds: boxes→box, processes→process,
    // matches→match. "notes" must fall through to the plain-s rule so it
    // becomes "note", not "not".
    const stem = value.slice(0, -2)
    if (stem.length >= 3
      && (stem.endsWith('s') || stem.endsWith('x') || stem.endsWith('z')
        || stem.endsWith('ch') || stem.endsWith('sh'))) return stem
  }
  // Words whose final s is part of the singular must not fold: alias, status,
  // basis, canvas. The price is that a genuine -as plural ("ideas") also
  // stays whole — consistency outranks linguistics here.
  if (value.length >= 4 && value.endsWith('s')
    && !value.endsWith('ss') && !value.endsWith('us')
    && !value.endsWith('is') && !value.endsWith('as')) {
    const stem = value.slice(0, -1)
    if (stem.length >= 3) return stem
  }
  return value
}

/**
 * Normalize one agent-supplied surface form for storage, or reject it.
 *
 * A valid form is 2–60 characters: either a phrase containing non-ASCII text
 * (matched as a substring — CJK text carries no spaces) or a single Latin
 * word `[a-z0-9_]+`. Forms are stored lowercase and unstemmed; the stemmer
 * runs at match time on both sides, so the stored form stays human-readable.
 *
 * @returns the normalized form, or undefined when the form is unusable.
 */
export function normalizeForm(form) {
  const value = String(form ?? '').trim().toLowerCase()
  if (value.length < 2 || value.length > 60) return undefined
  if (/[^\u0000-\u007f]/.test(value)) return value
  return /^[a-z0-9_]+$/.test(value) ? value : undefined
}

/**
 * Build the match index over learned concept groups.
 *
 * @param groups - rows of the `concepts` table (`{ id, forms }`).
 * @returns `{ cjk: [form, termId][] , latin: Map<stemmedWord, Set<termId>> }`
 *   where `termId` is the index-ready retrieval token (`#` + group id, a
 *   prefix `tokenize` can never produce). On a conflicting form claimed by
 *   two groups (only possible through hand-edited storage; `linkForms`
 *   merges intersecting groups) the first group wins.
 */
export function buildConceptIndex(groups) {
  const cjk = []
  const latin = new Map()
  for (const group of groups ?? []) {
    const id = String(group?.id ?? '')
    if (id === '') continue
    const termId = `#${id}`
    for (const raw of group.forms ?? []) {
      const value = normalizeForm(raw)
      if (value === undefined) continue
      if (/[^\u0000-\u007f]/.test(value)) {
        if (!cjk.some(([existing]) => existing === value)) cjk.push([value, termId])
        continue
      }
      const key = stemLatin(value)
      if (!latin.has(key)) latin.set(key, new Set([termId]))
    }
  }
  return { cjk, latin }
}

/** Whether a concept index holds nothing to match against. */
export function emptyConceptIndex() {
  return { cjk: [], latin: new Map() }
}

/**
 * The learned concept ids a text carries.
 *
 * @param text - any query or record text, already lowercased by the caller or
 *   not — this function lowercases.
 * @param index - `buildConceptIndex` output.
 * @returns index-ready concept terms (`#<group id>`), deduplicated.
 */
export function matchConcepts(text, index) {
  if (index === undefined) return []
  const value = String(text ?? '').toLowerCase()
  if (value === '') return []
  const found = new Set()
  for (const [form, termId] of index.cjk) {
    if (value.includes(form)) found.add(termId)
  }
  if (index.latin.size > 0) {
    for (const match of value.matchAll(/[a-z0-9_]+/g)) {
      const ids = index.latin.get(stemLatin(match[0]))
      if (ids !== undefined) for (const id of ids) found.add(id)
    }
  }
  return [...found]
}
