# Changelog

## 0.2.3 (2026-11-26), development release

- Fixed: long sessions whose collapsed evaluation history exceeds `maxStateTokens` (upstream: "history too large for Jev") could never be evaluated; Jev fell back to native compaction forever. `fitState` now ends in a `bounded window` stage: the state keeps the first entry, the oldest entries carrying undecided candidate calls (up to the token budget), an omission marker, and the pinned recent tail. `compact()` asks only about calls represented in the window; the rest are flagged `windowed_out` — kept untouched, never marked evaluated — so later runs evaluate them (guaranteed forward progress). Sessions that fit the ordinary stages are unaffected; the pinned-tail-only failure still throws (fail-open unchanged).
- Diagnostics: `/jev-stats` now labels the per-run context figures as evaluation snapshots (not the primary model's context) and the cumulative removed tokens as per-request accounting rather than proven savings.
- Tests: bounded-window unit tests, a 60k/150k/300k/550k-token matrix through `compact()` with mocked Jev, plugin-level large-session, multi-run drain, API-failure fallback and native-compaction regression tests.

## 0.2.2 (2026-11-25), development release

- The plugin version is shown in `/jev-status`, `/jev-stats`, the TUI sidebar, the Desktop pill (Version row), the snapshot (`version`) and the CLI. It is read from the plugin's own `package.json`.

## 0.2.1 (2026-11-25), development release

- Fixed: evaluations could never trigger in real sessions. The trigger compared a message-only character estimate (which excludes the system prompt, instructions and tool definitions, and undercounts code) with the threshold; in a real session the estimate stayed near 58% of the provider-reported context. The trigger now uses the provider-reported context of the previous step (uncached + cached input) plus estimated growth, falling back to the estimate until the first report. Thresholds and defaults are unchanged. See `docs/TRIGGER.md`.
- Evaluation diagnostics in `/jev-status`, `/jev-stats`, the TUI sidebar, the Desktop pill and the CLI: structured reason codes (disabled, waiting for threshold or growth, cooldown, no eligible or changed tool calls, budget, authentication, evaluating, failed, insufficient reduction, pruning active), provider-reported vs estimated context, threshold, growth, cooldown remaining, eligible and pinned tool results, last check and last sanitized error. Persisted per session; numbers and codes only.
- New counter: evaluation attempts.
- Benchmark collector: subagent sessions are discovered recursively via `?parentID=` (the previous `/children` route doesn't exist in OpenCode 2.2.7 and its error was ignored); retrieval errors now abort; unreported provider cost is `null` (unknown) instead of 0; session-level totals are reported next to the per-message sums.
- Tests: trigger regression tests through the context hook, and an opt-in local replay of an exported session.
- Known limitations: real-world cost savings are unmeasured; negative reduction statistics seen in some sessions are not yet explained.

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
