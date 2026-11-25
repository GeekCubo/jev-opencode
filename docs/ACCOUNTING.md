# Statistics and spend accounting

## Where figures live

| Figure | Scope | Storage |
|---|---|---|
| Global mode | the OpenCode service (all projects) | OpenCode plugin storage |
| Per-session mode overrides | one session | accounting file |
| Today's spend | all projects and processes of this user | accounting file (`days`) |
| Session spend | one session | accounting file (`sessions[id].spentUSD`) |
| Per-session statistics: evaluations, applied, dry-run, failed, tokens removed, requests pruned, Jev tokens, native compactions, resets, primary-model usage and cache tokens, last successful evaluation | one session | accounting file (`sessions[id]`) |
| Overall statistics | all sessions | accounting file (`counters`) |
| Pruning decisions currently applied | one session | **memory only**; cleared on reload, `/jev-reset`, mode change or native compaction |
| CLI snapshot `stats.json` | copy of the accounting file plus the writer's in-memory decision counts | written on change; informational |

- **Location.** The accounting file is `$XDG_STATE_HOME/opencode-jev/ledger.json` (default `~/.local/state/opencode-jev/ledger.json`; override it with `JEV_LEDGER_FILE`). Its mode is 600, inside a 700 directory.
- **Contents.** Numbers, UTC dates, session IDs and mode names only: no conversation content, keys or tool output.
- **Retention.** Day entries older than 60 days, and sessions idle for 90 days without an override, are removed.
- **Day boundary.** The daily limit resets at 00:00 **UTC**.
- **Separate installations.** Installations with a different `XDG_STATE_HOME` have separate accounting.
- **Measured vs estimated.**
  - Measured: Jev input tokens (`usage.input_tokens` from TypeSafe); coding-model tokens, cost and cache tokens (from OpenCode step events).
  - Estimated: all dollar figures for Jev (tokens × list price, not read from a bill); context and "tokens removed" figures (character-based).

## Concurrency

Every change is an atomic read-modify-write under an exclusive lock file (`ledger.json.lock`, created with `O_EXCL`), followed by an atomic rename. This works across plugin instances (one per project location) and across processes.

- **Budget reservation.** Before each Jev HTTP request, its estimated cost is reserved in the file. The check `spent + reservations + cost ≤ limit` and the reservation happen in one locked update, so parallel batches, concurrent sessions and other projects cannot overshoot a limit together.
- **Settlement.** A reservation is released when the attempt ends (success, failure or timeout). Measured spend is recorded once per successful response; retries never double-count.
- **Crash recovery.** Reservations older than 10 minutes are treated as abandoned and dropped. A lock file older than 30 s is treated as left by a crashed process and removed.
- **Tested.** Four OS processes doing 800 concurrent increments lose none; two instances share one daily total; parallel reservations stay within a limit (`tests/accounting.test.ts`).

## Limits

`budget.perDayUSD` and `budget.perSessionUSD` are numbers (USD) or `null` (unlimited). Spend is tracked either way. When a limit is reached, new evaluations stop, pruning already decided for a session keeps being applied, and coding continues.

## Remaining limitations

- **Successful responses only.** Spend is recorded from successful responses. Timed-out or failed attempts add nothing; if TypeSafe bills any of these, local totals under-count. The TypeSafe bill is the source of truth.
- **Counters written within ~1 s.** Statistics are flushed within about 1 s, and on clean unload; a killed process can lose up to 1 s of counter updates. Spend and reservations are written immediately.
- **Synchronous file I/O.** The lock is taken with synchronous I/O, which briefly blocks the plugin's event loop (normally microseconds; up to the 5 s lock timeout if another process holds it). If the lock can't be taken, the evaluation is skipped and the request goes out unpruned.
- **Local filesystem only.** The lock assumes a local filesystem. Network filesystems that don't honour `O_EXCL` are not supported.
- **Earlier history.** Figures from before 0.2.0 (in plugin storage) are migrated once, only if the file has no entry for that day yet. Spend lost to the earlier overwrite defect cannot be recovered.

## History

- 0.1.0 fixed instances overwriting each other in OpenCode plugin storage, using a best-effort read-modify-write.
- 0.2.0 replaced it with the locked accounting file above, removing the remaining race, and added persistent per-session statistics.
