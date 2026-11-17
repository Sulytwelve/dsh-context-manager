/**
 * Evidence classification for distilled memory candidates.
 *
 * A distillation is one non-tool model call: it can only *report* what the turn
 * observed, never observe anything itself. So a candidate may become `active`
 * only when it cites concrete tool results from that turn, those results
 * succeeded, and the class of result can actually support the claim:
 *
 * - a read/search observation supports "the file says X" (documentary);
 * - a command that ran supports "this command works / the test passes"
 *   (behavioural), and a behavioural claim needs one of those.
 *
 * Anything else stays `proposed`, which the recall path never serves as fact.
 */

/** Tools whose success means the model looked at something. */
const OBSERVATION_TOOLS = new Set([
  'read', 'grep', 'glob', 'read_image', 'view', 'ls', 'list',
  'web_fetch', 'web_search', 'memory',
])

/** Tools whose success means something was executed. */
const VERIFICATION_TOOLS = new Set([
  'pwsh', 'bash', 'shell', 'terminal', 'run_code', 'node', 'npm', 'pnpm', 'yarn', 'git', 'python', 'pytest',
])

const VERIFICATION_PATTERN = /^(pwsh|bash|shell|terminal|run|exec|cmd|powershell)/

/** Classify a tool name into the kind of support its success provides. */
export function toolClass(name) {
  const lower = String(name ?? '').toLowerCase()
  if (VERIFICATION_TOOLS.has(lower) || VERIFICATION_PATTERN.test(lower)) return 'verification'
  if (OBSERVATION_TOOLS.has(lower)) return 'observation'
  return 'other'
}

/**
 * Whether the claim asserts an *outcome of execution* rather than reporting
 * what a document says. "The doc says to run X" is documentary; "running X
 * passes" is behavioural and needs a command that actually ran.
 *
 * Every alternative is word-bounded: without that, "workspace" contains "works"
 * and a documentary claim about a workspace was demoted as if it claimed a
 * command had run.
 */
const OUTCOME = /(?:\bpass(?:es|ed|ing)?\b|\bfail(?:s|ed|ing)?\b|\bsucceed(?:s|ed)?\b|\bworks?\b|\bworked\b|\bexit(?:s|ed)?\b|\bbuilds? successfully\b|\bgreen\b|\bred\b)/i

function isBehavioural(claim) {
  return OUTCOME.test(String(claim ?? ''))
}

/**
 * Decide whether one distilled candidate is supported by the turn it came from.
 *
 * @param candidate - the model's proposal, including optional `evidence_refs`.
 * @param sample - the finished turn: `tools` (`{ref, callId, name}`) and `results`
 *   (`Map<callId, {ok, code}>`).
 * @returns `{ sufficient, reason?, class?, refs? }`.
 */
export function evaluateSupport(candidate, sample) {
  const requested = Array.isArray(candidate?.evidence_refs)
    ? candidate.evidence_refs.filter(item => typeof item === 'string').slice(0, 4)
    : []
  if (requested.length === 0) return { sufficient: false, reason: 'no-evidence-ref' }

  const byRef = new Map()
  for (const tool of sample?.tools ?? []) byRef.set(tool.ref, tool)
  for (const ref of requested) {
    if (!byRef.has(ref)) return { sufficient: false, reason: `unknown-ref:${ref}` }
  }

  const cited = requested.map(ref => {
    const tool = byRef.get(ref)
    const result = sample.results.get(tool.callId)
    return { ref: tool.ref, name: tool.name, ok: result?.ok === true, code: result?.code }
  })
  const successful = cited.filter(entry => entry.ok)
  if (successful.length === 0) return { sufficient: false, reason: 'cited-tools-failed' }

  const classes = new Set(successful.map(entry => toolClass(entry.name)))
  if (isBehavioural(candidate.claim) && !classes.has('verification')) {
    return { sufficient: false, reason: 'behavioural-claim-cited-no-command' }
  }
  if (!classes.has('verification') && !classes.has('observation')) {
    return { sufficient: false, reason: 'cited-tools-support-nothing' }
  }
  return {
    sufficient: true,
    class: classes.has('verification') ? 'verified' : 'documented',
    refs: successful.map(entry => ({ ref: entry.ref, tool: entry.name })),
  }
}

/** Render the evidence line stored on a distilled record. */
export function renderSupport(sample, refs, reason) {
  const parts = refs.map(entry => `${entry.ref}(${entry.tool})`)
  const origin = `session ${sample.sessionId} turn ${sample.turn}`
  return reason === undefined
    ? `${origin}: ${parts.join(', ')}`
    : `${origin}: ${parts.join(', ') || 'no observation'}; unsupported (${reason})`
}
