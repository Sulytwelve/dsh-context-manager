/**
 * Small, dependency-free helpers shared by the three memory rows.
 *
 * Nothing here imports a `@deepseek-ai/*` package: the bundle must resolve in a
 * profile whose node_modules only links the profile's own packages.
 */

import { createHash, randomUUID } from 'node:crypto'
import { open, stat } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'

/** One fresh identity, branded-string compatible. */
export function uuid() {
  return randomUUID()
}

/**
 * Derive a path-safe record key from arbitrary text.
 *
 * The storage backends key per-record documents by file/SQL identifier segment,
 * which accepts `[A-Za-z0-9_-]` only; an absolute Windows or POSIX path is not
 * a legal key. The readable form stays in the record value.
 */
export function safeKey(text) {
  return createHash('sha256').update(String(text ?? '')).digest('hex').slice(0, 32)
}

/** Deep freeze a freshly built plain value (messages must be immutable). */
export function deepFreeze(value) {
  if (value === null || typeof value !== 'object') return value
  if (!Object.isFrozen(value)) Object.freeze(value)
  for (const key of Object.keys(value)) deepFreeze(value[key])
  return value
}

/** Build one model-facing user-role context message. */
export function contextMessage(text, kind) {
  return deepFreeze({
    id: uuid(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind, form: 'recall' },
  })
}

/** Concatenate the text blocks of one message. */
export function messageText(message) {
  const content = message?.content
  if (!Array.isArray(content)) return ''
  let text = ''
  for (const block of content) if (block?.type === 'text' && typeof block.text === 'string') text += block.text
  return text
}

/** Collect text from the claimed messages a producer other than us authored. */
export function claimedUserText(messages) {
  const parts = []
  for (const message of messages ?? []) {
    if (message?.source?.kind !== 'user') continue
    const text = messageText(message)
    if (text) parts.push(text)
  }
  return parts.join('\n')
}

/** Clip to a code-point-safe maximum with an ellipsis marker. */
export function clip(text, max) {
  const value = String(text ?? '')
  if (value.length <= max) return value
  return `${value.slice(0, Math.max(0, max - 1))}…`
}

/**
 * Clip text to a maximum estimated token count.
 *
 * Character-per-token ratios are wrong the moment the text is CJK (one glyph is
 * roughly one token), so the packet budget must be enforced with the same
 * estimator that counts the final packet. Binary search over code points keeps
 * this cheap for the bounded packet sizes.
 */
export function clipToTokens(text, maxTokens) {
  const value = String(text ?? '')
  if (maxTokens <= 0) return ''
  if (estimateTokens(value) <= maxTokens) return value
  const chars = [...value]
  let low = 0
  let high = chars.length
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    const candidate = `${chars.slice(0, mid).join('')}…`
    if (estimateTokens(candidate) <= maxTokens) low = mid
    else high = mid - 1
  }
  return low === 0 ? '' : `${chars.slice(0, low).join('')}…`
}

/** Collapse whitespace so records stay single-paragraph. */
export function oneLine(text, max = 400) {
  return clip(String(text ?? '').replace(/\s+/g, ' ').trim(), max)
}

const CJK = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/

/**
 * Non-CJK characters per token. Deliberately ~10% below the Host's 4-char
 * heuristic: this estimate only guards the plugin's own packet budget, so
 * erring high keeps a packet just under the budget the Host would count.
 */
const CHARS_PER_TOKEN = 3.6

/**
 * Cheap provider-independent token estimate: CJK glyphs are roughly one token
 * each, other non-space characters about 3.6 to a token.
 */
export function estimateTokens(text) {
  const value = String(text ?? '')
  if (!value) return 0
  let cjk = 0
  let other = 0
  for (const char of value) {
    if (CJK.test(char)) cjk += 1
    else if (!/\s/.test(char)) other += 1
  }
  return cjk + Math.ceil(other / CHARS_PER_TOKEN)
}

const LATIN_WORD = /[a-z0-9_]{2,}/g
const CJK_RUN = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]+/g

const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'you', 'your', 'are', 'was', 'were', 'from', 'have',
  'has', 'had', 'not', 'but', 'can', 'could', 'should', 'would', 'all', 'any', 'use', 'using', 'used',
  'into', 'when', 'what', 'how', 'why', 'its', 'out', 'get', 'got', 'put', 'then', 'than', 'there',
  'here', 'they', 'them', 'their', 'will', 'just', 'also', 'about', 'some', 'more', 'most', 'only',
  'one', 'two', 'new', 'now', 'see', 'may', 'might', 'must', 'need', 'needs', 'make', 'made', 'do',
  'does', 'did', 'done', 'is', 'it', 'be', 'by', 'of', 'on', 'or', 'to', 'in', 'at', 'as', 'an', 'a',
  'if', 'so', 'no', 'up', 'we', 'us', 'me', 'my', 'i', 'this', 'these', 'those', 'each', 'such',
])

/** Tokenize mixed Latin/CJK text into retrieval terms (CJK bigrams). */
export function tokenize(text) {
  const value = String(text ?? '').toLowerCase()
  const terms = new Set()
  for (const match of value.matchAll(LATIN_WORD)) {
    const word = match[0]
    if (!STOPWORDS.has(word)) terms.add(word)
  }
  for (const match of value.matchAll(CJK_RUN)) {
    const run = match[0]
    if (run.length === 1) {
      terms.add(run)
      continue
    }
    for (let index = 0; index + 1 < run.length; index += 1) terms.add(run.slice(index, index + 2))
  }
  return [...terms]
}

/**
 * Read up to `length` bytes at `position` from a file as UTF-8.
 *
 * The probe runs on the Host event loop, so every read is asynchronous: a
 * bounded 320 KiB read is cheap on a local SSD and slow enough on a network
 * filesystem that a synchronous call would stall every other session.
 */
async function readAt(path, length, position) {
  const handle = await open(path, 'r')
  try {
    const buffer = Buffer.alloc(length)
    await handle.read(buffer, 0, length, position)
    return buffer.toString('utf8')
  } finally {
    await handle.close()
  }
}

/** Read at most `maxBytes` from the head of a file as UTF-8. */
async function readHead(path, maxBytes) {
  const size = (await stat(path)).size
  return readAt(path, Math.min(size, maxBytes), 0)
}

/** Read at most `maxBytes` from the tail of a file as UTF-8. */
async function readTail(path, maxBytes) {
  const size = (await stat(path)).size
  const length = Math.min(size, maxBytes)
  return readAt(path, length, Math.max(0, size - length))
}

/** Whether `haystack` contains `needle`, honoring the probe's `ignoreCase`. */
function contains(haystack, needle, ignoreCase) {
  return ignoreCase === true
    ? haystack.toLowerCase().includes(needle.toLowerCase())
    : haystack.includes(needle)
}

/**
 * Run one deterministic memory probe. No model call, no subprocess, bounded
 * I/O: this is the cheap observation that decides whether a remembered fact is
 * still trustworthy.
 *
 * Three outcomes, because "not found" and "could not see it" are different:
 *
 * - `pass` — the check holds;
 * - `fail` — the check was actually evaluated and no longer holds;
 * - `inconclusive` — the target could not be read, or the pattern may lie
 *   outside the scanned window. Never retires a record on its own.
 *
 * Scanned bytes: the head (`maxBytes`) plus, on a miss, a tail window of
 * `tailBytes`. A file larger than head+tail that does not match is
 * `inconclusive`, not `fail` — otherwise a pattern past the first 256 KiB would
 * be permanently "false", and the background sweep would never be able to
 * revive it.
 *
 * @returns `{ status, detail }` with `status` one of `pass` / `fail` / `inconclusive`.
 */
export async function runProbe(probe, cwd, maxBytes = 262_144, tailBytes = 65_536) {
  if (probe === undefined || probe === null) return { status: 'inconclusive', detail: 'no probe' }
  if (typeof probe !== 'object') return { status: 'fail', detail: 'probe must be an object' }
  const target = String(probe.target ?? '')
  if (target === '') return { status: 'fail', detail: 'probe.target is empty' }
  const base = typeof cwd === 'string' && cwd !== '' ? cwd : process.cwd()
  const path = isAbsolute(target) ? target : resolve(base, target)
  try {
    if (probe.kind === 'path-exists') {
      try {
        await stat(path)
        return { status: 'pass', detail: `exists ${target}` }
      } catch (error) {
        // ENOENT/ENOTDIR are definitive "the path is gone"; anything else
        // (permissions) only says the check could not see it.
        if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return { status: 'fail', detail: `missing ${target}` }
        return { status: 'inconclusive', detail: `cannot stat ${target}: ${String(error?.code ?? error)}` }
      }
    }
    if (probe.kind === 'file-contains') {
      let size
      try {
        size = (await stat(path)).size
      } catch (error) {
        if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return { status: 'fail', detail: `missing ${target}` }
        return { status: 'inconclusive', detail: `cannot stat ${target}: ${String(error?.code ?? error)}` }
      }
      const needle = String(probe.pattern ?? '')
      if (needle === '') return { status: 'fail', detail: 'probe.pattern is empty' }
      const head = await readHead(path, maxBytes)
      if (contains(head, needle, probe.ignoreCase)) {
        return { status: 'pass', detail: `contains ${clip(needle, 60)}` }
      }
      if (size <= maxBytes) {
        return { status: 'fail', detail: `no longer contains ${clip(needle, 60)}` }
      }
      // The head did not show it and the file is bigger than the head window.
      const tail = await readTail(path, tailBytes)
      if (contains(tail, needle, probe.ignoreCase)) {
        return { status: 'pass', detail: `contains ${clip(needle, 60)} (tail)` }
      }
      return {
        status: 'inconclusive',
        detail: `${size} bytes scanned ${maxBytes}+${tailBytes}; ${clip(needle, 60)} not seen`,
      }
    }
    return { status: 'fail', detail: `unknown probe kind ${String(probe.kind)}` }
  } catch (error) {
    return { status: 'inconclusive', detail: `probe error: ${String(error?.message ?? error)}` }
  }
}

/**
 * Normalize a directory for equality comparison.
 *
 * Case folding is a filesystem property, not a string property: Windows and
 * macOS default to case-insensitive volumes, Linux does not. Folding on Linux
 * would merge two distinct projects into one owner.
 */
export function normalizeCwdOn(platform, cwd) {
  if (typeof cwd !== 'string' || cwd === '') return undefined
  const trimmed = cwd.replace(/[\\/]+$/, '')
  return platform === 'win32' || platform === 'darwin' ? trimmed.toLowerCase() : trimmed
}

/** Normalize a directory for equality comparison on this platform. */
export function normalizeCwd(cwd) {
  return normalizeCwdOn(process.platform, cwd)
}

/** Build a stable dedupe key from scope, kind, and text. */
export function dedupeKey(scope, kind, text) {
  return `${scope}:${kind}:${slug(text, 72) || 'untitled'}`
}

/** Lowercase punctuation-stripped form of text, bounded to `max` characters. */
export function slug(text, max = 72) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9\u3400-\u9fff]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
}

/** Jaccard overlap of two term sets, used to recognise a restated claim. */
export function similarity(left, right) {
  const a = new Set(tokenize(left))
  const b = new Set(tokenize(right))
  if (a.size === 0 || b.size === 0) return 0
  let shared = 0
  for (const term of a) if (b.has(term)) shared += 1
  return shared / (a.size + b.size - shared)
}

/** Milliseconds elapsed, using the monotonic clock when available. */
export function nowMs() {
  return typeof performance !== 'undefined' ? performance.now() : Date.now()
}

/** Human age such as `3d`. */
export function age(ms) {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 90) return `${seconds}s`
  const minutes = Math.round(seconds / 60)
  if (minutes < 90) return `${minutes}m`
  const hours = Math.round(minutes / 60)
  if (hours < 48) return `${hours}h`
  return `${Math.round(hours / 24)}d`
}
