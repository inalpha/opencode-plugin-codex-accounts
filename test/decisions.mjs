/**
 * The decisions, tested without a network, a clock or a live OpenCode.
 *
 * Every case here is an incident that actually happened, not a hypothetical. The plumbing is thin;
 * the damage has always come from the decisions.
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { choose, readLimits, blockFrom, releaseContradictedBlocks, familyOf,
         createRotator } from "../src/index.js"
import { refresh, RefreshRefused } from "../src/oauth.js"

const NOW = 1_000_000_000
const acct = (id, over = {}) => ({ accountId: id, refresh: "r", access: "a", ...over })

test("an account with no live block is chosen", () => {
  const a = [acct("A", { rateLimitResetTimes: { "gpt-5.5": NOW + 60_000 } }), acct("B")]
  assert.equal(choose(a, "gpt-5.5-medium", NOW).accountId, "B")
})

test("a block that has already expired does not exclude an account", () => {
  const a = [acct("A", { rateLimitResetTimes: { "gpt-5.5": NOW - 1 } })]
  assert.equal(choose(a, "gpt-5.5-medium", NOW).accountId, "A")
})

test("it STICKS to the first usable account instead of balancing across them", () => {
  // Requirement: do not keep rotating; move to the next account only once one is exhausted.
  // Spreading requests would put BOTH five-hour windows into a partially-spent state at once, so
  // all Codex capacity would be lost together rather than half of it. Recency must not enter into
  // the choice.
  const a = [acct("A", { lastUsedAt: NOW }), acct("B", { lastUsedAt: 0 })]
  assert.equal(choose(a, "gpt-5.5-medium", NOW).accountId, "A")
})

test("it rotates to the next account only once the first is exhausted", () => {
  const a = [acct("A", { rateLimitResetTimes: { "gpt-5.5": NOW + 60_000 } }), acct("B")]
  assert.equal(choose(a, "gpt-5.5-medium", NOW).accountId, "B")
})

test("and it comes back to the first as soon as that block expires", () => {
  const a = [acct("A", { rateLimitResetTimes: { "gpt-5.5": NOW - 1 } }), acct("B")]
  assert.equal(choose(a, "gpt-5.5-medium", NOW).accountId, "A")
})

test("EVERY account blocked still returns one, and it is the soonest to free", () => {
  // The incident this plugin exists for: the store said both accounts were spent, the provider
  // said one was free, and work stopped. A selector that can answer "none" turns a stale block
  // into an outage, so it never answers none while an account exists.
  const a = [acct("A", { rateLimitResetTimes: { "gpt-5.5": NOW + 90_000 } }),
             acct("B", { rateLimitResetTimes: { "gpt-5.5": NOW + 10_000 } })]
  assert.equal(choose(a, "gpt-5.5-medium", NOW).accountId, "B")
})

test("an account with no refresh token is never chosen", () => {
  assert.equal(choose([{ accountId: "A" }], "gpt-5.5-medium", NOW), null)
})

test("the variant suffix is not part of the family key", () => {
  assert.equal(familyOf("gpt-5.5-medium"), "gpt-5.5")
  assert.equal(familyOf("gpt-5.6-terra"), "gpt-5.6-terra")
})

test("the provider's own headers are read as a limit reading", () => {
  const h = new Headers({ "x-codex-primary-used-percent": "40",
                          "x-codex-primary-window-minutes": "300",
                          "x-codex-primary-reset-after-seconds": "600" })
  assert.deepEqual(readLimits(h),
    { usedPercent: 40, leftPercent: 60, windowMs: 18_000_000, resetAfterMs: 600_000 })
})

test("headers without a percentage are not a reading", () => {
  assert.equal(readLimits(new Headers({ "retry-after": "30" })), null)
})

test("a block never walks backwards under a retry storm", () => {
  const a = acct("A", { rateLimitResetTimes: { "gpt-5.5": NOW + 100_000 } })
  const next = blockFrom(a, "gpt-5.5-medium", null, NOW, 1000)
  assert.equal(next["gpt-5.5"], NOW + 100_000, "a shorter retry-after must not shorten a block")
})

test("a positive reading releases a block the provider contradicts", () => {
  // 2026-09-14: 19 stale blocks, one on an account the provider reported 100% free, and the org
  // told the operator "all 2 Codex accounts rate limited" while that account sat idle.
  const a = acct("A", { rateLimitResetTimes: { "gpt-5.5": NOW + 60_000 } })
  const kept = releaseContradictedBlocks(a, { leftPercent: 100, windowMs: 18_000_000 }, NOW)
  assert.deepEqual(kept, {}, "a contradicted block must be released")
})

test("a positive reading does NOT release a block longer than the window it reports on", () => {
  // A five-hour observation says nothing about a weekly block.
  const weekly = NOW + 7 * 24 * 3600_000
  const a = acct("A", { rateLimitResetTimes: { "gpt-5.5": weekly } })
  const kept = releaseContradictedBlocks(a, { leftPercent: 100, windowMs: 18_000_000 }, NOW)
  assert.deepEqual(kept, { "gpt-5.5": weekly })
})

test("an exhausted reading releases nothing", () => {
  const a = acct("A", { rateLimitResetTimes: { "gpt-5.5": NOW + 60_000 } })
  assert.deepEqual(releaseContradictedBlocks(a, { leftPercent: 0, windowMs: 1 }, NOW),
                   { "gpt-5.5": NOW + 60_000 })
})

test("a 429 blocks the account and the next request picks the other one", () => {
  const rows = [acct("A", { lastUsedAt: 0 }), acct("B", { lastUsedAt: 0 })]
  const store = {
    read: () => rows,
    update(id, fn) {
      const i = rows.findIndex((r) => r.accountId === id)
      rows[i] = fn(rows[i]); return rows[i]
    },
  }
  const r = createRotator(store, { now: () => NOW })
  const first = r.authorize("gpt-5.5-medium")
  r.observe("gpt-5.5-medium", first.accountId, 429, new Headers({ "retry-after": "300" }))
  const second = r.authorize("gpt-5.5-medium")
  assert.notEqual(second.accountId, first.accountId, "a 429 must move the next request across")
})

test("refreshing is refused unless the caller can persist the rotated token", async () => {
  // The operator cannot re-authenticate one account until evening, and a refresh INVALIDATES the
  // token it sends. There is no default that refreshes.
  await assert.rejects(() => refresh({ refresh: "r", clientId: "c" }), RefreshRefused)
  await assert.rejects(() => refresh({ refresh: "r", clientId: "c", allowed: true }), RefreshRefused)
})

test("a failed refresh writes nothing, leaving the old token usable", async () => {
  let committed = false
  await assert.rejects(() => refresh({
    refresh: "r", clientId: "c", allowed: true,
    commit: async () => { committed = true },
    fetchImpl: async () => ({ ok: false, status: 400 }),
  }))
  assert.equal(committed, false, "a failed refresh must not overwrite a recoverable state")
})

test("a rotated token is persisted BEFORE the call returns", async () => {
  const saved = []
  const out = await refresh({
    refresh: "old", clientId: "c", allowed: true,
    commit: async (t) => { saved.push(t.refresh) },
    fetchImpl: async () => ({ ok: true, json: async () => ({
      access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600 }) }),
  })
  assert.deepEqual(saved, ["new-refresh"])
  assert.equal(out.refresh, "new-refresh")
})

// ---- tokens this plugin did not mint, and will not replace -------------------------------------

test("an account whose access token has expired is not chosen", () => {
  // Skipping is recoverable. Refreshing to fix it is what rotates a token out from under the
  // process that owns refresh, and costs an account until a human logs in again.
  const a = [acct("A", { expiresAt: NOW - 1 }), acct("B", { expiresAt: NOW + 3600_000 })]
  assert.equal(choose(a, "gpt-5.5-medium", NOW).accountId, "B")
})

test("an account with no access token is never chosen", () => {
  assert.equal(choose([{ accountId: "A", refresh: "r" }], "gpt-5.5-medium", NOW), null)
})

test("a missing expiry is treated as usable, not as expired", () => {
  assert.equal(choose([acct("A")], "gpt-5.5-medium", NOW).accountId, "A")
})

test("`only` restricts the rotator to the accounts we are allowed to experiment on", () => {
  // One account can be re-authenticated on demand and the other not until
  // later, so the first live exercise is pinned to the recoverable one.
  const a = [acct("SAFE"), acct("DO-NOT-TOUCH")]
  assert.equal(choose(a, "gpt-5.5-medium", NOW, { only: ["SAFE"] }).accountId, "SAFE")
})

test("`only` still holds when every allowed account is blocked", () => {
  const a = [acct("SAFE", { rateLimitResetTimes: { "gpt-5.5": NOW + 60_000 } }), acct("OTHER")]
  assert.equal(choose(a, "gpt-5.5-medium", NOW, { only: ["SAFE"] }).accountId, "SAFE",
               "the fallback must not escape the allowlist")
})
