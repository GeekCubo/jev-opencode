// Acceptance req 1: cost accounting. Pins the exact arithmetic and the distinctions
// between per-request, per-run, per-session, and provider-reported vs estimated cost.
// The configured model is jev-1.14 at $0.042/M tokens (KNOWN_PRICES, TypeSafe Direct).
import { describe, expect, it } from "vitest"
import { createPlugin } from "../plugin/index.ts"
import { fakeContext, mockJev, runContext } from "./fixtures.ts"
import { longSession } from "./large-session.test.ts"
import { KNOWN_PRICES } from "../plugin/config.ts"

const env = { TYPESAFE_API_KEY: "ts-test-key-123456" }
const base = { mode: "active", compactAtTokens: 1_000, minGrowthTokens: 0, cooldownMs: 0, budget: { perDayUSD: null, perSessionUSD: null } }
const PRICE = KNOWN_PRICES["jev-1.14"]

describe("cost accounting (acceptance)", () => {
  it("configured price is $0.042/M for jev-1.14 (TypeSafe Direct)", () => {
    expect(PRICE).toBe(0.042)
    // Corrected arithmetic for the acceptance report:
    expect((250_000 * 0.042) / 1e6).toBeCloseTo(0.0105, 6) // 250k tokens ≈ $0.0105
    expect((30_000 * 0.042) / 1e6).toBeCloseTo(0.00126, 6) // one max-size request ≈ $0.00126
    // The earlier report's $0.30/M claim would give $0.075 — NOT the configured price.
    expect((250_000 * 0.3) / 1e6).toBeCloseTo(0.075, 6)
  })

  it("per-request, per-run and per-session costs are distinct and correctly aggregated", async () => {
    const f = fakeContext({ ...base })
    const jev = mockJev()
    await createPlugin({ fetch: jev.fetch, env, snapshotPath: "/dev/null" }).setup(f.ctx)
    await runContext(f, "s", longSession(3_000))
    const requests = jev.calls.length
    expect(requests).toBeGreaterThan(1)
    // mockJev reports usage.input_tokens = 1000 per request (provider-reported, measured).
    const measuredPerRequest = 1_000
    const measuredRunTokens = requests * measuredPerRequest
    const snap: any = await (f.rpc as any).snapshot({ sessionID: "s" })
    // Provider-reported (measured) session Jev tokens: aggregated from response usage.
    expect(snap.session.jevTokensMeasured).toBe(measuredRunTokens)
    // Estimated session cost = measured tokens × list price ($0.042/M).
    expect(snap.session.costUSDEstimated).toBeCloseTo((measuredRunTokens * PRICE) / 1e6, 9)
    // Estimated != "savings": the snapshot labels it an estimate of the bill, not of saved money.
    expect(snap.session.reductionPctEstimated).toBeGreaterThanOrEqual(0)
  })

  it("a full 550k-context run: worst-case aggregate bound and expected actual cost", async () => {
    const f = fakeContext({ ...base })
    const jev = mockJev()
    await createPlugin({ fetch: jev.fetch, env, snapshotPath: "/dev/null" }).setup(f.ctx)
    await runContext(f, "s", longSession(16_000))
    const requests = jev.calls.length
    // Hard worst-case bound: each request ≤ 30k state+question tokens; 11 requests observed.
    const worstCaseTokens = requests * 30_000
    const worstCaseUSD = (worstCaseTokens * PRICE) / 1e6
    expect(worstCaseUSD).toBeLessThan(0.016) // 11 × 30k × $0.042/M ≈ $0.0139 worst case
    // Actual measured tokens come from the endpoint's usage reports, not from estimates.
    const snap: any = await (f.rpc as any).snapshot({ sessionID: "s" })
    expect(snap.session.jevTokensMeasured).toBe(requests * 1_000)
    expect(snap.session.jevTokensMeasured).toBeLessThan(worstCaseTokens)
  })

  it("budget reservations use the ESTIMATED per-request cost, spend records the MEASURED cost", async () => {
    // Reservations (~25k est. tokens/request) can exceed the measured usage (1000 tokens/request
    // in the mock): the budget is conservative, and the ledger never overshoots the limit.
    const f = fakeContext({ ...base, budget: { perDayUSD: null, perSessionUSD: 0.005 } })
    const jev = mockJev()
    await createPlugin({ fetch: jev.fetch, env, snapshotPath: "/dev/null" }).setup(f.ctx)
    await runContext(f, "s", longSession(3_000))
    const snap: any = await (f.rpc as any).snapshot({ sessionID: "s" })
    expect(snap.session.costUSDEstimated).toBeLessThanOrEqual(0.005 + 1e-9)
    // Reservations are estimates (conservative); measured spend is what the endpoint reported.
    expect(snap.session.jevTokensMeasured).toBeLessThanOrEqual(jev.calls.length * 1_000)
  })
})
