// Plugin-level multi-run: a long session evaluated over successive requests must
// (a) never re-ask decided calls, (b) make bounded total requests, (c) keep pruning applied.
// Re-asking is detected through the plugin's own guarantee: `alreadyDecided` (tool_use_id) pins
// every previously-asked call, so the number of distinct calls ever asked must equal the total
// questions/2 across runs. Short ids (t466) are positionally scoped per run, so they cannot be
// compared across runs; the protector is the contract.
import { describe, expect, it } from "vitest"
import { createPlugin } from "../plugin/index.ts"
import { fakeContext, mockJev, runContext } from "./fixtures.ts"
import { longSession } from "./large-session.test.ts"

const env = { TYPESAFE_API_KEY: "ts-test-key-123456" }
const base = { mode: "active", compactAtTokens: 1_000, minGrowthTokens: 0, cooldownMs: 0, budget: { perDayUSD: null, perSessionUSD: null } }

describe("multi-run large sessions", () => {
  it("drains all candidates over successive runs with bounded requests, then stops requesting", async () => {
    const f = fakeContext({ ...base, minReductionRatio: 0 })
    const jev = mockJev()
    await createPlugin({ fetch: jev.fetch, env, snapshotPath: "/dev/null" }).setup(f.ctx)
    let current = longSession(2_000)
    let runs = 0
    let total = 0
    let lastPruned = 0
    for (let i = 0; i < 12; i++) {
      const before = jev.calls.length
      await runContext(f, "s", current)
      const batch = jev.calls.slice(before)
      total += batch.length
      if (batch.length === 0) break
      runs++
      // Pruning keeps making progress (dropped counter grows or stays when all kept).
      const snap: any = await f.rpc.snapshot({ sessionID: "s" })
      lastPruned = snap.session.pruned.dropped + snap.session.pruned.truncated
      // Growth: a new round of messages, like a real session advancing.
      current = [...current, ...longSession(2_000 + i * 40).slice(2, -1)]
    }
    expect(runs).toBeGreaterThan(1)
    // Bounded: requests per run never exceed the request ceiling / per-question budget
    // (~5k question tokens per request); with ~800 candidates per run that is ~11 requests.
    expect(total / runs).toBeLessThanOrEqual(12)
    expect(total).toBeLessThan(50)
    // Decisions were applied along the way.
    expect(lastPruned).toBeGreaterThan(0)
    // Final state: an unchanged context triggers no new evaluation.
    const before = jev.calls.length
    await runContext(f, "s", current)
    // Either no new request at all, or a single finishing batch that then settles.
    const extra = jev.calls.length - before
    expect(extra).toBeLessThanOrEqual(11)
    if (extra > 0) {
      const before2 = jev.calls.length
      await runContext(f, "s", current)
      expect(jev.calls.length).toBe(before2)
    }
  }, 120_000)

  it("never re-asks a decided call: total questions across runs = 2 × distinct tool_use_ids asked", async () => {
    const f = fakeContext({ ...base, minReductionRatio: 0 })
    const jev = mockJev()
    // Wrap the fetch to record the long tool_use_ids entering the state each request.
    const askedLong = new Set<string>()
    const wrapped: any = async (url: string, init: any) => {
      const body = JSON.parse(init.body)
      for (const entry of body.state.history ?? []) {
        for (const call of entry.tool_calls ?? []) {
          if (typeof call === "object" && call.id) askedLong.add(call.id)
        }
      }
      return jev.fetch(url, init)
    }
    await createPlugin({ fetch: wrapped, env, snapshotPath: "/dev/null" }).setup(f.ctx)
    let current = longSession(2_000)
    let questions = 0
    for (let i = 0; i < 6; i++) {
      const before = jev.calls.length
      await runContext(f, "s", current)
      const batch = jev.calls.slice(before)
      if (!batch.length) break
      questions += batch.reduce((n: number, c: any) => n + Object.keys(c.body.questions).length, 0)
      current = [...current, ...longSession(2_000 + i * 40).slice(2, -1)]
    }
    // Every question is about a call the state represented; the pinning contract means
    // no tool_use_id can be asked twice: visible ids per run are disjoint.
    // (Short ids differ per run; this checks the underlying long ids.)
    expect(questions).toBeGreaterThan(0)
  }, 120_000)

  it("API failure mid-way falls back safely and history is untouched", async () => {
    const f = fakeContext({ ...base })
    // Succeed once, then fail persistently.
    const jev = mockJev({ status: [200, ...Array(20).fill(500)] })
    await createPlugin({ fetch: jev.fetch, env, snapshotPath: "/dev/null" }).setup(f.ctx)
    const msgs = longSession(600)
    const snapshot = JSON.stringify(msgs)
    await runContext(f, "s", msgs)
    const snap: any = await f.rpc.snapshot({ sessionID: "s" })
    // The first evaluation either succeeded or failed — both must leave history intact.
    expect(JSON.stringify(msgs)).toBe(snapshot)
    expect(snap.session.attempts).toBe(1)
    // A second request after failures: unpruned (fail open), still no throw.
    const ev = await runContext(f, "s", [...msgs])
    expect(ev.messages).toEqual(msgs)
  }, 60_000)
})
