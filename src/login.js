/**
 * Interactive login — the one thing that can put a NEW credential in the store.
 *
 * This is the last piece upstream held that we actually needed. Everything else this plugin does is
 * choosing among tokens somebody already minted (see index.js); this is where a token comes from
 * when there is no usable one left — a refresh token revoked, an account added, a password changed.
 *
 * Authorization code + PKCE, exactly the flow the Codex CLI uses, because the provider only honours
 * its own OAuth client. The parameters are matched against the shipped implementation rather than
 * guessed: `response_type=code`, `code_challenge_method=S256`, the loopback redirect on port 1455
 * at /auth/callback, scope "openid profile email offline_access", and the two Codex-specific flags
 * (`codex_cli_simplified_flow`, `id_token_add_organizations`) plus `originator=codex_cli_rs`.
 *
 * WHY PKCE AND STATE ARE NOT OPTIONAL HERE. The redirect lands on a loopback port that any local
 * process may connect to. `state` is compared before the code is spent, so another process cannot
 * feed us its own authorization code; the verifier never leaves this process, so a code intercepted
 * on the way to the callback cannot be exchanged by whoever intercepted it.
 *
 * WHAT IT WILL NOT DO: touch an existing row. It returns a credential and stops. Deciding whether
 * that credential replaces an account, adds one, or is discarded belongs to the caller, because
 * getting that wrong overwrites a refresh token — the one loss on this box that cannot be undone
 * from here (one account may not be re-authenticatable on demand).
 */
import { createHash, randomBytes } from "node:crypto"
import { createServer } from "node:http"

export const AUTHORIZE_URL = "https://auth.openai.com/oauth/authorize"
export const TOKEN_URL = "https://auth.openai.com/oauth/token"
export const CALLBACK_PORT = 1455
export const CALLBACK_PATH = "/auth/callback"
export const SCOPE = "openid profile email offline_access"
export const REDIRECT_URI = `http://localhost:${CALLBACK_PORT}${CALLBACK_PATH}`

const b64url = (buf) => buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")

export function pkce() {
  const verifier = b64url(randomBytes(64))          // 86 chars, inside the 43–128 the RFC allows
  return { verifier, challenge: b64url(createHash("sha256").update(verifier).digest()) }
}

export function authorizeUrl({ clientId, challenge, state, prompt = null }) {
  const url = new URL(AUTHORIZE_URL)
  const p = url.searchParams
  p.set("response_type", "code")
  p.set("client_id", clientId)
  p.set("redirect_uri", REDIRECT_URI)
  p.set("scope", SCOPE)
  p.set("code_challenge", challenge)
  p.set("code_challenge_method", "S256")
  p.set("state", state)
  p.set("codex_cli_simplified_flow", "true")
  p.set("id_token_add_organizations", "true")
  p.set("originator", "codex_cli_rs")
  if (prompt) p.set("prompt", prompt)
  return url.toString()
}

/** The account this credential belongs to, from the id_token. Never trusted for authorisation —
 *  only used to decide WHICH ROW in the store the credential is about. */
export function accountIdFrom(idToken) {
  try {
    const claims = JSON.parse(Buffer.from(String(idToken).split(".")[1], "base64url").toString())
    const auth = claims["https://api.openai.com/auth"] || {}
    return auth.chatgpt_account_id || claims.chatgpt_account_id
        || (Array.isArray(auth.organizations) && auth.organizations[0]?.id) || null
  } catch { return null }
}

/** Waits for the provider to redirect back. Loopback only — it must never accept a remote caller. */
export function awaitCallback({ state, timeoutMs = 300_000 } = {}) {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url, `http://localhost:${CALLBACK_PORT}`)
      if (url.pathname !== CALLBACK_PATH) { res.writeHead(404); return res.end() }
      const code = url.searchParams.get("code")
      const got = url.searchParams.get("state")
      const ok = code && got === state
      res.writeHead(ok ? 200 : 400, { "Content-Type": "text/plain" })
      res.end(ok ? "Signed in. You can close this tab." : "Login failed; nothing was stored.")
      clearTimeout(timer); server.close()
      // A MISMATCHED STATE IS NOT A RETRY, it is another process answering our callback. Fail.
      ok ? resolve(code) : reject(new Error("callback rejected: state mismatch or missing code"))
    })
    const timer = setTimeout(() => { server.close(); reject(new Error("login timed out")) }, timeoutMs)
    server.on("error", reject)
    server.listen(CALLBACK_PORT, "127.0.0.1")
  })
}

export async function exchange({ code, verifier, clientId, fetchImpl = fetch }) {
  const res = await fetchImpl(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code", code, redirect_uri: REDIRECT_URI,
      client_id: clientId, code_verifier: verifier,
    }),
  })
  if (!res.ok) throw new Error(`authorization code exchange failed: ${res.status}`)
  const json = await res.json()
  if (!json.access_token || !json.refresh_token) {
    throw new Error("exchange returned no usable credential")
  }
  return {
    access: json.access_token,
    refresh: json.refresh_token,
    expires: Date.now() + (json.expires_in ?? 0) * 1000,
    accountId: accountIdFrom(json.id_token),
  }
}

/** The whole flow. Returns a credential; stores nothing. */
export async function login({ clientId, open, prompt = null }) {
  if (!clientId) throw new Error("login needs the OAuth client id")
  const { verifier, challenge } = pkce()
  const state = b64url(randomBytes(24))
  const url = authorizeUrl({ clientId, challenge, state, prompt })
  const waiting = awaitCallback({ state })
  if (open) await open(url); else console.log(`Open this to sign in:\n${url}`)
  return exchange({ code: await waiting, verifier, clientId })
}
