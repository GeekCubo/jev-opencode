# Real-world A/B benchmark (prepared, not run)

Goal: measure whether Jev active mode lowers the **total** cost of real coding work (coding provider plus Jev) without lowering task quality. No results are published yet.

## Groups

| | A: baseline | B: Jev |
|---|---|---|
| OpenCode | same version | same version |
| Coding model, provider, reasoning effort | identical | identical |
| Agents, AGENTS.md, delegation instructions, tools, permissions | identical | identical |
| Native compaction | enabled (default) | enabled (default) |
| Jev | off | active, default thresholds |

## Isolation

Use **two independent OpenCode instances**, one per group (`setup-instance.sh`). Each has its own config, state, data and service port, copied from your config with only the Jev mode changed. Both can run in parallel.

Alternative on one service: use per-session overrides. `/jev-session-disable` in the A sessions and `/jev-session-enable` in the B sessions isolate the mode per session (0.2.0+). A and B then share one daily Jev limit and one service; confirm each session's mode with `/jev-status` before sending the prompt.

Don't rely on different projects for isolation: the global mode is per service.

## Tasks

At least three matched pairs; see `tasks.example.json`:
1. Repository investigation and bug fixing.
2. Multi-file feature implementation.
3. Long-running debugging or refactoring (long enough to pass the 60k-token threshold).

Each task has a fixed prompt, a fixed starting commit and an acceptance command. Use open-source or synthetic repositories for anything you publish.

## Procedure

```sh
# 0. Prepare (no paid requests).
sh benchmarks/setup-instance.sh A ~/jev-ab ~/.config/opencode/opencode.jsonc 18801
sh benchmarks/setup-instance.sh B ~/jev-ab ~/.config/opencode/opencode.jsonc 18802
for g in A B; do for t in t1 t2 t3; do for n in 1 2 3; do
  git -C /path/to/benchmark-repo worktree add --detach ~/jev-ab/wt/$t-$g-$n <commit>
done; done; done

# 1. Start both instances.
(. ~/jev-ab/A/env.sh && opencode service start); (. ~/jev-ab/B/env.sh && opencode service start)

# 2. For each run: open the worktree in that group's instance, start a fresh session, pick the model
#    (the same provider/model and reasoning variant for A and B), check /jev-status, and paste the task prompt verbatim.
(. ~/jev-ab/B/env.sh && cd ~/jev-ab/wt/t1-B-1 && opencode)

# 3. After the agent finishes: run the acceptance command in the worktree and record the outcome.
#    Write results/<task>-<A|B>-<n>.outcome.json:
#    {"testsPassed":true,"completed":true,"corrections":0,"reviewer":"pass","billedProviderUSD":null,"billedJevUSD":null}

# 4. Collect (read-only; no model or Jev requests). The session ID is shown in /jev-status, or list sessions via the API.
. ~/jev-ab/B/env.sh
OPENCODE_SERVER_PASSWORD=$(node -pe 'JSON.parse(require("fs").readFileSync(process.env.XDG_CONFIG_HOME+"/opencode/service.json")).password') \
  node benchmarks/collect.mjs http://127.0.0.1:18802 ~/jev-ab/wt/t1-B-1 <sessionID> \
  --jev-ledger "$XDG_STATE_HOME/opencode-jev/ledger.json" > results/t1-B-1.json

# 5. Compare.
node benchmarks/aggregate.mjs results/*.json > results/summary.json
```

Order and repetitions:
- **Runs:** at least 3 per group per task.
- **Order:** alternate A and B (A1, B1, B2, A2, A3, B3), so time-of-day and provider caching don't favour one group.
- **Sessions:** fresh for every run; never reuse a session or worktree.
- **Cache:** cross-session cache reuse is possible within a provider's cache lifetime (often 5 minutes to 1 hour). Either space paired runs further apart, or keep cache-read tokens visible in the comparison, which `collect.mjs` does.

## Cost control

- **Coding-model spend.** Before you start, put a hard limit at the provider (Apixo dashboard or key limit) for the benchmark.
- **Estimate.** Expected spend ≈ runs × typical task cost. With 3 tasks × 2 groups × 3 runs, that is 18 sessions.
- **Jev spend.** The B instance keeps the defaults of $0.25 per session and $1.00 per day. These cap Jev, not the coding model.
- **Stop rule.** Stop a run that exceeds 2× the median of its group, and record it as such. Don't retry failed runs silently; record them.
- **Separate keys.** Use a dedicated provider key or project if your provider supports it, so the bill can be attributed to the benchmark.

## Measurements

| Metric | Source | Kind |
|---|---|---|
| Uncached input, cache-read, cache-write, output and reasoning tokens | OpenCode step data, including subagent sessions | provider-reported |
| Coding-model requests, tool calls, tool errors, failed steps | OpenCode messages | provider-reported / OpenCode |
| Peak context | max(input + cache) per step | provider-reported |
| Native compactions | OpenCode messages | OpenCode |
| Coding-provider cost | OpenCode `cost` | provider-reported; replace with `billedProviderUSD` from the bill when available |
| Jev evaluations, requests, failures, input tokens | accounting file (per session) | measured |
| Jev cost | tokens × list price | estimate; replace with `billedJevUSD` from the TypeSafe bill |
| Context before/after pruning, tokens removed | accounting file | estimate |
| Duration | first to last message | measured |
| Tests passed, completed, corrections, reviewer verdict | acceptance command and the outcome file | measured / judged |

**Net savings = mean total(A) − mean total(B)**, where total = provider cost + Jev cost. Cache effects are already inside the provider cost, because cache writes and reads are billed there. A token reduction is not a saving by itself: pruning changes the request prefix and can add cache writes. Report savings only alongside the quality fields, and treat overlapping ranges or fewer than 3 runs per group as inconclusive.

Have the correctness assessment done independently: a reviewer who doesn't know which group a run belongs to (for example the Reviewer agent, given only the diff and the task).

## Data handling

- Use synthetic or open-source tasks for anything published.
- Don't publish private code, transcripts, provider pricing or account-level spend.
