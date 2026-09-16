/**
 * The v2 entrypoint: `Plugin.define({ id, setup })` as a DEFAULT export.
 *
 * Kept apart from index.js because v1 must not import `@opencode/plugin` — that package does not
 * exist in a v1 install, and an import that throws at load time is a plugin that takes the whole
 * server's plugin loading with it.
 */
import { Plugin } from "@opencode/plugin"
import { createStore } from "./store.js"
import { setup as install } from "./index.js"

export default Plugin.define({
  id: "codex-accounts",
  setup(ctx) {
    // Shadow unless told otherwise. The safe path is the default one; see store.js.
    const store = createStore({ writable: process.env.CODEX_ACCOUNTS_WRITABLE === "1" })
    const only = process.env.CODEX_ACCOUNTS_ONLY ? process.env.CODEX_ACCOUNTS_ONLY.split(",") : null
    install(ctx, store, { only })
  },
})
