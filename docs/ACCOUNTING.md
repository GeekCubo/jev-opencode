# Statistics and spend accounting

## Scope of each figure

| Figure | Scope | Persistence |
|---|---|---|
| Mode | the OpenCode service (all projects) | plugin storage |
| Today's spend, `spend/<UTC date>` | all projects on the service | plugin storage, accumulated with read-modify-write |
| Session spend, `session-spend/<sessionID>` | one session | plugin storage |
| Overall counters (`stats`) | all projects on the service | plugin storage, accumulated with read-modify-write |
| Per-session counters, and decisions shown in the sidebar/pill | one session, in memory | lost on plugin reload or service restart |
| Snapshot file `$XDG_STATE_HOME/opencode-jev/stats.json` | written by whichever plugin instance last flushed | overwritten; informational only |

Notes:
- **Several instances, one store.** OpenCode runs one plugin instance per project location. All instances on a service share the same plugin storage.
- **Day boundary.** The daily budget resets at 00:00 **UTC**.
- **Separate installations.** Independent OpenCode installations (a different `XDG_DATA_HOME`) have separate storage, so separate budgets.
- **Measured vs estimated.** Jev input tokens are measured from TypeSafe's `usage.input_tokens`. The dollar figures are tokens × list price (estimates). Context-token and savings figures are character-based estimates.

## Fixed in 0.1.0: instances overwrote each other's totals

Before 0.1.0, each instance loaded the daily total once at start-up, kept its own copy, and wrote that copy back. With several project locations on one service:
- the last writer replaced other instances' spend, so the daily total could go **down**;
- counters could go backwards;
- the session spend restarted at 0 after a plugin reload.

Daily and session budgets could therefore be under-enforced.

Now, `Ledger` (in `plugin/statistics.ts`) re-reads the stored value before every flush and adds only its own unflushed delta. Budget checks use the stored total plus pending spend, and session spend is persisted. `tests/accounting.test.ts` covers this; four of its five tests fail on the old code.

Within one instance, every Jev request reserves its estimated cost before it starts and releases the reservation when it ends. The parallel batches of one evaluation, and concurrent sessions, therefore cannot overshoot a budget together.

Remaining limitations:
- **Not atomic across instances.** OpenCode's plugin storage offers no atomic increment, so two instances flushing within the same few milliseconds could still lose one delta. Reservations are also per instance: two project locations evaluating at the same moment can together exceed the daily budget by up to their in-flight requests.
- **Successful responses only.** Spend is recorded from successful responses (`usage.input_tokens`). Timed-out, aborted or failed attempts add nothing. If TypeSafe bills any of these, local totals under-count; check the TypeSafe bill.
- **Unflushed spend.** Spend is written to storage within about 2 s, and on clean unload. If the process is killed, up to 2 s of spend is not persisted.
- **Historical totals are not repaired.** Totals recorded before the fix are left as stored.
