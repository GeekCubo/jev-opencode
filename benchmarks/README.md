# Real-world A/B benchmark protocol (pending)

Goal: measure whether Jev active mode lowers the total cost of real coding work (coding provider plus Jev) without lowering task quality. No results are published yet.

## Configurations

| | A: baseline | B: Jev |
|---|---|---|
| OpenCode | same version | same version |
| Coding model, provider, reasoning effort | identical | identical |
| Jev | plugin entry removed, or `mode: "off"` | `mode: "active"`, default thresholds |
| Native compaction | enabled (default) | enabled (default) |

The Jev mode is global to an OpenCode **service**, so different projects on one service are not isolated from each other. Use one of these:
- **Separate instances (preferred):** two independent OpenCode instances, each with its own `HOME`/`XDG_*` and its own service or `opencode serve --port`. A and B can then run in parallel.
- **Sequential runs on one instance:** switch the mode between runs and confirm it with `/jev-status` before each run.

## Controls

For every task, both runs use:
- the same starting commit, in separate `git worktree`s;
- identical prompts, given verbatim, with corrective prompts recorded separately;
- fresh sessions, and identical AGENTS.md, project instructions, tools, permissions and agent configuration;
- the same acceptance tests, run after the agent finishes.

To reduce nondeterminism and cache effects:
- run each task at least 3 times per configuration, alternating the order (A, B, B, A, …);
- don't reuse sessions;
- wait longer than the provider's cache lifetime between paired runs, or record the cache reads explicitly;
- report the spread across runs, not only the means.

## Measurements

Run after each session (read-only; makes no model or Jev requests):

```sh
OPENCODE_SERVER_PASSWORD=... node benchmarks/collect.mjs http://127.0.0.1:<port> <worktree> <sessionID> \
  --jev-stats <that instance's>/.local/state/opencode-jev/stats.json > results/<task>-<A|B>-<n>.json
```

| Metric | Source | Kind |
|---|---|---|
| Uncached input, cache-read, cache-write, output and reasoning tokens | OpenCode step data | measured (provider-reported) |
| Coding-model requests (including subagent sessions) | OpenCode messages | measured |
| Peak context | max(input + cache) per step | measured |
| Native compaction events | OpenCode messages | measured |
| Coding-provider cost | OpenCode `cost` (0 if the provider reports none) | measured, otherwise take it from the provider's bill |
| Jev evaluations and requests | plugin statistics | measured |
| Jev input tokens | TypeSafe `usage.input_tokens` | measured |
| Jev cost | tokens × list price | estimate; confirm against the TypeSafe bill |
| Context before/after pruning | plugin statistics | estimate |
| Runtime | wall clock | measured |
| Tests passed, task completed, regressions, corrective prompts | acceptance tests and a reviewer | measured / judged |

Report **total cost = provider cost + Jev cost** per task, along with completion and quality. Fewer tokens alone is not a saving: pruning changes the request prefix and can increase cache writes. Compare cache-read and cache-write volumes between A and B.

## Data handling

- Use synthetic or open-source tasks for anything published.
- Don't publish private code, transcripts, provider pricing or account-level spend.
