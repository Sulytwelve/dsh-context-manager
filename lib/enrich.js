/**
 * Failure-driven semantic enrichment: the agent writes its own retrieval
 * vocabulary after a recall actually missed.
 *
 * When a recall produced zero hits against non-empty candidates, the turn-end
 * listener (in the distill row, off the hot path) spends one bounded model
 * call: the model sees the exact wording that missed plus a bounded candidate
 * pool of rejected records, and writes back retrieval aliases for the records
 * that actually match plus — when it is confident several forms always mean the
 * same thing — shared synonym groups into the learned `concepts` table. The
 * same wording family then matches forever, on the recall path that never calls
 * a model.
 *
 * No vocabulary is predefined here. The dictionary is shared by every
 * conversation of this bot and is only ever written by the agent, which is why
 * a fresh install still misses its first reworded query — once, not repeatedly.
 */

import { evaluateEnrichBudget, reserveEnrichBudget } from './budget.js'
import { normalizeForm } from './lexicon.js'
import { clip, estimateTokens, nowMs, oneLine } from './util.js'

/** The rejection reasons that mark a semantic near-miss worth learning from. */
const MISSED = new Set(['no-term-overlap', 'below-threshold'])

/** Default prompt candidate count and token ceiling; both are configurable. */
export const ENRICH_MAX_CANDIDATES = 8
export const ENRICH_MAX_PROMPT_TOKENS = 1_200

/**
 * The model selection to use for an off-hot-path call, resolved the same way
 * the distillation call resolves it: the session's current model, falling
 * back to the host default.
 *
 * @returns `{ provider, model, reasoningEffort? }` or undefined.
 */
export function modelSelectionOf(ctx, sessionId) {
  let selection
  try {
    const agents = ctx.get('agents')
    const agent = agents?.get(sessionId)
    selection = agent?.model?.current()
  } catch {
    selection = undefined
  }
  if (selection === undefined) {
    try {
      selection = ctx.get('agentDefaultModel')?.currentSelection()
    } catch {
      selection = undefined
    }
  }
  if (selection?.provider === undefined || selection?.model === undefined) return undefined
  return selection
}

/**
 * Build the bounded enrichment prompt: the failed question plus the candidate
 * records, one of which may be the one that should have answered.
 *
 * @param maxRecords - how many records the model may actually alias in one
 *   answer (the prompt may list more candidates than that).
 */
export function buildEnrichPrompt(query, records, maxRecords = 2) {
  const lines = (records ?? []).map(record =>
    `- id: ${record.id} | trigger: ${clip(record.trigger, 160)} | claim: ${clip(record.claim, 320)}`)
    .join('\n')
  return `A memory recall just failed: the user's question should have been answered by one of the candidate records below, but no wording matched.

1. Choose at most ${maxRecords} candidate(s) whose meaning the question actually names. For each chosen record, write up to 6 retrieval aliases — other short wordings a user might use for the same situation, in the language(s) the user mixes, including product names and colloquial forms. An alias is a keyword phrase of at most 60 characters, never a sentence, and never a verbatim restatement of the record's own trigger. Do not write aliases for unrelated candidates.
2. If several forms always mean the same thing (a product and its common name in another language, for example), also return up to 2 shared synonym groups; every record benefits from those. Each form is one Latin word or one CJK phrase.

Return JSON only:
{"records":[{"id":"<exact record id>","aliases":["..."]}],"links":[["form1","form2"]]}
Empty arrays are valid answers when no candidate applies.

USER QUESTION: ${clip(query, 400) || '(empty)'}
CANDIDATES:
${lines}`
}

/**
 * Parse the model's answer, ignoring anything malformed.
 *
 * Only ids we actually sent are applied (the caller checks), aliases are
 * bounded strings, links are small valid-form groups, and at most `maxRecords`
 * records are accepted.
 */
export function parseEnrichResult(text, maxRecords = 4) {
  const limit = Math.max(1, Number(maxRecords) || 1)
  const value = String(text ?? '')
  const start = value.indexOf('{')
  const end = value.lastIndexOf('}')
  if (start < 0 || end <= start) return { records: [], links: [] }
  let parsed
  try {
    parsed = JSON.parse(value.slice(start, end + 1))
  } catch {
    return { records: [], links: [] }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return { records: [], links: [] }
  const records = []
  for (const item of Array.isArray(parsed.records) ? parsed.records : []) {
    if (item === null || typeof item !== 'object') continue
    const id = typeof item.id === 'string' ? item.id.trim() : ''
    const aliases = (Array.isArray(item.aliases) ? item.aliases : [])
      .filter(alias => typeof alias === 'string')
      .map(alias => oneLine(alias, 60))
      .filter(alias => alias.length >= 2)
      .slice(0, 6)
    if (id === '' || aliases.length === 0) continue
    records.push({ id, aliases })
  }
  const links = []
  for (const group of Array.isArray(parsed.links) ? parsed.links : []) {
    const forms = (Array.isArray(group) ? group : [])
      .filter(form => typeof form === 'string')
      .map(form => oneLine(form, 60))
      .filter(form => form.length >= 2 && normalizeForm(form) !== undefined)
      .slice(0, 8)
    if (forms.length >= 2) links.push(forms)
  }
  return { records: records.slice(0, limit), links: links.slice(0, 2) }
}

/**
 * Run one enrichment pass for this turn's last automatic recall, when that
 * recall failed and there is something to learn.
 *
 * Everything is bounded: one call at most, its own persisted budget and
 * cooldown, a configurable candidate window and prompt-token ceiling, at most
 * `enrichMaxRecords` records actually aliased, and a per-record re-enrich
 * cooldown (`aliasAt`) so a stubborn miss does not re-spend tokens every turn.
 *
 * @returns `{ enriched, linked, candidates? }` counts, or a zero state when
 *   nothing ran.
 */
export async function enrichAfterFailure({ ctx, store, config, sessionId, startedAt, budgets, isSubagent = false }) {
  const llm = config.llm
  if (llm?.enabled !== true || llm?.enrich === false) return { enriched: 0, linked: 0, reason: 'disabled' }
  // One-shot: the same turn-end event must not spend a second call on the same
  // miss, and a later turn without an automatic recall must not reuse it.
  const rejects = store.takeAutoRejects(sessionId)
  if (rejects === undefined) return { enriched: 0, linked: 0, reason: 'no-recall' }
  if (rejects.at < startedAt) return { enriched: 0, linked: 0, reason: 'stale' }
  if ((rejects.hits ?? 0) > 0) return { enriched: 0, linked: 0, reason: 'hits' }
  const query = String(rejects.query ?? '')
  if (query.trim() === '') return { enriched: 0, linked: 0, reason: 'no-query' }
  const missed = (rejects.enrichCandidates ?? rejects.top ?? []).filter(entry => MISSED.has(entry.reason))
  if (missed.length === 0) return { enriched: 0, linked: 0, reason: 'no-miss' }

  const now = Date.now()
  const maxCandidates = Math.max(1, Number(llm.enrichMaxCandidates ?? ENRICH_MAX_CANDIDATES))
  const maxRecords = Math.max(1, Number(llm.enrichMaxRecords ?? 2))
  const promptCap = Math.max(200, Number(llm.enrichMaxPromptTokens ?? ENRICH_MAX_PROMPT_TOKENS))
  const enrichTtlMs = Number(llm.enrichTtlMs ?? 604_800_000)
  const candidates = []
  for (const entry of missed) {
    if (candidates.length >= maxCandidates) break
    const record = store.get(entry.id)
    if (record === undefined) continue
    if ((record.aliases?.length ?? 0) >= 4) continue
    if (record.aliasAt !== undefined && now - record.aliasAt < enrichTtlMs) continue
    candidates.push(record)
  }
  if (candidates.length === 0) return { enriched: 0, linked: 0, reason: 'no-targets' }

  const verdict = evaluateEnrichBudget({ budgets, config, sessionId, isSubagent, now })
  if (!verdict.allowed) {
    store.log('debug', `enrich skipped: ${verdict.reason}`)
    return { enriched: 0, linked: 0, reason: verdict.reason }
  }
  const llmService = ctx.get('llm')
  if (llmService === undefined) return { enriched: 0, linked: 0, reason: 'no-llm' }
  const selection = modelSelectionOf(ctx, sessionId)
  if (selection === undefined) return { enriched: 0, linked: 0, reason: 'no-model' }

  // Persist the reservation before the request: a failed stream still
  // consumed the attempt, exactly like a distillation call.
  const attemptedAt = Date.now()
  reserveEnrichBudget(budgets, sessionId, attemptedAt)
  try {
    await store.recordEnrichAttempt(sessionId, attemptedAt)
  } catch (error) {
    store.log('warn', `enrich reservation could not be persisted: ${String(error?.message ?? error)}`)
  }

  // The candidate list and the prompt share one token ceiling. Shrink the
  // list from the tail until the whole prompt fits; the head is ordered by
  // relevance / rotation, so the most plausible records survive.
  let promptRecords = candidates.slice()
  let prompt = buildEnrichPrompt(query, promptRecords, maxRecords)
  while (estimateTokens(prompt) > promptCap && promptRecords.length > 1) {
    promptRecords = promptRecords.slice(0, -1)
    prompt = buildEnrichPrompt(query, promptRecords, maxRecords)
  }

  const started = nowMs()
  const inputEstimate = estimateTokens(prompt)
  let text = ''
  let usage
  let failure
  try {
    const options = {
      provider: selection.provider,
      model: selection.model,
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
      maxTokens: Math.max(200, Number(llm.enrichMaxTokens ?? 500)),
      temperature: 0,
      sessionId,
    }
    for await (const chunk of llmService.stream(options)) {
      if (chunk.type === 'text-delta') text += chunk.text
      else if (chunk.type === 'usage') usage = chunk.usage
      else if (chunk.type === 'finish' && chunk.reason?.kind === 'error') failure = chunk.reason.failure
    }
  } catch (error) {
    store.log('warn', `enrich call failed: ${String(error?.message ?? error)}`)
    return { enriched: 0, linked: 0, reason: 'stream-error' }
  }

  const elapsed = nowMs() - started
  const inputTokens = usage?.inputTokens ?? inputEstimate
  const outputTokens = usage?.outputTokens ?? estimateTokens(text)
  store.bump(sessionId, {
    enrichCalls: 1,
    enrichInputTokens: inputTokens,
    enrichOutputTokens: outputTokens,
    enrichMs: elapsed,
  })
  await store.flushLedger(sessionId)

  if (failure !== undefined) {
    store.log('warn', `enrich model failure: ${failure.message}`)
    return { enriched: 0, linked: 0, reason: 'model-failure' }
  }

  const { records, links } = parseEnrichResult(text, maxRecords)
  const sentIds = new Set(promptRecords.map(record => record.id))
  let enriched = 0
  for (const item of records) {
    if (!sentIds.has(item.id)) continue
    try {
      const before = store.get(item.id)?.aliases?.length ?? 0
      const next = await store.updateAliases(item.id, item.aliases)
      if (next !== undefined && (next.aliases?.length ?? 0) > before) enriched += 1
    } catch (error) {
      store.log('debug', `enrich alias write failed: ${String(error?.message ?? error)}`)
    }
  }
  let linked = 0
  for (const forms of links) {
    try {
      await store.linkForms({ forms, origin: 'enrich' })
      linked += 1
    } catch {
      // An invalid group (single form, bad shape) is skipped, not fatal.
    }
  }
  await store.event(
    'enrich',
    `${enriched} record(s) aliased, ${linked} group(s) linked from a missed recall: ${clip(query, 80)}`,
    sessionId,
  )
  return { enriched, linked, candidates: promptRecords.length }
}
