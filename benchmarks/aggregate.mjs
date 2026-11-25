// Aggregates collected run files into per-task A/B comparisons. Usage: node benchmarks/aggregate.mjs results/*.json
// File names: <task>-<A|B>-<n>.json (from collect.mjs), optionally with a sibling <same>.outcome.json:
//   { "testsPassed": true, "completed": true, "corrections": 0, "reviewer": "pass|minor|fail", "billedProviderUSD": null, "billedJevUSD": null }
import { existsSync, readFileSync } from "node:fs"
import { basename } from "node:path"

const runs = {}
for (const f of process.argv.slice(2).filter((f) => !f.endsWith(".outcome.json"))) {
  const m = /^(.+)-([AB])-(\d+)\.json$/.exec(basename(f))
  if (!m) continue
  const r = JSON.parse(readFileSync(f, "utf8"))
  const o = existsSync(f.replace(/\.json$/, ".outcome.json")) ? JSON.parse(readFileSync(f.replace(/\.json$/, ".outcome.json"), "utf8")) : {}
  ;((runs[m[1]] ??= { A: [], B: [] })[m[2]]).push({ r, o })
}
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN)
const spread = (xs) => (xs.length ? [Math.min(...xs), Math.max(...xs)] : [NaN, NaN])
const summary = (list) => {
  const pick = (fn) => list.map(fn)
  // Billed figures win when provided; otherwise the provider-reported (OpenCode) cost and the Jev estimate are used.
  const provider = pick(({ r, o }) => o.billedProviderUSD ?? r.measured.providerCostUSD)
  const jev = pick(({ r, o }) => o.billedJevUSD ?? r.jev?.costUSDEstimated ?? 0)
  const total = provider.map((p, i) => p + jev[i])
  return {
    n: list.length,
    providerUSD: { mean: mean(provider), range: spread(provider), source: list.some(({ o }) => o.billedProviderUSD != null) ? "billed (some runs)" : "OpenCode-reported" },
    jevUSD: { mean: mean(jev), range: spread(jev), source: list.some(({ o }) => o.billedJevUSD != null) ? "billed (some runs)" : "estimate" },
    totalUSD: { mean: mean(total), range: spread(total) },
    tokens: Object.fromEntries(["inputUncached", "cacheRead", "cacheWrite", "output", "reasoning", "peakContext"].map((k) => [k, Math.round(mean(pick(({ r }) => r.measured[k])))])),
    requests: mean(pick(({ r }) => r.measured.requests)),
    toolCalls: mean(pick(({ r }) => r.measured.toolCalls)),
    nativeCompactions: mean(pick(({ r }) => r.measured.compactions)),
    failedSteps: mean(pick(({ r }) => r.measured.failedSteps)),
    jevEvaluations: mean(pick(({ r }) => r.jev?.evaluations ?? 0)),
    durationSec: mean(pick(({ r }) => r.durationSec)),
    testsPassed: pick(({ o }) => o.testsPassed).filter(Boolean).length,
    completed: pick(({ o }) => o.completed).filter(Boolean).length,
    corrections: mean(pick(({ o }) => o.corrections ?? NaN)),
    reviewer: pick(({ o }) => o.reviewer ?? "n/a"),
  }
}
const report = {}
for (const [task, g] of Object.entries(runs)) {
  const A = summary(g.A), B = summary(g.B)
  report[task] = {
    A, B,
    netSavingsUSD: A.totalUSD.mean - B.totalUSD.mean,
    netSavingsPct: A.totalUSD.mean > 0 ? Math.round((1 - B.totalUSD.mean / A.totalUSD.mean) * 1000) / 10 : null,
    caution: "Net savings include Jev cost and all cache effects (they are inside the provider cost). Compare quality fields before concluding. With fewer than 3 runs per group, or overlapping ranges, treat the result as inconclusive.",
  }
}
console.log(JSON.stringify(report, null, 2))
