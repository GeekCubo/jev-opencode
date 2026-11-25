# Evaluation trigger (0.2.1)

## What changed

Before 0.2.1, Jev compared a character-based estimate of the conversation messages (~3.6 chars/token) with the threshold. That estimate excludes the system prompt, AGENTS.md and tool definitions, and undercounts code and shell output. In a real 37-step coding session the provider reported 66k–83k tokens of context while the estimate peaked at ~48k, so a 60k threshold was never reached and Jev never evaluated.

From 0.2.1 the trigger uses the context the provider reported for the session's previous step (uncached input + cache read + cache write, from OpenCode's `session.step.ended` event) plus the estimated growth since that step. Until the provider has reported once (first request of a session), the estimate is used. The figure is persisted, so a plugin reload resumes from it. A native compaction clears it.

Unchanged: thresholds and their defaults, growth and cooldown gates, protection rules, fail-open behaviour, session modes and budgets.

## Diagnostics

`/jev-status`, `/jev-stats`, the TUI sidebar, the Desktop pill and `plugin/cli.ts` show, per session:

| Field | Meaning |
|---|---|
| reason | structured code below |
| providerContextTokens | last provider-reported context (null until reported) |
| estimatedContextTokens | message-only estimate of what was sent |
| triggerContextTokens / thresholdTokens | figure compared with the threshold |
| growthTokens / minGrowthTokens | growth since the last evaluation |
| cooldownRemainingMs | time until the cooldown allows another evaluation |
| eligibleResults / protectedResults | tool results Jev may evaluate vs. pinned (protected tools, recent messages, already evaluated) |
| eligible | every gate passed on the last check |
| checkedAt, lastError, lastErrorAt | last check; last sanitized error |

Counters: evaluation attempts, successful evaluations, failures, applied runs and pruned outgoing requests.

| Code | Label |
|---|---|
| `disabled` | Disabled |
| `waiting_threshold` | Waiting for context threshold |
| `waiting_growth` | Waiting for context growth |
| `cooldown` | Cooldown |
| `no_eligible_results` | No eligible tool results |
| `no_new_tool_calls` | No changed tool calls |
| `budget_exhausted` | Budget exhausted |
| `auth_unavailable` | Authentication unavailable |
| `concurrency_limit` | Waiting for another evaluation |
| `evaluating` | Evaluation in progress |
| `evaluation_failed` | Evaluation failed |
| `insufficient_reduction` | Evaluated, insufficient reduction |
| `evaluated_dry_run` | Evaluated (dry-run, not applied) |
| `pruning_active` | Pruning active (also shown between evaluations while decisions are applied) |

Diagnostics hold numbers, codes and sanitized error text only; no content, keys or tool output.

## Replay

`tests/replay.test.ts` replays an exported session (`GET /api/session/:id/message`) through the plugin's context hook with a mocked Jev, locally:

```sh
REPLAY_MSGS=/path/to/messages.json REPLAY_OPTIONS='{"mode":"active",...}' npx vitest run tests/replay.test.ts
```
It is skipped unless `REPLAY_MSGS` is set. Keep exported transcripts outside the repository.
