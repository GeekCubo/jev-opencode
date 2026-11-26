# jev-compaction

Jev Compaction for [OpenCode](https://opencode.ai): trims stale tool output from the context sent to your coding model, using [TypeSafe](https://typesafe.ai)'s Jev evaluation model. Instructions, conversation text and recent work are kept verbatim, and OpenCode's stored history is never modified.

**Requires OpenCode v2.2.7 or newer.** Owner-confirmed working on OpenCode v2.4.2.

Jev evaluations use a **remote** service (TypeSafe Direct or OpenCode Zen) and need your own TypeSafe API key; they are billed separately from your coding-model provider. Real-world cost savings have not been measured.

## Install

1. Store your key (never in `opencode.jsonc`):

   ```sh
   umask 077
   printf '%s' 'YOUR_TYPESAFE_KEY' > ~/.config/opencode/typesafe-api-key
   ```

2. Add the plugin to the `plugins` array of your global `~/.config/opencode/opencode.jsonc`:

   ```jsonc
   "plugins": [
     { "package": "jev-compaction", "options": { "mode": "dry-run" } }
   ]
   ```

   Use `"jev-compaction@0.3.0"` to pin this release.

3. Run `/reload` in the TUI (or reopen the Desktop window), then `/jev-status`.

OpenCode installs the package itself; no clone, build or separate service is needed. The Desktop bundle is included.

## Commands

`/jev-status`, `/jev-stats`, `/jev-enable`, `/jev-dry-run`, `/jev-disable`, `/jev-reset`, `/jev-compact`, session overrides (`/jev-session-*`), `/jev-health`, `/jev-handover` and the optional agent-configuration assistant `/jev-setup` (preview and explicit approval; edits keep your JSONC comments and every unrelated setting; timestamped backup first).

## More

Configuration, privacy and data flow, troubleshooting, uninstall and known limitations: [github.com/GeekCubo/jev-opencode](https://github.com/GeekCubo/jev-opencode).

OpenCode port of [fast-jev-compaction](https://github.com/tamaratran/fast-jev-compaction) (MIT). Maintained by GeekCubo; MIT license (see `LICENSE` and `NOTICE`). Not affiliated with or endorsed by OpenCode, TypeSafe or the upstream author.
