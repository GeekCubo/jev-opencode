# Changelog

## 0.2.0 (2026-11-25), development release

- Shared accounting file with an exclusive lock, so no updates are lost across projects or processes. Atomic budget reservations with release on completion or failure and recovery from abandoned reservations; mode 600; numbers only.
- Per-session statistics persist across plugin reloads and restarts: evaluations, applied, dry-run and failed runs, tokens removed, requests pruned, Jev tokens and cost, last successful evaluation, native compactions, resets, and coding-model and cache usage. The TUI, Desktop, `/jev-stats` and CLI read the same source.
- Optional spending limits: `budget.perDayUSD` and `budget.perSessionUSD` accept `null` for unlimited. Defaults are unchanged; spend is always tracked.
- Per-session mode overrides: `/jev-session-enable`, `/jev-session-dry-run`, `/jev-session-disable`, `/jev-session-inherit`. They persist and never affect other sessions; the config kill switch still wins. Indicators show the mode's source.
- Status text and indicators now show `Unlimited` limits and the global and session modes separately.

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
