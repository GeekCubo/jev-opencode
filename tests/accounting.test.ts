// Spend accounting across plugin instances that share one plugin storage (one instance per project
// location in a single OpenCode service), across reloads and across concurrent evaluations.
import { describe, expect, it } from "vitest"
import { createPlugin } from "../plugin/index.ts"
import { fakeContext, mockJev, runContext, transcript } from "./fixtures.ts"

const env = { TYPESAFE_API_KEY: "ts-test-key-123456" }
const base = { mode: "active", compactAtTokens: 5_000, minGrowthTokens: 0, cooldownMs: 0, minReductionRatio: 0.1 }

/** Starts a plugin instance whose storage is the shared Map (other ctx fields are per-instance). */
async function instance(shared: Map<string, unknown>, options: Record<string, unknown> = {}, now?: () => number) {
  const f = fakeContext({ ...base, ...options })
  f.ctx.storage.get = async (k: string) => structuredClone(shared.get(k))
  f.ctx.storage.set = async (k: string, v: unknown) => void shared.set(k, structuredClone(v))
  const jev = mockJev()
  const cleanup = await createPlugin({ fetch: jev.fetch, env, snapshotPath: "/dev/null", now }).setup(f.ctx)
  return { f, jev, cleanup: cleanup as () => Promise<void> }
}
const day = () => new Date().toISOString().slice(0, 10)
const settle = () => new Promise((r) => setTimeout(r, 2_300))

describe("kill switch and capability failures", () => {
  it("config mode off overrides a mode stored by command and cannot be re-enabled by command", async () => {
    const shared = new Map<string, unknown>([["mode", "active"]])
    const a = await instance(shared, { mode: "off" })
    await runContext(a.f, "s", transcript())
    expect(a.jev.calls.length).toBe(0)
    const snap: any = await a.f.rpc.snapshot({})
    expect(snap.state).toBe("off")
    expect((await a.f.rpc.setMode({ mode: "active" })).text).toMatch(/disabled in opencode.jsonc/)
    await runContext(a.f, "s", transcript({ rounds: 20 }))
    expect(a.jev.calls.length).toBe(0)
  })

  it("a failing context hook leaves Jev inert and setup completes", async () => {
    const f = fakeContext({ ...base })
    const original = f.ctx.session.hook
    f.ctx.session.hook = async (name: string, cb: Function) => {
      if (name === "context") throw new Error("unsupported")
      return original(name, cb)
    }
    const jev = mockJev()
    await createPlugin({ fetch: jev.fetch, env, snapshotPath: "/dev/null" }).setup(f.ctx)
    const snap: any = await f.rpc.snapshot({})
    expect(snap.state).toBe("unavailable")
    expect((await f.rpc.setMode({ mode: "active" })).text).toMatch(/unavailable/)
  })
})

describe("spend accounting", () => {
  it("two instances sharing storage never overwrite each other's daily spend", async () => {
    const shared = new Map<string, unknown>()
    const a = await instance(shared)
    const b = await instance(shared)
    await runContext(a.f, "sa", transcript())
    await settle()
    const afterA = Number(shared.get(`spend/${day()}`))
    expect(afterA).toBeGreaterThan(0)
    await runContext(b.f, "sb", transcript())
    await settle()
    const total = Number(shared.get(`spend/${day()}`))
    // B must add to A's spend, not replace it with its own stale total.
    expect(total).toBeGreaterThan(afterA * 1.5)
    await a.cleanup()
    await b.cleanup()
    expect(Number(shared.get(`spend/${day()}`))).toBeCloseTo(total, 10)
  }, 15_000)

  it("global counters accumulate across instances and survive reload", async () => {
    const shared = new Map<string, unknown>()
    const a = await instance(shared)
    const b = await instance(shared)
    await runContext(a.f, "sa", transcript())
    await runContext(b.f, "sb", transcript())
    await a.cleanup()
    await b.cleanup()
    const stats = shared.get("stats") as { runs: number; jevRequests: number }
    expect(stats.runs).toBe(2)
    const c = await instance(shared)
    await runContext(c.f, "sc", transcript())
    await c.cleanup()
    expect((shared.get("stats") as { runs: number }).runs).toBe(3)
  }, 15_000)

  it("daily budget is enforced against spend made by other instances and before a reload", async () => {
    const shared = new Map<string, unknown>()
    shared.set(`spend/${day()}`, 0.999999)
    const a = await instance(shared, { budget: { perSessionUSD: 1, perDayUSD: 1 } })
    await runContext(a.f, "s1", transcript())
    expect(a.jev.calls.length).toBe(0)
    // Another instance pushes today's spend over the cap after A started.
    shared.set(`spend/${day()}`, 0.5)
    const b = await instance(shared, { budget: { perSessionUSD: 1, perDayUSD: 0.6 } })
    shared.set(`spend/${day()}`, 0.6)
    await runContext(b.f, "s2", transcript())
    expect(b.jev.calls.length).toBe(0)
  })

  it("session budget survives a plugin reload", async () => {
    const shared = new Map<string, unknown>()
    const a = await instance(shared, { budget: { perSessionUSD: 0.25, perDayUSD: 1 } })
    await runContext(a.f, "s1", transcript())
    await a.cleanup()
    const spent = Number(shared.get("session-spend/s1"))
    expect(spent).toBeGreaterThan(0)
    // Reload with a session cap just below what was already spent: no further Jev requests.
    const b = await instance(shared, { budget: { perSessionUSD: spent * 0.99, perDayUSD: 1 } })
    await runContext(b.f, "s1", transcript({ rounds: 30 }))
    expect(b.jev.calls.length).toBe(0)
  })

  it("parallel batches of one evaluation reserve cost and cannot overshoot the budget together", async () => {
    const shared = new Map<string, unknown>()
    // Small request limit forces many parallel batches; the budget fits only a few of them.
    const perBatch = 3_000 * (0.042 / 1e6)
    const a = await instance(shared, { maxStateTokens: 2_000, maxRequestTokens: 3_000, budget: { perSessionUSD: perBatch * 2.5, perDayUSD: 1 } })
    await runContext(a.f, "s", transcript({ rounds: 30 }))
    expect(a.jev.calls.length).toBeGreaterThan(0)
    expect(a.jev.calls.length).toBeLessThanOrEqual(2)
  })

  it("concurrent evaluations in two sessions are both counted", async () => {
    const shared = new Map<string, unknown>()
    const a = await instance(shared)
    await Promise.all([runContext(a.f, "x", transcript()), runContext(a.f, "y", transcript())])
    await a.cleanup()
    const perRequest = 1_000 * (0.042 / 1e6) // mock reports 1,000 input tokens per request
    const requests = (shared.get("stats") as { jevRequests: number }).jevRequests
    expect(Number(shared.get(`spend/${day()}`))).toBeCloseTo(requests * perRequest, 10)
  })
})
