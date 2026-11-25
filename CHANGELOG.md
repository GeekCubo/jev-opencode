# Changelog

## 0.1.0 (2026-11-25), initial development release

First OpenCode port of [fast-jev-compaction](https://github.com/tamaratran/fast-jev-compaction) (upstream `e3f262a`).

- Server plugin using OpenCode 2.2.7's documented `context` hook. Prunes stale tool calls and results in outgoing requests only.
- Protection rules for instructions, recent messages, edits and writes, plans and todos, instruction files, and recent failures. Integrity check for tool-call/result pairs.
- Active, dry-run and off modes, persisted per OpenCode service.
- TypeSafe Direct (`jev-1.14` sent as `jev-1.14.0`) and OpenCode Zen endpoints. Price table and cap, per-session and per-day budgets, cooldown and growth gates, bounded retries and timeouts.
- Seven commands (`/jev-status`, `/jev-stats`, `/jev-compact`, `/jev-reset`, `/jev-enable`, `/jev-dry-run`, `/jev-disable`) in the TUI and Desktop, through a typed plugin RPC. Normal toasts and dialogs; no error banners on success.
- Status indicators: welcome-screen label (TUI and Desktop), TUI sidebar section, Desktop status pill.
- Statistics that separate measured from estimated figures; CLI snapshot reader.
- Capability detection: Jev disables itself safely when OpenCode lacks the required hook.
- Fix: spend and counters are accumulated with read-modify-write in shared plugin storage, so instances serving different project locations no longer overwrite each other's daily spend. Session spend persists across plugin reloads. See docs/ACCOUNTING.md.
- Fix: the API key file and statistics snapshot honour `XDG_CONFIG_HOME` and `XDG_STATE_HOME`, like OpenCode.
- Fix: the prebuilt Desktop bundle is tracked in Git even when a global gitignore excludes `dist/`.
