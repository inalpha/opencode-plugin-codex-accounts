/**
 * The accounts file, read and written without destroying what is in it.
 *
 * This is the only file here that can lose something irreplaceable, so it is built the cautious way
 * round: SHADOW IS THE DEFAULT. A store you construct without arguments reads the live file and
 * writes nothing. Turning on writes takes an explicit flag, which is the opposite of how the rest
 * of this box has historically gone wrong.
 *
 * THREE RULES, each from a way this class of code has actually caused damage:
 *
 *   1. NEVER DROP A FIELD YOU DID NOT UNDERSTAND. The file holds `refreshToken`, `accessToken`,
 *      `oauthScope`, `expiresAt`, `email` and whatever a future plugin version adds. A writer that
 *      serialises only the keys it knows about silently deletes credentials. Every write here is a
 *      spread over the row as it was read.
 *   2. ATOMIC OR NOT AT ALL. Write a temp file in the same directory, chmod it, rename over the
 *      target. A partial write to this file is an org that cannot reach Codex at all.
 *   3. THE MODE IS PART OF THE CONTENT. The live file is 0600. `VACUUM INTO` created a 644 copy of
 *      the conversation store earlier today and nothing would have noticed; the same mistake here
 *      puts OAuth tokens in a world-readable file.
 *
 * It does NOT hold the lock that `oc-codex-multi-auth` uses (`proper-lockfile` on its own path), so
 * while that plugin is live this store must stay in shadow. Two writers on this file is the race
 * that rotates a refresh token out from under the other one — see oauth.js.
 */
import { readFileSync, writeFileSync, renameSync, chmodSync, unlinkSync, openSync, closeSync } from "node:fs"
import { dirname, join } from "node:path"

export const LIVE_PATH = `${process.env.HOME}/.opencode/oc-codex-multi-auth-accounts.json`
const MODE = 0o600

/** Upstream's field names are not ours. Mapped in one place so nothing else has to know. */
function toRow(raw) {
  return {
    ...raw,                                  // keep everything, including what we do not read
    accountId: raw.accountId,
    access: raw.accessToken,
    refresh: raw.refreshToken,
    expiresAt: raw.expiresAt,          // read, never written: refresh is not ours
    rateLimitResetTimes: raw.rateLimitResetTimes || {},
  }
}

/** …and back, without inventing keys. Only the fields we are entitled to change are written. */
function toRaw(prev, row) {
  const out = { ...prev }
  out.rateLimitResetTimes = row.rateLimitResetTimes || {}
  if (row.lastUsedAt != null) out.lastUsedAt = row.lastUsedAt
  if (row.access && row.access !== prev.accessToken) out.accessToken = row.access
  if (row.refresh && row.refresh !== prev.refreshToken) out.refreshToken = row.refresh
  return out
}

export function createStore({ path = LIVE_PATH, writable = false, journal = null } = {}) {
  const decisions = []

  const load = () => JSON.parse(readFileSync(path, "utf8"))

  function persist(doc) {
    const dir = dirname(path)
    const tmp = join(dir, `.accounts.${process.pid}.${Date.now()}.tmp`)
    writeFileSync(tmp, JSON.stringify(doc, null, 2), { mode: MODE })
    chmodSync(tmp, MODE)                     // explicit: umask can loosen the mode above
    renameSync(tmp, path)                    // atomic within the directory
  }

  /** A crude exclusive lock. Not upstream's lock, which is why writable mode is not for use
   *  while that plugin is loaded — this only protects us from ourselves. */
  function withLock(fn) {
    const lock = `${path}.codex-accounts.lock`
    let fd
    try { fd = openSync(lock, "wx") } catch { throw new Error("accounts file is locked") }
    try { return fn() } finally { closeSync(fd); try { unlinkSync(lock) } catch {} }
  }

  return {
    writable,
    read: () => load().accounts.map(toRow),

    /** In shadow mode this RECORDS the change and returns it, without touching the file. */
    update(accountId, fn) {
      const doc = load()
      const i = (doc.accounts || []).findIndex((a) => a.accountId === accountId)
      if (i < 0) return null
      const before = doc.accounts[i]
      const after = toRaw(before, fn(toRow(before)))
      const change = {
        at: new Date().toISOString(), accountId,
        blocksBefore: Object.keys(before.rateLimitResetTimes || {}).length,
        blocksAfter: Object.keys(after.rateLimitResetTimes || {}).length,
      }
      if (!writable) {
        decisions.push({ ...change, shadow: true })
        if (journal) { try { journal(change) } catch {} }
        return toRow(after)                  // what we WOULD have stored
      }
      withLock(() => {
        const fresh = load()                 // re-read inside the lock; never write a stale doc
        const j = fresh.accounts.findIndex((a) => a.accountId === accountId)
        if (j < 0) return
        fresh.accounts[j] = toRaw(fresh.accounts[j], fn(toRow(fresh.accounts[j])))
        persist(fresh)
      })
      return toRow(after)
    },

    decisions: () => decisions.slice(),
  }
}
