/**
 * Best-effort visibility bridge for the QQ bot plugin.
 *
 * DSH has no "public conversation" metadata, so the memory plugin cannot tell a
 * group chat from a one-to-one chat on its own. `@tencent-connect/dsh-qqbot`
 * does know (`ChatScope = 'c2c' | 'group'`), but it keeps that knowledge to
 * itself: it exposes no service, and its session ids are random
 * (`session-<uuid>`), so the scope cannot be read from the session id either.
 *
 * What it does persist is `~/.dsh-qqbot/model-prefs.json`:
 *
 *     { "sessionIds": { "qqbot:<appId>:c2c:<peer>": "session-…",
 *                       "qqbot:<appId>:group:<peer>": "session-…" }, … }
 *
 * That file is the one durable place the scope crosses into a plain file, so a
 * bridge can read it without changing the QQ plugin. It is best-effort by
 * design: a missing, unreadable, or malformed file means "no opinion", and the
 * caller keeps the safe default (public). The durable fix is for the QQ plugin
 * to call the `memoryVisibility` service directly when it creates a session.
 */

import { readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Default location of the QQ plugin's preference file. */
export function qqbotPrefsPath(env = process.env) {
  const configured = typeof env.QQBOT_DATA_DIR === 'string' ? env.QQBOT_DATA_DIR.trim() : ''
  return join(configured !== '' ? configured : join(homedir(), '.dsh-qqbot'), 'model-prefs.json')
}

/**
 * Map one stored session id to its visibility.
 *
 * `qqbot:<appId>:c2c:<openid>` is a one-to-one conversation, so its records may
 * be private; anything else (a group) is public. Unknown keys are ignored.
 *
 * @returns `'private' | 'public' | undefined`
 */
export function qqbotScopeOfSessionKey(key) {
  const match = /^qqbot:[^:]*:(c2c|group):/i.exec(String(key ?? ''))
  if (match === null) return undefined
  return match[1].toLowerCase() === 'c2c' ? 'private' : 'public'
}

/** Invert `model-prefs.json`'s session map into `sessionId → visibility`. */
export function qqbotSessionScopes(prefs) {
  const scopes = new Map()
  const sessionIds = prefs?.sessionIds
  if (sessionIds === null || typeof sessionIds !== 'object' || Array.isArray(sessionIds)) return scopes
  for (const [key, sessionId] of Object.entries(sessionIds)) {
    if (typeof sessionId !== 'string' || sessionId === '') continue
    const scope = qqbotScopeOfSessionKey(key)
    if (scope !== undefined) scopes.set(sessionId, scope)
  }
  return scopes
}

/** Read the preference file and return `sessionId → visibility`; never throws. */
export async function readQqbotSessionScopes(path) {
  try {
    return qqbotSessionScopes(JSON.parse(await readFile(path, 'utf8')))
  } catch {
    return new Map()
  }
}

/**
 * Cheap change detector for the preference file: modification time and size.
 *
 * Returns `'missing'` for an absent or unreadable file, so the first successful
 * read always counts as a change. The caller re-reads only when this string
 * differs, which keeps the bridge current without watching a foreign plugin's
 * directory or reading the file on every step. Asynchronous because this check
 * runs at the start of a turn, where the Host event loop must stay free.
 */
export async function bridgeStamp(path) {
  try {
    const info = await stat(path)
    return `${info.mtimeMs}:${info.size}`
  } catch {
    return 'missing'
  }
}

/** Apply a visibility map to a store; returns how many sessions were declared. */
export function applySessionScopes(store, scopes) {
  let applied = 0
  for (const [sessionId, visibility] of scopes ?? []) {
    store.setSessionVisibility(sessionId, visibility)
    applied += 1
  }
  return applied
}
