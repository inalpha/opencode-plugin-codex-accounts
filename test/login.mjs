/**
 * The login flow, tested without a browser or the provider.
 *
 * The parts worth pinning are the ones that protect a loopback callback any local process can
 * reach, and the exchange refusing to hand back half a credential.
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { pkce, authorizeUrl, accountIdFrom, exchange, REDIRECT_URI, SCOPE } from "../src/login.js"

test("the PKCE challenge is the S256 hash of the verifier", () => {
  const { verifier, challenge } = pkce()
  const expected = createHash("sha256").update(verifier).digest("base64")
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
  assert.equal(challenge, expected)
  assert.ok(verifier.length >= 43 && verifier.length <= 128, "RFC 7636 length")
})

test("two logins never share a verifier", () => {
  assert.notEqual(pkce().verifier, pkce().verifier)
})

test("the authorize URL carries what the provider requires", () => {
  const u = new URL(authorizeUrl({ clientId: "cid", challenge: "chal", state: "st" }))
  assert.equal(u.origin + u.pathname, "https://auth.openai.com/oauth/authorize")
  assert.equal(u.searchParams.get("response_type"), "code")
  assert.equal(u.searchParams.get("code_challenge_method"), "S256")
  assert.equal(u.searchParams.get("code_challenge"), "chal")
  assert.equal(u.searchParams.get("state"), "st")
  assert.equal(u.searchParams.get("redirect_uri"), REDIRECT_URI)
  assert.equal(u.searchParams.get("scope"), SCOPE)
  // Codex-specific: without these the provider issues a token the Codex backend will not accept.
  assert.equal(u.searchParams.get("originator"), "codex_cli_rs")
  assert.equal(u.searchParams.get("codex_cli_simplified_flow"), "true")
  assert.equal(u.searchParams.get("id_token_add_organizations"), "true")
})

test("the verifier is never put in the authorize URL", () => {
  // It is the secret half of PKCE. Leaking it into the URL defeats the whole exchange.
  const { verifier, challenge } = pkce()
  assert.ok(!authorizeUrl({ clientId: "c", challenge, state: "s" }).includes(verifier))
})

test("the redirect is loopback", () => {
  assert.equal(new URL(REDIRECT_URI).hostname, "localhost")
})

const idToken = (claims) =>
  "h." + Buffer.from(JSON.stringify(claims)).toString("base64url") + ".s"

test("the account id is read from the Codex claim", () => {
  assert.equal(accountIdFrom(idToken({ "https://api.openai.com/auth": { chatgpt_account_id: "acc-1" } })),
               "acc-1")
})

test("it falls back to the first organization, then to nothing", () => {
  assert.equal(accountIdFrom(idToken({ "https://api.openai.com/auth": { organizations: [{ id: "org-9" }] } })),
               "org-9")
  assert.equal(accountIdFrom(idToken({})), null)
  assert.equal(accountIdFrom("not-a-jwt"), null, "a malformed token must not throw")
})

test("an exchange missing a refresh token is refused, not half-stored", () => {
  // Storing an access token with no refresh token produces an account that works until it quietly
  // stops and cannot be recovered without another interactive login.
  return assert.rejects(() => exchange({
    code: "c", verifier: "v", clientId: "id",
    fetchImpl: async () => ({ ok: true, json: async () => ({ access_token: "a" }) }),
  }), /no usable credential/)
})

test("a failed exchange throws and returns nothing", () => {
  return assert.rejects(() => exchange({
    code: "c", verifier: "v", clientId: "id",
    fetchImpl: async () => ({ ok: false, status: 400 }),
  }), /exchange failed: 400/)
})

test("a good exchange carries the verifier and returns a whole credential", async () => {
  let sent
  const out = await exchange({
    code: "the-code", verifier: "the-verifier", clientId: "id",
    fetchImpl: async (_u, init) => {
      sent = new URLSearchParams(init.body)
      return { ok: true, json: async () => ({
        access_token: "a", refresh_token: "r", expires_in: 3600,
        id_token: idToken({ "https://api.openai.com/auth": { chatgpt_account_id: "acc-7" } }) }) }
    },
  })
  assert.equal(sent.get("grant_type"), "authorization_code")
  assert.equal(sent.get("code_verifier"), "the-verifier")
  assert.equal(sent.get("redirect_uri"), REDIRECT_URI)
  assert.deepEqual({ access: out.access, refresh: out.refresh, accountId: out.accountId },
                   { access: "a", refresh: "r", accountId: "acc-7" })
})
