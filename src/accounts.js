/**
 * The decisions, with no I/O in them.
 *
 * Everything here is a pure function of (accounts, now) so the parts that have actually broken in
 * production can be tested without a network, a clock or a live OpenCode. That is not a style
 * preference: every incident this plugin exists to prevent was a decision bug, not a plumbing bug.
 */

// A block we set ourselves is a PREDICTION. The provider's own reading is an OBSERVATION, and when
// they disagree the observation wins. `oc-codex-multi-auth` could only ever LENGTHEN a block --
// nothing in it ever removed one early -- so a wrong reset time took a working account out of
// service until it expired. Measured 2026-09-14: 19 stale blocks across two accounts, one of them
// sitting on an account the provider reported as 100% free, and the tooling reported "all 2 Codex
// accounts rate limited" to the the operator while an account was idle and available.
export function releaseContradictedBlocks(account, observed, now) {
  const blocks = account.rateLimitResetTimes || {}
  if (!observed || observed.leftPercent == null || observed.leftPercent <= 0) return blocks
  // Only blocks LONGER than the window the provider just reported on. A five-hour observation says
  // nothing about a weekly block, and clearing one on the other's evidence is how you turn a
  // narrow fix into an outage.
  // KEEP what this reading cannot speak to; RELEASE what it contradicts. A block that expires
  // INSIDE the window the provider just reported as having room is a block the provider has just
  // denied; one that reaches beyond it (a weekly cap, say) is untouched by a five-hour reading.
  //
  // Written the other way round first, and the tests caught it: it kept exactly the blocks it
  // meant to drop. That is the same inversion as the bug this function exists to fix, which is
  // why the two directions are now spelled out rather than left to a comparison operator.
  const horizon = now + (observed.windowMs || 0)
  const kept = {}
  for (const [k, v] of Object.entries(blocks)) if (v > horizon) kept[k] = v
  return kept
}

export function isBlocked(account, model, now) {
  const blocks = account.rateLimitResetTimes || {}
  const until = blocks[model] ?? blocks[familyOf(model)]
  return until != null && until > now
}

/** `gpt-5.5-medium` is served by the `gpt-5.5` family; the store keys on the family. */
export function familyOf(model) {
  const m = String(model || "")
  const variant = m.replace(/-(low|medium|high|minimal)$/, "")
  return variant || m
}

/**
 * Which account should serve this request.
 *
 * NEVER RETURNS NOTHING WHEN ACCOUNTS EXIST. A selector that can answer "none" turns a stale block
 * into a total outage, which is the failure mode that produced this plugin: the store said both
 * accounts were spent, the provider said one was free, and work stopped. So an all-blocked
 * store falls back to the account whose block expires soonest -- it will either work, proving the
 * block stale, or return a 429 that refreshes the block with a real reset time. Both outcomes are
 * better than refusing to ask.
 */
export function choose(accounts, model, now, { only = null } = {}) {
  // A TOKEN THIS PLUGIN DID NOT MINT AND WILL NOT REPLACE.
  //
  // Reuse the access token already on disk rather than minting one; that removes the rotation hazard
  // instead of guarding it. Measured in production: the stored access tokens expire in 8.9
  // and 5.4 DAYS, not the hour an OAuth access token usually lasts. So there is no need to mint
  // anything -- whoever owns refresh (today `oc-codex-multi-auth`) keeps writing fresh tokens into
  // the file, and this reads them.
  //
  // An expired token therefore makes an account UNUSABLE, never a reason to refresh. Skipping is
  // recoverable; a refresh race rotates a token out from under the other writer and costs an
  // account until a human logs in again.
  const pool = only ? accounts.filter((a) => only.includes(a.accountId)) : accounts
  const live = (a) => a.access && (a.expiresAt == null || a.expiresAt > now)
  const usable = pool.filter((a) => live(a) && !isBlocked(a, model, now))
  // STICK, THEN ROTATE. Operator requirement: do not keep rotating. Only when one
  // account is exhausted, rotate to the next.
  //
  // So this is FIRST USABLE IN A STABLE ORDER, not least-recently-used. The first draft balanced
  // across accounts, which is the wrong shape for a subscription quota: spreading requests puts
  // BOTH five-hour windows into a partially-spent state at the same time, so you lose all
  // Codex capacity at once instead of losing half and carrying on. Draining one account fully
  // keeps the other whole, and a whole account is what you fall back onto.
  //
  // The order is the file's own, which is also what `activeIndex` in the store already means.
  if (usable.length) return usable[0]
  const withRefresh = pool.filter(live)
  if (!withRefresh.length) return null
  const soonest = (a) => {
    const v = Object.values(a.rateLimitResetTimes || {})
    return v.length ? Math.min(...v) : 0
  }
  return withRefresh.reduce((best, a) => (soonest(a) < soonest(best) ? a : best))
}

/** The provider's own limit reading, from the headers it sends on every completion. */
export function readLimits(headers) {
  const get = (k) => {
    const v = headers?.get ? headers.get(k) : headers?.[k]
    return v == null ? null : String(v)
  }
  const pct = parseFloat(get("x-codex-primary-used-percent"))
  if (!Number.isFinite(pct)) return null
  const minutes = parseFloat(get("x-codex-primary-window-minutes"))
  const resetAfter = parseFloat(get("x-codex-primary-reset-after-seconds"))
  return {
    usedPercent: pct,
    leftPercent: 100 - pct,
    windowMs: Number.isFinite(minutes) ? minutes * 60_000 : 0,
    resetAfterMs: Number.isFinite(resetAfter) ? resetAfter * 1000 : null,
  }
}

/** What a 429 (or an exhausted reading) means for the store. Returns the new block map. */
export function blockFrom(account, model, observed, now, retryAfterMs) {
  const blocks = { ...(account.rateLimitResetTimes || {}) }
  const until = now + (retryAfterMs ?? observed?.resetAfterMs ?? 60_000)
  const key = familyOf(model)
  // MONOTONIC: a later reset never shortens an earlier one, or a retry storm walks the block
  // backwards and the account is hammered. Shortening is `releaseContradictedBlocks`' job, and it
  // only acts on a POSITIVE observation.
  blocks[key] = Math.max(blocks[key] ?? 0, until)
  return blocks
}
