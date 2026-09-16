/** A read-only exercise against the LIVE accounts file. Writes nothing, refreshes nothing. */
import { createStore } from "../src/store.js"
import { createRotator } from "../src/index.js"

const SAFE = process.env.CODEX_ACCOUNTS_ONLY ? process.env.CODEX_ACCOUNTS_ONLY.split(",") : null
const store = createStore()                       // shadow by default
const rotator = createRotator(store, { only: SAFE })

const rows = store.read()
const now = Date.now()
console.log(`  accounts read: ${rows.length}   (store.writable = ${store.writable})`)
for (const r of rows) {
  const live = Object.values(r.rateLimitResetTimes || {}).filter((v) => v > now)
  console.log(`    ${r.accountId.slice(0, 8)}…  token=${r.access ? "present" : "MISSING"}` +
              `  expires_in=${r.expiresAt ? ((r.expiresAt - now) / 86400000).toFixed(1) + "d" : "?"}` +
              `  live_blocks=${live.length}`)
}
for (const model of ["gpt-5.5-medium", "gpt-5.6-terra"]) {
  const pick = rotator.authorize(model)
  console.log(`  authorize(${model}) -> ${pick ? pick.accountId.slice(0, 8) + "…" : "none"}`
            + `${pick ? "  token=" + (pick.access ? "present" : "MISSING") : ""}`)
}
// A simulated 429, to prove the shadow path records instead of writing.
const pick = rotator.authorize("gpt-5.5-medium")
if (pick) {
  rotator.observe("gpt-5.5-medium", pick.accountId, 429, new Headers({ "retry-after": "300" }))
  console.log("  after a simulated 429, recorded (not written):",
              JSON.stringify(store.decisions()))
}
