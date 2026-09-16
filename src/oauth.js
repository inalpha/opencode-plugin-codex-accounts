/**
 * Refreshing an access token, and the one way this plugin can destroy something irreplaceable.
 *
 * OPENAI ROTATES REFRESH TOKENS. The token endpoint may return a NEW `refresh_token`, and when it
 * does, the one you sent is dead the moment the response is written. Upstream reflects this:
 *
 *     const nextRefresh = json.refresh_token ?? refreshToken
 *
 * Two ways to lose an account permanently, both silent:
 *
 *   1. REFRESH AND DON'T PERSIST. The old token is already invalid; the new one is in a variable
 *      that goes out of scope. The account cannot authenticate again until a human re-runs the
 *      interactive login.
 *   2. TWO PROCESSES REFRESH AT ONCE. Both send the same refresh token, the provider honours one
 *      and invalidates it for the other. Whichever writes second persists a token that is already
 *      dead. This is not hypothetical here: `oc-codex-multi-auth` is live in the OpenCode server
 *      right now and refreshes on its own schedule.
 *
 * In practice one account may not be re-authenticatable on demand, so losing its refresh token is
 * an outage measured in hours, not seconds.
 *
 * So refreshing is OFF unless the caller proves it has somewhere durable to put the result and
 * says out loud that it means it. There is no default that refreshes. A prototype that reads the
 * live store and refreshes "just to test the path" is exactly the accident above.
 */

export const TOKEN_URL = "https://auth.openai.com/oauth/token"

export class RefreshRefused extends Error {}

/**
 * @param {object} o
 * @param {string} o.refresh        the current refresh token
 * @param {string} o.clientId
 * @param {(t:{access:string,refresh:string,expires:number}) => Promise<void>} o.commit
 *        Persists the result ATOMICALLY, before this function returns. Required: without it a
 *        rotated token is lost and the account is bricked.
 * @param {boolean} o.allowed       explicit opt-in; the caller states it holds the write lock.
 */
export async function refresh({ refresh, clientId, commit, allowed, fetchImpl = fetch }) {
  if (!allowed) {
    throw new RefreshRefused(
      "refresh is disabled. A refresh rotates the token and invalidates the old one, so it may " +
      "only run from the process that holds the accounts-file lock and will persist the result.")
  }
  if (typeof commit !== "function") {
    throw new RefreshRefused("refresh needs a commit() that durably stores the rotated token")
  }
  if (!refresh || !clientId) throw new RefreshRefused("refresh needs a token and a client id")

  const res = await fetchImpl(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refresh,
                                client_id: clientId }),
  })
  if (!res.ok) {
    // NOTHING IS WRITTEN ON A FAILURE, and the old token is left exactly as it was. A failed
    // refresh usually means the token is already spent — recording a half-result on top of that
    // would replace a recoverable state with an unrecoverable one.
    throw new Error(`token refresh failed: ${res.status}`)
  }
  const json = await res.json()
  const next = {
    access: json.access_token,
    // `?? refresh` is the whole hazard in one operator: when the provider rotates, this is the
    // only copy of the new token that will ever exist.
    refresh: json.refresh_token ?? refresh,
    expires: Date.now() + (json.expires_in ?? 0) * 1000,
  }
  if (!next.access || !next.refresh) throw new Error("token refresh returned an unusable result")
  await commit(next)          // BEFORE returning. A caller that forgets cannot brick the account.
  return next
}
