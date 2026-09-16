/**
 * The entrypoint v2 actually loads — and it is the V1 SHAPE.
 *
 * This file was first written as `Plugin.define({ id, setup })`, which is what the v2 plugin docs
 * describe. v2 installed it, listed it, imported it cleanly... and never ran it. Reading the
 * loader settled why, and the answer is worth keeping because it inverts the obvious assumption:
 *
 *   packages/opencode/src/plugin/shared.ts  readV1Plugin()
 *       const value = mod.default
 *       if (mode === "detect" && !("id" in value) && !("server" in value) && !("tui" in value)) return
 *       const server = "server" in value ? value.server : undefined
 *
 *   packages/opencode/src/plugin/index.ts   applyPlugin()
 *       const plugin = readV1Plugin(load.mod, load.spec, "server", "detect")
 *       if (plugin) { ...; hooks.push(await plugin.server(input, load.options)); return }
 *       for (const server of getLegacyPlugins(load.mod)) hooks.push(await server(input, ...))
 *
 * Our default export had `id` but no `server`, so it passed the detect gate and then died calling
 * a function that was not there. And `getLegacyPlugins` — the other branch — iterates EVERY export
 * and throws "Plugin export is not a function" on anything that is not one, so a module exporting
 * helpers alongside its plugin fails there too.
 *
 * So: v2's IN-PROCESS SERVER PLUGINS ARE STILL V1-SHAPED. `Plugin.define({ id, setup })` belongs to
 * a different host — the RPC/TUI plugin runtime — not to this path. The practical consequence for
 * the migration is large and good: our existing v1 plugins are far closer to working on v2 than
 * "V1 plugin implementations do not run in V2" implies.
 */
import { createStore } from "./store.js"
import { server as v1server } from "./index.js"

export default {
  id: "codex-accounts",
  // `input` is the harness handle; `options` are the plugin's config options. Both are passed
  // through untouched — this file is a shape adapter and nothing else lives in it.
  server(_input, _options) {
    // Shadow unless told otherwise. The safe path is the default one; see store.js.
    const store = createStore({ writable: process.env.CODEX_ACCOUNTS_WRITABLE === "1" })
    const only = process.env.CODEX_ACCOUNTS_ONLY ? process.env.CODEX_ACCOUNTS_ONLY.split(",") : null
    return v1server(store, { only })
  },
}
