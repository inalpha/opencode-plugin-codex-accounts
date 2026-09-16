/**
 * Codex multi-account rotation, written once and hooked twice.
 *
 * WHY THIS EXISTS. A deployment may reach Codex through two ChatGPT accounts, and OpenCode -- v1 AND v2 --
 * stores exactly ONE credential per provider. Checked in the v2 source rather than assumed:
 *
 *     readonly get: (providerID: string) => Effect.Effect<Info | undefined, AuthError>
 *
 * `Info` is a single Oauth | Api | WellKnown, not a list. Five feature requests asking for
 * multi-account rotation (#5748, #8591, #9068, #11830, #29085) are all closed with nothing in the
 * source behind them. So rotation is a plugin's job in v2 exactly as in v1, and the third-party
 * plugin we depend on today mentions v2 nowhere.
 *
 * WHY DUAL MODE. The v2 migration guide is explicit that "V1 plugin implementations do not run in
 * V2", and equally explicit that one file may export both. That is what makes this migratable
 * rather than a rewrite: the decisions in `accounts.js` are shared, and only the seam differs.
 *
 *   v1: the provider's `auth.loader`, which hands us the fetch used for that provider.
 *   v2: `http.request` and `http.response` hooks, which see the same traffic by name.
 *
 * Proving it on v1 first is the point. A rotator that is only exercised on the day we cut over is
 * a rotator nobody has tested.
 *
 * IT NEVER MINTS A CREDENTIAL. It chooses among access tokens somebody else already wrote, and
 * writes none back. Measured 2026-09-16: "see if you can use the same access token or something so
 * that the refresh token reused kind of error can be avoided." Measured: the stored access tokens
 * are good for 8.9 and 5.4 DAYS, so there is nothing to mint -- whoever owns refresh keeps the file
 * fresh and this reads it. That single decision is what makes it safe to run BESIDE the plugin that
 * does own refresh, instead of racing it for a rotating token.
 *
 * Also absent, and for the same reason it is 432 lines rather than 30,000: interactive login, TUI,
 * diagnostics, recovery tools. None of them are why we depend on upstream.
 */
import { choose, readLimits, blockFrom, releaseContradictedBlocks, familyOf } from "./accounts.js"

const CODEX_HOST = "chatgpt.com"

/** The shared decision core. `store` supplies persistence; nothing here does I/O itself. */
export function createRotator(store, { now = () => Date.now(), only = null } = {}) {
  return {
    /** Which account and token should serve this request; null to leave the request untouched. */
    authorize(model) {
      const accounts = store.read()
      const picked = choose(accounts, model, now(), { only })
      if (!picked) return null
      return { account: picked, accountId: picked.accountId, access: picked.access }
    },

    /** What the provider just told us. Returns what changed, for logging and for tests. */
    observe(model, accountId, status, headers, retryAfterMs) {
      const observed = readLimits(headers)
      return store.update(accountId, (account) => {
        let blocks = account.rateLimitResetTimes || {}
        if (status === 429 || (observed && observed.leftPercent <= 0)) {
          blocks = blockFrom({ ...account, rateLimitResetTimes: blocks }, model, observed,
                             now(), retryAfterMs)
        } else if (observed) {
          // The provider contradicted what we believed. This is the ONLY path that shortens a
          // block, and it needs a positive reading to fire -- see accounts.js.
          blocks = releaseContradictedBlocks({ ...account, rateLimitResetTimes: blocks },
                                             observed, now())
        }
        return { ...account, rateLimitResetTimes: blocks, lastUsedAt: now() }
      })
    },
  }
}

function isCodex(url) {
  try { return new URL(String(url)).hostname.endsWith(CODEX_HOST) } catch { return false }
}

// ------------------------------------------------------------------ v2
//
// Written against the SHIPPED TYPES in @opencode/plugin@2.0.3, not against the prose docs. The
// first draft was built from a summary of the docs and v2 silently refused to load it -- `plugin
// list` said "No plugins found" while `debug config` showed the entry being read. Two things the
// summary did not say:
//
//   * the default export must be `Plugin.define({ id, setup })`. A named `setup` export is not a
//     plugin; nothing errors, it simply is not one.
//   * `SessionHttpRequest` carries no request id. It carries `request: Request`, and the matching
//     `SessionHttpResponse` carries the SAME object, so correlation is by object identity. A
//     `requestID` field, which the first draft keyed on, does not exist.
//
// `ctx.session.hook(name, cb)` and the names "http.request" / "http.response" were right.

/** @param ctx @param store @param opts — separated so the hooks can be tested without a server. */
export function setup(ctx, store, opts) {
  const rotator = createRotator(store, opts)
  // Keyed on the Request object itself, and WEAK so an abandoned request cannot leak. A Map here
  // grows for the life of the process every time a response is dropped.
  const inflight = new WeakMap()

  ctx.session.hook("http.request", (event) => {
    if (!isCodex(event.request?.url)) return
    const model = event.model?.id || ""
    const pick = rotator.authorize(model)
    if (!pick) return                 // nothing usable: leave OpenCode's own credential in place
    inflight.set(event.request, { model, accountId: pick.accountId })
    if (!store.writable) return       // SHADOW: decided and recorded, request untouched
    event.request.headers.set("authorization", `Bearer ${pick.access}`)
    if (pick.accountId) event.request.headers.set("chatgpt-account-id", pick.accountId)
  })

  ctx.session.hook("http.response", (event) => {
    const seen = inflight.get(event.request)
    if (!seen) return
    inflight.delete(event.request)
    const retry = parseFloat(event.response?.headers?.get?.("retry-after"))
    rotator.observe(seen.model, seen.accountId, event.response?.status,
                    event.response?.headers, Number.isFinite(retry) ? retry * 1000 : undefined)
  })

  return rotator
}

// ------------------------------------------------------------------ v1
export function server(store, opts) {
  const rotator = createRotator(store, opts)
  return {
    auth: {
      provider: "openai",
      loader: async (getAuth, provider) => ({
        async fetch(input, init) {
          const url = typeof input === "string" ? input : input?.url
          if (!isCodex(url)) return fetch(input, init)
          const model = init?.__model || provider?.modelID || ""
          const pick = rotator.authorize(model)
          const opts = { ...init, headers: new Headers(init?.headers || {}) }
          // SHADOW: decide, record, change nothing. The comparison we want is "would this rotator
          // have picked what the live plugin picked?", and you cannot ask that by taking over the
          // request -- then there is nothing to compare against.
          if (pick && store.writable) {
            opts.headers.set("authorization", `Bearer ${pick.access}`)
            if (pick.accountId) opts.headers.set("chatgpt-account-id", pick.accountId)
          }
          const res = await fetch(input, opts)
          if (pick) {
            const retry = parseFloat(res.headers.get("retry-after"))
            rotator.observe(model, pick.accountId, res.status, res.headers,
                            Number.isFinite(retry) ? retry * 1000 : undefined)
          }
          return res
        },
      }),
    },
  }
}

export { choose, readLimits, blockFrom, releaseContradictedBlocks, familyOf }
