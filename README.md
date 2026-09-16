# opencode-plugin-codex-accounts

Codex multi-account rotation, written once and hooked twice — **`setup()` for OpenCode v2,
`server()` for v1** — so it can be proven on the version we run today and carried across unchanged.

**Status: prototype. It is NOT in `~/.config/opencode/opencode.json` and is not loaded.**

## Why it exists

OpenCode stores exactly one credential per provider, in **both** versions. From the v2 source
(`packages/opencode/src/auth/index.ts`):

```ts
readonly get: (providerID: string) => Effect.Effect<Info | undefined, AuthError>
```

`Info` is a single `Oauth | Api | WellKnown`, not a list. Five feature requests asking for
multi-account rotation (#5748, #8591, #9068, #11830, #29085) are **all closed**, with nothing in
the source behind them. So rotation stays a plugin's job in v2 — and `oc-codex-multi-auth`, which
does it for us today, mentions v2 nowhere and carries a local patch of ours.

## Stick, then rotate

Not round-robin. One account serves until it is exhausted, then the next takes over, then the
first again when its window reopens. Measured 2026-09-16: *"we are not supposed to keep rotating.
Only when one account is exhausted, we will rotate to the next. that was the design."*

The reason matters, because the first draft got it wrong and balanced across accounts: spreading
requests puts **both** five-hour windows into a partially-spent state at the same time, so the org
loses all Codex capacity at once instead of losing half and carrying on. Draining one keeps the
other whole, and a whole account is what you fall back onto.

## What it is not

No TUI, no diagnostics, no recovery tools, and no background token refresh. That is most of
upstream's ~30,000 lines and none of it is why we depend on them.

## Login

`src/login.js` is the authorization-code + PKCE flow the Codex CLI uses — the one thing upstream
held that we genuinely needed, for when there is no usable token left (a refresh token revoked, an
account added, a password changed).

Parameters are matched against the shipped implementation rather than guessed, including the
Codex-specific `codex_cli_simplified_flow`, `id_token_add_organizations` and
`originator=codex_cli_rs`; without those the provider issues a token the Codex backend rejects.

It **returns a credential and stores nothing.** Deciding whether that credential replaces a row,
adds one, or is discarded belongs to the caller — getting it wrong overwrites a refresh token, the
one loss here that cannot be undone.

**The client id is not in this repo.** Pass it in. It is OpenAI's public Codex OAuth client, read
at call time from wherever the operator keeps it.

## The refresh-token hazard

**OpenAI rotates refresh tokens.** A refresh may return a new one, and the token you sent dies the
moment it does. Two ways to lose an account permanently, both silent:

1. refresh and fail to persist the result;
2. two processes refresh at once — the provider honours one and invalidates it for the other.

Both are live risks here: `oc-codex-multi-auth` is running in the OpenCode server and refreshes on
its own schedule. So `oauth.js` **refuses to refresh** unless the caller passes `allowed: true` and
a `commit()` that durably stores the rotated token, and it commits *before* returning. There is no
default that refreshes.

## Layout

| file | what it holds |
|---|---|
| `src/accounts.js` | the decisions, pure — selection, limit parsing, blocking, stale release |
| `src/oauth.js` | refresh, guarded (see above) |
| `src/index.js` | `createRotator` + the v1 and v2 adapters |
| `test/decisions.mjs` | 16 tests, each one an incident that actually happened |

`npm test` — no network, no clock, no OpenCode.
