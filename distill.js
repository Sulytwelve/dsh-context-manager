/**
 * `memory-distill` — the optional, slow path.
 *
 * On turn end it deterministically records a durable task checkpoint (no model
 * call), scores the turn for transferable value, and only when that score
 * crosses a threshold spends one bounded model call to distill 0–2 memory
 * records. The call runs detached after the turn has already committed, so the
 * user's next turn never waits for it.
 */

import { evaluateDistillBudget, reserveDistillBudget, summarizeDistillLedger, summarizeEnrichLedger } from './lib/budget.js'
import { evaluateCheckpointGuard } from './lib/checkpoint-guard.js'
import { checkContract } from './lib/contract.js'
import { enrichAfterFailure, modelSelectionOf } from './lib/enrich.js'
import { evaluateSupport, renderSupport } from './lib/support.js'
import { clip, estimateTokens, nowMs, oneLine } from './lib/util.js'

export const name = 'memory-distill'

/** The store is provided by `memory-core`; without it this row stays inactive. */
export const inject = ['memoryStore']

const PREFERENCE_RE = /(always|never|from now on|by convention|remember|prefer|must|don't|do not|记住|以后|下次|不要再|默认|约定|习惯|务必)/i

const DEFAULTS = {
  enabled: true,
  checkpoint: true,
  includeSubagents: true,
  // Row fallbacks only. The shipped bundle patch (cordis.patch.yml) enables the
  // model call and sets threshold 4; a row mounted without that patch stays
  // deterministic, because this row must not spend a model request by accident.
  // README "Configuration" documents both layers.
  llm: {
    enabled: false,
    threshold: 3,
    deepThreshold: 6,
    maxCallsPerSession: 2,
    maxCallsPerDay: 12,
    maxTokens: 700,
    deepMaxTokens: 1400,
    minIntervalMs: 120_000,
    maxCandidates: 2,
    /**
     * Failure-driven semantic enrichment: when this turn's recall produced
     * zero hits, one extra bounded call writes retrieval aliases and learned
     * synonym groups. On only while `enabled` is, with its own (persisted)
     * budget; `false` keeps the row to distillation + checkpoints.
     */
    enrich: true,
    enrichMaxPerSession: 4,
    enrichMaxPerDay: 6,
    enrichMinIntervalMs: 45_000,
    enrichMaxCandidates: 8,
    enrichMaxPromptTokens: 1_200,
    enrichMaxTokens: 500,
    enrichMaxRecords: 2,
    enrichTtlMs: 604_800_000,
  },
}

function normalizeConfig(raw) {
  const input = raw !== null && typeof raw === 'object' ? raw : {}
  return {
    ...DEFAULTS,
    ...input,
    enabled: input.enabled !== false,
    checkpoint: input.checkpoint !== false,
    includeSubagents: input.includeSubagents !== false,
    llm: { ...DEFAULTS.llm, ...(input.llm ?? {}) },
  }
}

// ---------------------------------------------------------------- samples ----

/**
 * Live per-session turn samples. Owned by the mounted row (inside `apply`),
 * not by the module: two mounted instances must not share or clear each
 * other's state.
 */

/**
 * Resolve the session's effective working directory.
 *
 * The session header records the directory the session was *created* with; a
 * subagent's `cwd` and every later `cd` are durable working-directory changes,
 * so the header is the wrong source for scoping a project memory.
 */
function cwdOfSession(ctx, session) {
  try {
    const service = ctx.get('workingDirectory')
    if (service !== undefined) {
      const value = service.get(session)
      if (typeof value === 'string' && value !== '') return value
    }
  } catch {
    // fall through to the recorded header
  }
  return session?.header?.cwd
}

function emptySample(sessionId, turn) {
  return {
    sessionId,
    turn,
    startedAt: Date.now(),
    userTexts: [],
    tools: [],
    /** callId → { ok, code } — the observation record a candidate must cite. */
    results: new Map(),
    edits: [],
    errors: [],
    successAfterError: false,
    lastAssistant: '',
    origin: 'root',
    cwd: undefined,
  }
}

/** Sessions whose turn never ends (aborted process, disposed agent) must not leak. */
const MAX_SAMPLES = 128

function rememberSample(samples, sessionId, sample) {
  if (samples.size >= MAX_SAMPLES && !samples.has(sessionId)) {
    // Map preserves insertion order; drop the oldest turn still in flight.
    const oldest = samples.keys().next().value
    if (oldest !== undefined) samples.delete(oldest)
  }
  samples.set(sessionId, sample)
}

function noteError(sample, name, code, reason) {
  sample.errors.push({ name, code, reason: oneLine(reason ?? '', 160) })
}

function toolNameOf(sample, callId) {
  for (let index = sample.tools.length - 1; index >= 0; index -= 1) {
    if (sample.tools[index].callId === callId) return sample.tools[index].name
  }
  return undefined
}

function foldEvent(sample, event) {
  switch (event.type) {
    case 'user/message': {
      if (event.data.source?.kind !== 'user') return
      const text = event.data.content
        ?.filter(block => block?.type === 'text')
        .map(block => block.text)
        .join(' ')
      if (text) sample.userTexts.push(oneLine(text, 400))
      return
    }
    case 'tool/call': {
      const name = event.data.name
      sample.tools.push({
        ref: `t${sample.tools.length + 1}`,
        callId: event.data.callId,
        name,
        args: clip(event.data.arguments ?? '', 240),
      })
      if (name === 'write' || name === 'edit' || name === 'str_replace') sample.edits.push(name)
      return
    }
    case 'tool/result': {
      const callId = event.data.message?.toolCallId
      const error = event.data.error
      const failed = error !== undefined || event.data.message?.isError === true
      sample.results.set(callId, { ok: !failed, code: error?.code })
      if (failed) {
        const name = toolNameOf(sample, callId) ?? 'tool'
        noteError(sample, name, error?.code ?? 'ERROR', error?.reason ?? 'tool reported an error')
        return
      }
      if (sample.errors.length > 0) sample.successAfterError = true
      return
    }
    case 'assistant/message': {
      const text = event.data.message?.content
        ?.filter(block => block?.type === 'text')
        .map(block => block.text)
        .join(' ')
      if (text) sample.lastAssistant = oneLine(text, 700)
      return
    }
    default:
  }
}

/** Score one finished turn for transferable value. */
function scoreTurn(sample) {
  let score = 0
  const reasons = []
  const text = sample.userTexts.join(' ')
  if (PREFERENCE_RE.test(text)) {
    score += 4
    reasons.push('durable-intent')
  }
  if (sample.errors.length > 0) {
    score += 2
    reasons.push('failure')
  }
  if (sample.errors.length > 0 && sample.successAfterError) {
    score += 2
    reasons.push('recovered')
  }
  if (sample.edits.length > 0) {
    score += 2
    reasons.push('changed-files')
  }
  if (sample.tools.length >= 4) {
    score += 1
    reasons.push('multi-step')
  }
  if (sample.tools.length === 0) {
    score -= 2
    reasons.push('no-tools')
  }
  return { score, reasons }
}

/** Build the bounded distillation prompt, including citable observation ids. */
function buildPrompt(sample) {
  const tools = sample.tools.slice(-12).map(tool => {
    const result = sample.results.get(tool.callId)
    const outcome = result === undefined ? 'no-result' : result.ok ? 'ok' : `failed(${result.code ?? 'ERROR'})`
    return `${tool.ref} ${tool.name}(${tool.args}) -> ${outcome}`
  }).join('\n') || '(none)'
  const errors = sample.errors.slice(-6).map(error => `${error.name}: ${error.code} ${error.reason}`).join('\n') || '(none)'
  const files = [...new Set(sample.edits)].join(', ') || '(none)'
  return `Extract durable, transferable memory from one coding-agent turn in this repository.

Return JSON only — [] or up to ${2} objects:
[{"kind":"procedure|fact|pitfall|preference|decision","trigger":"...","claim":"...","evidence_refs":["t1"],"evidence":"...","confidence":0.0}]

Rules:
- Record only knowledge that will recur and is expensive to rediscover here.
- trigger: the concrete situation that should surface it (file, symbol, command, error string).
- claim: the action or rule and its reason, at most two sentences.
- evidence_refs: ids of the successful observations that establish the claim (from TOOLS below).
  A claim about a command or a test must cite a command that ran. No refs means the
  candidate is stored as a proposal, not as fact.
- evidence: where it came from in words (path, command, doc).
- Skip trivia, one-off values, restatements of the user's request, and unverified guesses.
- Return [] when nothing qualifies.

USER: ${sample.userTexts.join(' / ').slice(0, 900) || '(none)'}
TOOLS:
${tools}
ERRORS:
${errors}
FILES CHANGED: ${files}
FINAL ANSWER: ${sample.lastAssistant.slice(0, 600) || '(none)'}`
}

/** Parse the model's JSON answer, ignoring anything malformed. */
function parseCandidates(text) {
  const start = text.indexOf('[')
  const end = text.lastIndexOf(']')
  if (start < 0 || end <= start) return []
  let parsed
  try {
    parsed = JSON.parse(text.slice(start, end + 1))
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  return parsed.filter(item => item !== null && typeof item === 'object'
    && typeof item.trigger === 'string' && item.trigger.trim().length >= 3
    && typeof item.claim === 'string' && item.claim.trim().length >= 12)
}

/** One bounded model call; returns the number of records written. */
async function distillWithModel(ctx, store, config, sample, level, budgets) {
  const llm = ctx.get('llm')
  if (llm === undefined) {
    store.log('debug', 'distill skipped: no llm service')
    return 0
  }
  let selection
  try {
    selection = modelSelectionOf(ctx, sample.sessionId)
  } catch {
    selection = undefined
  }
  if (selection === undefined) {
    store.log('debug', 'distill skipped: no model selection')
    return 0
  }

  // Re-check at the reservation point: the caller's check ran before this
  // async function, and the cooldown may have been armed by another turn.
  const verdict = evaluateDistillBudget({ budgets, config, sessionId: sample.sessionId, isSubagent: sample.origin === 'subagent' })
  if (!verdict.allowed) {
    store.log('debug', `distill skipped: ${verdict.reason}`)
    return 0
  }
  const attemptedAt = Date.now()
  reserveDistillBudget(budgets, sample.sessionId, attemptedAt)
  // Persist the reservation before the network request: a crash, a failed
  // stream, or an aborted turn must still consume the day's allowance.
  try {
    await store.recordDistillAttempt(sample.sessionId, attemptedAt)
  } catch (error) {
    store.log('warn', `distill reservation could not be persisted: ${String(error?.message ?? error)}`)
  }

  const started = nowMs()
  const prompt = buildPrompt(sample)
  const inputEstimate = estimateTokens(prompt)
  let text = ''
  let usage
  let failure
  try {
    const options = {
      provider: selection.provider,
      model: selection.model,
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
      maxTokens: level === 'deep' ? config.llm.deepMaxTokens : config.llm.maxTokens,
      temperature: 0,
      sessionId: sample.sessionId,
    }
    if (level === 'deep' && selection.reasoningEffort !== undefined) options.reasoningEffort = selection.reasoningEffort
    for await (const chunk of llm.stream(options)) {
      if (chunk.type === 'text-delta') text += chunk.text
      else if (chunk.type === 'usage') usage = chunk.usage
      else if (chunk.type === 'finish' && chunk.reason?.kind === 'error') failure = chunk.reason.failure
    }
  } catch (error) {
    store.log('warn', `distill call failed: ${String(error?.message ?? error)}`)
    return 0
  }

  const elapsed = nowMs() - started
  const inputTokens = usage?.inputTokens ?? inputEstimate
  const outputTokens = usage?.outputTokens ?? estimateTokens(text)
  store.bump(sample.sessionId, {
    distillCalls: 1,
    distillInputTokens: inputTokens,
    distillOutputTokens: outputTokens,
    distillMs: elapsed,
  })
  await store.flushLedger(sample.sessionId)

  if (failure !== undefined) {
    store.log('warn', `distill model failure: ${failure.message}`)
    return 0
  }

  const candidates = parseCandidates(text).slice(0, config.llm.maxCandidates)
  let written = 0
  let promoted = 0
  for (const candidate of candidates) {
    try {
      // The model only reports what the turn observed; the runtime decides
      // whether that observation exists, succeeded, and can support this class
      // of claim. Unsupported candidates are stored as proposals.
      const verdict = evaluateSupport(candidate, sample)
      const evidence = typeof candidate.evidence === 'string' ? candidate.evidence.trim() : ''
      if (verdict.sufficient) promoted += 1
      await store.write({
        scope: 'project',
        kind: candidate.kind,
        trigger: candidate.trigger,
        claim: candidate.claim,
        evidence: evidence || renderSupport(sample, verdict.refs ?? [], verdict.reason),
        confidence: verdict.sufficient ? 0.6 : 0.4,
        status: verdict.sufficient ? undefined : 'proposed',
        support: {
          class: verdict.class ?? 'unsupported',
          reason: verdict.reason,
          refs: verdict.refs ?? [],
          sessionId: sample.sessionId,
          turn: sample.turn,
        },
        cwd: sample.cwd,
        origin: `distill:${level}`,
        sessionId: sample.sessionId,
        tags: ['distilled'],
      })
      written += 1
    } catch (error) {
      store.log('debug', `distill candidate rejected: ${String(error?.message ?? error)}`)
    }
  }
  store.bump(sample.sessionId, { written })
  await store.event(
    'distill',
    `${level} call ${elapsed.toFixed(0)}ms, ${inputTokens}/${outputTokens} tok, `
      + `wrote ${written}/${candidates.length} (${promoted} supported by cited observations)`,
    sample.sessionId,
  )
  return written
}

/** Write the deterministic checkpoint for the finished turn. */
async function writeCheckpoint(store, sample) {
  if (sample.cwd === undefined) return
  const existing = store.getCheckpoint(sample.cwd, sample.sessionId)
  const guard = evaluateCheckpointGuard(existing, sample.sessionId, Date.now(), {
    curated: store.isCurated(sample.sessionId),
  })
  if (guard.action === 'skip') {
    // Do not lose state silently: another session's fresh checkpoint stays, and
    // the skip is visible in the event ring.
    await store.event(
      'checkpoint-skipped',
      `${guard.reason} (existing session ${String(existing?.sessionId ?? '?').slice(0, 8)}, ${Math.round((guard.ageMs ?? 0) / 60000)}m old)`,
      sample.sessionId,
    )
    return
  }

  const lastError = sample.errors.slice(-1)[0]
  await store.checkpoint(sample.cwd, {
    milestone: oneLine(sample.userTexts[0] ?? sample.lastAssistant, 240),
    nextAction: existing?.nextAction ?? (sample.successAfterError ? undefined : 'continue from the last verified step'),
    openQuestion: lastError === undefined || sample.successAfterError
      ? existing?.openQuestion
      : `${lastError.name} failed (${lastError.code}): ${lastError.reason}`,
    sessionId: sample.sessionId,
    turn: sample.turn,
  })
}

// ------------------------------------------------------------------- apply --

export async function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig)
  const store = ctx.get('memoryStore')
  if (store === undefined) {
    ctx.logger?.warn?.('[context-manager] distill inactive: memoryStore missing')
    return
  }
  if (config.enabled === false) {
    ctx.logger?.info?.('[context-manager] distill disabled by config')
    return
  }
  const compatible = checkContract(ctx, 'memory-distill', {
    'ctx.on': typeof ctx.on === 'function',
    'ctx.effect': typeof ctx.effect === 'function',
    'ctx.get': typeof ctx.get === 'function',
  })
  if (!compatible) return

  // State belongs to this mounted row, not to the module: two instances must
  // not share samples, budgets, or a cooldown.
  const samples = new Map()
  const budgets = {
    day: '',
    calls: 0,
    bySession: new Map(),
    lastAt: new Map(),
    enrichDay: '',
    enrichCalls: 0,
    enrichBySession: new Map(),
    enrichLastAt: new Map(),
  }

  // Recover today's reserve and the last attempt from the ledger so a restart
  // does not reset either the caps or the cooldown. Enrichment recovers the
  // same way, from its own persisted fields.
  const today = new Date().toISOString().slice(0, 10)
  try {
    const recovered = summarizeDistillLedger(store.ledgerRows(), today)
    budgets.day = today
    budgets.calls = recovered.calls
    budgets.bySession = new Map(recovered.bySession)
    budgets.lastAt = new Map(recovered.lastAt)
    if (recovered.calls > 0) {
      store.log('info', `distill budget recovered from ledger: ${recovered.calls} call(s) today`)
    }
    const recoveredEnrich = summarizeEnrichLedger(store.ledgerRows(), today)
    budgets.enrichDay = today
    budgets.enrichCalls = recoveredEnrich.calls
    budgets.enrichBySession = new Map(recoveredEnrich.bySession)
    budgets.enrichLastAt = new Map(recoveredEnrich.lastAt)
    if (recoveredEnrich.calls > 0) {
      store.log('info', `enrich budget recovered from ledger: ${recoveredEnrich.calls} call(s) today`)
    }
  } catch (error) {
    store.log('debug', `budget recovery failed: ${String(error?.message ?? error)}`)
  }

  ctx.effect(() => () => {
    samples.clear()
    budgets.bySession.clear()
    budgets.lastAt.clear()
    budgets.enrichBySession.clear()
    budgets.enrichLastAt.clear()
  })

  // A session can end without a `turn/end` (disposed agent, aborted process);
  // drop its half-built sample so the map does not accumulate one per session.
  ctx.on('agent/disposed', ({ agent }) => {
    const sessionId = agent?.id ?? agent?.session?.id
    if (typeof sessionId === 'string' && sessionId !== '') samples.delete(sessionId)
  })

  ctx.on('session/event', (session, event) => {
    try {
      const sessionId = session?.id
      if (sessionId === undefined) return
      const header = session.header
      const isSubagent = header?.origin === 'subagent'

      if (event.type === 'turn/start') {
        const sample = emptySample(sessionId, event.data.turn)
        sample.cwd = cwdOfSession(ctx, session)
        sample.origin = isSubagent ? 'subagent' : 'root'
        rememberSample(samples, sessionId, sample)
        return
      }

      const sample = samples.get(sessionId)
      if (sample === undefined) return

      if (event.type === 'tool/call' || event.type === 'tool/result'
        || event.type === 'user/message' || event.type === 'assistant/message') {
        foldEvent(sample, event)
        return
      }

      if (event.type !== 'turn/end') return
      samples.delete(sessionId)

      if (event.data.reason?.kind === 'aborted') return
      const analysis = scoreTurn(sample)

      if (config.checkpoint) {
        void writeCheckpoint(store, sample).catch(error => {
          store.log('debug', `checkpoint write failed: ${String(error?.message ?? error)}`)
        })
      }

      // Failure-driven semantic enrichment: independent of the distillation
      // score and of whether a distillation call fires, with its own budget,
      // cooldown, and persisted reservations. Detached like the distill call —
      // the next turn never waits for it.
      if (config.llm.enabled === true && config.llm.enrich !== false) {
        void enrichAfterFailure({
          ctx,
          store,
          config,
          sessionId: sample.sessionId,
          startedAt: sample.startedAt,
          budgets,
          isSubagent: sample.origin === 'subagent',
        }).catch(error => {
          store.log('warn', `enrichment failed: ${String(error?.message ?? error)}`)
        })
      }

      if (config.llm.enabled !== true) return
      if (analysis.score < config.llm.threshold) return
      // A turn that only moved state around has nothing transferable to teach;
      // spending a request on it is pure overhead.
      const substantial = sample.tools.length >= 3 || analysis.reasons.includes('durable-intent')
      if (!substantial) return
      const verdict = evaluateDistillBudget({ budgets, config, sessionId, isSubagent })
      if (!verdict.allowed) {
        store.log('debug', `distill skipped: ${verdict.reason}`)
        return
      }

      const level = analysis.score >= config.llm.deepThreshold ? 'deep' : 'short'
      void store.event('distill-plan', `${level} (score ${analysis.score}: ${analysis.reasons.join(',')})`, sessionId)
      void distillWithModel(ctx, store, config, sample, level, budgets).catch(error => {
        store.log('warn', `distill failed: ${String(error?.message ?? error)}`)
      })
    } catch (error) {
      store.log('debug', `distill fold failed: ${String(error?.message ?? error)}`)
    }
  })

  ctx.logger?.info?.(
    `[context-manager] distill active (llm ${config.llm.enabled ? `on, threshold ${config.llm.threshold}` : 'off'}`
    + `${config.llm.enabled && config.llm.enrich !== false ? ', enrich on' : ''})`,
  )
}
