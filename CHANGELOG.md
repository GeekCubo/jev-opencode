# Changelog

## 0.3.0 (2026-11-26)

- Requires **OpenCode v2.2.7+**; owner-confirmed working on OpenCode v2.4.2.
- `/jev-setup` edits the configuration in place: comments, trailing commas, formatting, custom agents and every unrelated setting are preserved byte for byte; only approved `agent.<role>.model` values change (or approved agents are added). Every edit is verified before writing; invalid files are refused untouched. Previously, applying re-serialized the file and removed comments.
- npm package metadata (repository, homepage, license and notice files in the package, `engines.opencode`).

- Public installation: the plugin directory is now a publishable npm package (`jev-compaction`) with the exports map, `files` list and versioned metadata OpenCode's plugin loader resolves (`plugins: ["jev-compaction"]`); the prebuilt Desktop GUI bundle ships in `dist/`.
- Added: `/jev-setup`, an optional, provider-independent agent-configuration assistant — local, deterministic model recommendations (capabilities and known pricing only; unknown stays unknown), quality/balanced/economy presets plus custom overrides, explicit preview and approval, timestamped unique backups and atomic writes with rollback instructions. The default is **keep my existing configuration**; nothing changes without explicit approval, and Jev works fully without it.
- Added: `scripts/jev-activate.sh` / `scripts/jev-rollback.sh` — corrected local activation (the 0.2.4 script's `mv`-into-existing-directory defect installed nothing while reporting success). The new script validates the staged package and runtime files, installs by swap, verifies the *installed* version and file integrity, never overwrites backups, and rolls back on failure; nonzero exit on any failure.
- Budget accounting: reservations are per attempt (retries re-reserve), released after every attempt; measured usage is only recorded from successful responses, so transport failures leave usage unknown (charged conservatively at the estimate, never reported as measured). The local budget is a conservative estimate, not a guaranteed provider-side spending ceiling.
- Partial evaluation failures: a failed run (including partial batch failure) marks nothing evaluated; every undecided candidate stays eligible and is re-asked after the endpoint heals — no starvation, no unbounded retries.
- Diagnostics: logical batches vs network attempts vs retries are reported separately; retry attempts are not included in the 11-request worst-case run bound (documented).
- Tests: focused acceptance suites for budget/retry accounting (A1/A3), partial-failure lifecycle (A2), context-measurement separation (A4), the setup assistant (provider fixtures, presets, backup/rollback), the packed npm artifact (native install, contents, leak checks) and isolated activation/rollback (including the 0.2.4 defect scenario).

## 0.2.4 (2026-11-26), development release

- Added: session health monitoring (advisory only; Jev never compacts, resets or closes sessions automatically). Four levels — Healthy / Growing / Compaction recommended / New session recommended — computed locally from provider-reported or estimated primary context, the model's context window (utilisation), Jev evaluation-state size, eligibility, recent reduction effectiveness, consecutive failures/insufficient reductions and native-compaction history. Adaptive thresholds: absolute advisory defaults (100k/200k/300k/500k) scaled down for small model windows (25%/50%/75% of the window); optional overrides via `health` in the existing plugin options.
- Added: `/jev-health` (concise report; no inference requests) and `/jev-handover` (local-records continuation summary; explicitly no inference request, honest about missing facts; never includes credentials).
- Added: proactive non-blocking notifications on meaningful deterioration only (hysteresis + 30-minute re-notify cooldown, per-session state, reset after native compaction), delivered through the existing `changed` event + a new `drainNotification` RPC; TUI shows a toast, Desktop a toast with the pill tone reflecting health.
- Status indicators now include the health level: `Jev: Active · TypeSafe · Healthy`; `/jev-status` gains a health summary line; the snapshot RPC gains a `session.health` object.
- Diagnostics keep primary model context, evaluation-state tokens, eligibility, effectiveness and provider-reported figures clearly separated; cumulative removal is labelled per-request accounting, never savings.

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
