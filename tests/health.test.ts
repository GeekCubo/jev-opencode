// Session health monitoring (0.2.4): levels, adaptive thresholds, notifications,
// /jev-health and /jev-handover, session isolation, persistence, zero extra requests.
import { describe, expect, it } from "vitest"
import {
  assessHealth, DEFAULT_HEALTH_THRESHOLDS, healthShouldNotify, healthNotifyMessage,
  newNotifyState, recordNotify, resetNotifyState, type HealthInput,
} from "../plugin/health.ts"
import { createPlugin } from "../plugin/index.ts"
import { fakeContext, mockJev, runContext, transcript } from "./fixtures.ts"
import { longSession } from "./large-session.test.ts"

const env = { TYPESAFE_API_KEY: "ts-test-key-123456" }
const base = { mode: "active", compactAtTokens: 1_000, minGrowthTokens: 0, cooldownMs: 0, budget: { perDayUSD: null, perSessionUSD: null } }

const input = (over: Partial<HealthInput> = {}): HealthInput => ({
  contextTokens: 50_000,
  contextIsProviderReported: false,
  maxStateTokens: 25_000,
  insufficientReductions: 0,
  evaluationFailures: 0,
  nativeCompactions: 0,
  now: 0,
  ...over,
})

describe("health levels and adaptive thresholds", () => {
  it("fresh small session is healthy", () => {
    expect(assessHealth(input()).level).toBe("healthy")
  })

  it("growing at 100k, compaction recommended at 200k, new session at 300k and 550k (1M window)", () => {
    expect(assessHealth(input({ contextTokens: 60_000, contextWindow: 1_000_000 })).level).toBe("healthy")
    expect(assessHealth(input({ contextTokens: 150_000, contextWindow: 1_000_000 })).level).toBe("growing")
    expect(assessHealth(input({ contextTokens: 250_000, contextWindow: 1_000_000 })).level).toBe("compaction_recommended")
    expect(assessHealth(input({ contextTokens: 400_000, contextWindow: 1_000_000 })).level).toBe("new_session_recommended")
    expect(assessHealth(input({ contextTokens: 550_000, contextWindow: 1_000_000 })).level).toBe("new_session_recommended")
  })

  it("60k/150k/250k/400k/550k matrix without a known window (absolute thresholds only)", () => {
    expect(assessHealth(input({ contextTokens: 60_000 })).level).toBe("healthy")
    expect(assessHealth(input({ contextTokens: 150_000 })).level).toBe("growing")
    expect(assessHealth(input({ contextTokens: 250_000 })).level).toBe("compaction_recommended")
    expect(assessHealth(input({ contextTokens: 400_000 })).level).toBe("new_session_recommended")
    expect(assessHealth(input({ contextTokens: 550_000 })).level).toBe("new_session_recommended")
  })

  it("adapts to a small model window: a 128k window warns earlier", () => {
    // 100k on a 128k window (78% utilised) is far worse than 100k on 1M.
    const small = assessHealth(input({ contextTokens: 100_000, contextWindow: 128_000 }))
    const large = assessHealth(input({ contextTokens: 100_000, contextWindow: 1_000_000 }))
    expect(small.level).toBe("new_session_recommended")
    expect(large.level).toBe("growing")
    expect(small.utilizationPct).toBe(78)
    // 50k on 128k (39%) is only growing, not compaction.
    expect(assessHealth(input({ contextTokens: 50_000, contextWindow: 128_000 })).level).toBe("growing")
    // 20k on 128k (16%) is healthy.
    expect(assessHealth(input({ contextTokens: 20_000, contextWindow: 128_000 })).level).toBe("healthy")
  })

  it("unknown model capacity falls back to the absolute thresholds", () => {
    expect(assessHealth(input({ contextTokens: 60_000, contextWindow: undefined })).level).toBe("healthy")
    expect(assessHealth(input({ contextTokens: 60_000, contextWindow: 0 })).utilizationPct).toBeNull()
  })

  it("optimization evidence escalates the level", () => {
    expect(assessHealth(input({ insufficientReductions: 2 })).level).toBe("compaction_recommended")
    expect(assessHealth(input({ evaluationFailures: 3 })).level).toBe("new_session_recommended")
    expect(assessHealth(input({ evaluationFailures: 1 })).level).toBe("growing")
    // Repeated native compactions without relief while context stays large.
    expect(assessHealth(input({ contextTokens: 250_000, nativeCompactions: 2 })).level).toBe("new_session_recommended")
    // Primary context dwarfs the evaluation state (windowed sessions).
    expect(assessHealth(input({ contextTokens: 400_000, stateTokens: 25_000, eligibleResults: 300 })).level).toMatch(/compaction|new_session/)
  })

  it("distinguishes primary context from evaluation state and never claims savings", () => {
    const r = assessHealth(input({ contextTokens: 550_000, stateTokens: 25_000, reductionPctEstimated: 30 }))
    expect(r.reasons.join()).not.toMatch(/savings|saved/)
    expect(r.recommendation).toMatch(/handover|fresh session/)
    expect(r.nextAction).toContain("/jev-handover")
  })
})

describe("notification deduplication, cooldowns, hysteresis", () => {
  it("notifies only on deterioration or after the cooldown", () => {
    const st = newNotifyState()
    expect(healthShouldNotify(st, "healthy", 0)).toBe(false) // initial healthy: silent
    expect(healthShouldNotify(st, "growing", 1)).toBe(true) // deterioration
    recordNotify(st, "growing", 1)
    expect(healthShouldNotify(st, "growing", 2)).toBe(false) // same level: deduplicated
    expect(healthShouldNotify(st, "growing", 2 + 30 * 60_000)).toBe(true) // re-notify after 30 min
    recordNotify(st, "growing", 2 + 30 * 60_000)
    expect(healthShouldNotify(st, "compaction_recommended", 3)).toBe(true) // worse: immediately
    recordNotify(st, "compaction_recommended", 3)
    expect(healthShouldNotify(st, "healthy", 4)).toBe(false) // improvement: silent
    recordNotify(st, "healthy", 4)
    expect(healthShouldNotify(st, "healthy", 5)).toBe(false) // healthy never re-notifies
  })

  it("reset clears state (fresh session semantics)", () => {
    const st = newNotifyState()
    recordNotify(st, "new_session_recommended", 1)
    resetNotifyState(st)
    expect(st.lastLevel).toBe("healthy")
    expect(healthShouldNotify(st, "growing", 2)).toBe(true)
  })

  it("messages never claim financial savings", () => {
    for (const level of ["healthy", "growing", "compaction_recommended", "new_session_recommended"] as const)
      expect(healthNotifyMessage(level, input())).not.toMatch(/saved|savings/)
    expect(healthNotifyMessage("compaction_recommended", input({ contextTokens: 250_000 }))).toContain("250k")
    expect(healthNotifyMessage("new_session_recommended", input({ evaluationFailures: 3 }))).toContain("evaluation")
  })
})

describe("plugin-level health", () => {
  it("/jev-health reports levels and both token spaces; no Jev or model request", async () => {
    const f = fakeContext({ ...base })
    const jev = mockJev()
    await createPlugin({ fetch: jev.fetch, env, snapshotPath: "/dev/null" }).setup(f.ctx)
    await runContext(f, "s", longSession(600))
    const text: string = (await (f.rpc as any).health({ sessionID: "s" })).text
    expect(text).toMatch(/Session health: /)
    expect(text).toMatch(/Primary context: /)
    expect(text).toMatch(/Jev evaluation state: /)
    expect(text).toMatch(/Advisory only/)
    // Passive monitoring made zero requests beyond the evaluation itself.
    const evalCalls = jev.calls.length
    await (f.rpc as any).health({ sessionID: "s" })
    expect(jev.calls.length).toBe(evalCalls)
  })

  it("health snapshot appears in /jev-status and the structured snapshot", async () => {
    const f = fakeContext({ ...base })
    const jev = mockJev()
    await createPlugin({ fetch: jev.fetch, env, snapshotPath: "/dev/null" }).setup(f.ctx)
    await runContext(f, "s", longSession(3_000))
    const snap: any = await (f.rpc as any).snapshot({ sessionID: "s" })
    expect(snap.session.health).toBeDefined()
    expect(["healthy", "growing", "compaction_recommended", "new_session_recommended"]).toContain(snap.session.health.level)
    const status: string = (await (f.rpc as any).status({ sessionID: "s" })).text
    expect(status).toMatch(/session health: /)
  })

  it("health state is independent across simultaneous sessions", async () => {
    const f = fakeContext({ ...base })
    const jev = mockJev()
    await createPlugin({ fetch: jev.fetch, env, snapshotPath: "/dev/null" }).setup(f.ctx)
    await runContext(f, "a", longSession(300))
    await runContext(f, "b", longSession(3_000))
    const sa: any = await (f.rpc as any).snapshot({ sessionID: "a" })
    const sb: any = await (f.rpc as any).snapshot({ sessionID: "b" })
    expect(sa.session.health.contextTokens).not.toBe(sb.session.health.contextTokens)
    // A session with repeated evaluation failures escalates on its own record only.
    const failing = mockJev({ status: [500, 500, 500, 500, 500, 500, 500, 500] })
    const f2 = fakeContext({ ...base })
    await createPlugin({ fetch: failing.fetch, env, snapshotPath: "/dev/null" }).setup(f2.ctx)
    let growing = 0
    for (let i = 0; i < 3; i++) {
      await runContext(f2, "x", longSession(300 + i * 40))
      await new Promise((r) => setTimeout(r, 2))
      const snap: any = await (f2.rpc as any).snapshot({ sessionID: "x" })
      if (snap.session.health.consecutiveFailures > 0) growing++
    }
    expect(growing).toBeGreaterThan(0) // failures recorded on the failing session
    // Meanwhile the healthy session in the other instance is untouched (in-memory state).
    const sa2: any = await (f.rpc as any).snapshot({ sessionID: "a" })
    expect(sa2.session.health.consecutiveFailures).toBe(0)
  })

  it("notification is delivered once per transition and can be acknowledged (drained)", async () => {
    const f = fakeContext({ ...base })
    const jev = mockJev()
    await createPlugin({ fetch: jev.fetch, env, snapshotPath: "/dev/null" }).setup(f.ctx)
    await runContext(f, "s", longSession(4_000)) // compaction / new-session territory
    const first = (await (f.rpc as any).drainNotification({ sessionID: "s" })).text
    expect(first).toBeTruthy()
    const second = (await (f.rpc as any).drainNotification({ sessionID: "s" })).text
    expect(second).toBe("") // drained: not repeated
  })

  it("native compaction resets health cadence", async () => {
    const f = fakeContext({ ...base })
    const jev = mockJev()
    await createPlugin({ fetch: jev.fetch, env, snapshotPath: "/dev/null" }).setup(f.ctx)
    await runContext(f, "s", longSession(3_000))
    expect((await (f.rpc as any).drainNotification({ sessionID: "s" })).text).toBeTruthy()
    f.emit({ type: "session.compaction.ended", data: { sessionID: "s" } })
    await new Promise((r) => setTimeout(r, 10))
    const snap: any = await (f.rpc as any).snapshot({ sessionID: "s" })
    expect(snap.session.nativeCompactions).toBe(1)
    expect(snap.session.health.consecutiveFailures).toBe(0)
    expect(snap.session.health.consecutiveInsufficient).toBe(0)
  })

  it("health threshold overrides come through the existing plugin options", async () => {
    const f = fakeContext({ ...base, health: { growing: 5_000, compaction: 10_000, freshSession: 20_000, strongFreshSession: 40_000 } } as any)
    const jev = mockJev()
    await createPlugin({ fetch: jev.fetch, env, snapshotPath: "/dev/null" }).setup(f.ctx)
    await runContext(f, "s", longSession(160)) // ~10k tokens: over the tiny 5k/10k overrides
    const snap: any = await (f.rpc as any).snapshot({ sessionID: "s" })
    expect(snap.session.health.level).not.toBe("healthy")
  })

  it("global config and per-session mode precedence do not change health availability", async () => {
    const f = fakeContext({ ...base, mode: "dry-run" })
    const jev = mockJev()
    await createPlugin({ fetch: jev.fetch, env, snapshotPath: "/dev/null" }).setup(f.ctx)
    await runContext(f, "s", longSession(600))
    await (f.rpc as any).setSessionMode({ sessionID: "s", mode: "active" })
    const text: string = (await (f.rpc as any).health({ sessionID: "s" })).text
    expect(text).toMatch(/Session health: /)
  })
})

describe("/jev-handover", () => {
  it("produces a copyable summary from local records, with no inference request", async () => {
    const f = fakeContext({ ...base })
    const jev = mockJev()
    await createPlugin({ fetch: jev.fetch, env, snapshotPath: "/dev/null" }).setup(f.ctx)
    await runContext(f, "s", longSession(300))
    const before = jev.calls.length
    const text: string = (await (f.rpc as any).handover({ sessionID: "s" })).text
    expect(jev.calls.length).toBe(before) // no paid request
    expect(text).toContain("Jev handover summary")
    expect(text).toContain("no inference request was made")
    expect(text).toMatch(/Session: s/)
    expect(text).toMatch(/unavailable — /) // honest about missing project-specific facts
    expect(text).not.toMatch(/sk-apixo|sk-[a-zA-Z0-9]{20}|API key/i) // no credentials
    // Health recommendation is embedded.
    expect(text).toMatch(/Health at handover: /)
  })

  it("without a session it says so instead of inventing content", async () => {
    const f = fakeContext({ ...base })
    const jev = mockJev()
    await createPlugin({ fetch: jev.fetch, env, snapshotPath: "/dev/null" }).setup(f.ctx)
    const text: string = (await (f.rpc as any).handover({ sessionID: "nope" })).text
    expect(text).toContain("Jev handover summary") // still a valid report, health unknown but honest
  })
})

describe("passive monitoring costs", () => {
  it("zero additional inference requests from passive health monitoring", async () => {
    const f = fakeContext({ ...base })
    const jev = mockJev()
    await createPlugin({ fetch: jev.fetch, env, snapshotPath: "/dev/null" }).setup(f.ctx)
    const msgs = longSession(200)
    const evalCalls = (await runContext(f, "s", msgs), jev.calls.length)
    // Many more steps with the same context: health checks fire on each step event, zero Jev calls.
    for (let i = 0; i < 5; i++) {
      f.emit({ type: "session.step.ended", data: { sessionID: "s", tokens: { input: 1_000, cache: { read: 100, write: 0 } }, cost: 0.01 } })
      await new Promise((r) => setTimeout(r, 5))
    }
    expect(jev.calls.length).toBe(evalCalls)
    // Snapshot/status/health reads are local.
    await (f.rpc as any).snapshot({ sessionID: "s" })
    await (f.rpc as any).health({ sessionID: "s" })
    expect(jev.calls.length).toBe(evalCalls)
  })
})
