// TUI/GUI presentation test: the health level renders in the footer label and sidebar,
// and the notification message formats correctly at each level (text capture, no live TUI).
import { describe, expect, it } from "vitest"
import { shortLabel, sidebarRows, healthTone, HEALTH_LABEL } from "../plugin/ui-core.ts"
import type { JevSnapshot, SessionHealthLevel } from "../plugin/rpc.ts"

const snap = (level: SessionHealthLevel | null, over: Partial<JevSnapshot["session"]> = {}): JevSnapshot => ({
  state: "active", mode: "active", globalMode: "active", modeSource: "inherited from global", version: "0.2.4", reason: null, endpoint: "typesafe", model: "jev-1.14", todayUSDEstimated: 0, perDayUSD: 1, perSessionUSD: 0.25,
  session: {
    evaluations: 1, applied: 1, dryRuns: 0, failures: 0, requestsPruned: 2, tokensRemovedFromRequestsEstimated: 90000, nativeCompactions: 0, resets: 0, attempts: 1, trigger: null,
    health: level ? {
      level, contextTokens: 250_000, contextIsProviderReported: true, contextWindow: 1_000_000, utilizationPct: 25, stateTokens: 24_800, maxStateTokens: 25_000,
      eligibleResults: 300, protectedResults: 40, reductionPctEstimated: 20, consecutiveFailures: 0, consecutiveInsufficient: 0, nativeCompactions: 0,
      reasons: ["Context 250k tokens (above the 200k advisory threshold)"], recommendation: "Complete the current operation and consider native compaction.", nextAction: "At the next checkpoint consider /jev-compact (a forced Jev evaluation) or native compaction.",
    } : null,
    tokensRemovedEstimated: 41234, reductionPctEstimated: 57.1, jevTokensMeasured: 9000, costUSDEstimated: 0.0004, pruned: { dropped: 9, truncated: 1 }, lastEvaluationAt: new Date().toISOString(), evaluating: false,
    ...over,
  },
})

describe("TUI and Desktop presentation", () => {
  it("footer label carries the health level, e.g. 'Jev: Active · TypeSafe · Healthy'", () => {
    expect(shortLabel(snap("healthy"))).toBe("Jev: Active · TypeSafe · Healthy")
    expect(shortLabel(snap("growing"))).toBe("Jev: Active · TypeSafe · Growing")
    expect(shortLabel(snap("compaction_recommended"))).toBe("Jev: Active · TypeSafe · Compaction recommended")
    expect(shortLabel(snap("new_session_recommended"))).toBe("Jev: Active · TypeSafe · New session recommended")
    expect(shortLabel(snap(null))).toBe("Jev: Active · TypeSafe") // no session yet: unchanged
  })

  it("sidebar shows Health and, when escalated, the next action", () => {
    const rows = Object.fromEntries(sidebarRows(snap("healthy")))
    expect(rows["Health"]).toBe("Healthy (25% of window)")
    expect(rows["Next"]).toBeUndefined()
    const escalated = Object.fromEntries(sidebarRows(snap("compaction_recommended")))
    expect(escalated["Health"]).toMatch(/Compaction recommended/)
    expect(escalated["Next"]).toMatch(/jev-compact/)
  })

  it("pill tone maps health levels (Desktop ComposerPill)", () => {
    expect(healthTone("healthy")).toBe("success")
    expect(healthTone("growing")).toBeUndefined()
    expect(healthTone("compaction_recommended")).toBe("warning")
    expect(healthTone("new_session_recommended")).toBe("danger")
    expect(healthTone(undefined)).toBeUndefined()
  })
})
