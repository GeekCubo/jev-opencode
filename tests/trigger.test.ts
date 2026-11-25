// Evaluation trigger: provider-reported context, gates, diagnostics and reason codes (0.2.1).
// Everything runs through the plugin's `context` hook, as OpenCode invokes it; Jev is mocked.
import { AssistantMessage, ToolMessage, UserMessage } from "@opencode/ai"
import { describe, expect, it } from "vitest"
import { createPlugin } from "../plugin/index.ts"
import { fakeContext, mockJev, runContext, transcript } from "./fixtures.ts"

const env = { TYPESAFE_API_KEY: "ts-test-key-123456" }
// Real defaults except the threshold, which sits between the fixture's message estimate (~20k) and its provider context.
const base = { mode: "active", compactAtTokens: 30_000, budget: { perDayUSD: null, perSessionUSD: null } }

async function setup(options: Record<string, unknown> = {}, jev = mockJev(), deps: Record<string, unknown> = {}) {
  let clock = 1_000_000
  const f = fakeContext({ ...base, ...options })
  const cleanup = (await createPlugin({ fetch: jev.fetch, env, snapshotPath: "/dev/null", now: () => clock, ...deps }).setup(f.ctx)) as () => Promise<void>
  return { f, jev, tick: (ms: number) => void (clock += ms), cleanup }
}
const settle = () => new Promise((r) => setTimeout(r, 10))
/** Simulates OpenCode's `session.step.ended` for the request just sent (uncached + cached input). */
async function step(f: any, sessionID: string, input: number, cacheRead: number, cacheWrite = 0) {
  f.emit({ type: "session.step.ended", data: { sessionID, cost: 0, tokens: { input, output: 100, cache: { read: cacheRead, write: cacheWrite } } } })
  await settle()
}
const trigger = async (f: any, sessionID: string) => ((await f.rpc.snapshot({ sessionID })) as any).session.trigger

describe("evaluation trigger", () => {
  it("reproduces 0.2.0: the message-only estimate stays below the threshold although the provider context exceeds it", async () => {
    const { f, jev } = await setup()
    const msgs = transcript()
    await runContext(f, "s", msgs)
    const t = await trigger(f, "s")
    expect(t.estimatedContextTokens).toBeLessThan(30_000)
    expect(t.reason).toBe("waiting_threshold")
    expect(t.providerContextTokens).toBeNull()
    expect(jev.calls).toHaveLength(0)
  })

  it("uses provider-reported context, cached input included, once the provider has reported it", async () => {
    const { f, jev } = await setup()
    const msgs = transcript()
    await runContext(f, "s", msgs)
    // System prompt and tool definitions make the real request much larger; most of it is served from cache.
    await step(f, "s", 1_500, 33_000)
    const ev = await runContext(f, "s", msgs)
    expect(jev.calls.length).toBeGreaterThan(0)
    const t = await trigger(f, "s")
    expect(t.providerContextTokens).toBe(34_500)
    expect(t.triggerContextTokens).toBeGreaterThanOrEqual(34_500)
    expect(t.reason).toBe("pruning_active")
    expect(ev.messages.length).toBeLessThan(msgs.length)
    // Pruning shrank the context below the threshold: it is still reported as pruning, not as waiting.
    await step(f, "s", 1_500, 20_000)
    await runContext(f, "s", msgs)
    expect((await trigger(f, "s")).reason).toBe("pruning_active")
  })

  it("does not trigger when provider-reported context is below the threshold", async () => {
    const { f, jev } = await setup()
    await runContext(f, "s", transcript())
    await step(f, "s", 1_000, 20_000)
    await runContext(f, "s", transcript())
    expect(jev.calls).toHaveLength(0)
    expect((await trigger(f, "s")).reason).toBe("waiting_threshold")
  })

  it("counts growth from the trigger figure and respects the cooldown", async () => {
    const { f, jev, tick } = await setup({ cooldownMs: 60_000, minGrowthTokens: 8_000 })
    const msgs = transcript()
    await runContext(f, "s", msgs)
    await step(f, "s", 1_500, 33_000)
    await runContext(f, "s", msgs)
    const first = jev.calls.length
    expect(first).toBeGreaterThan(0)
    // Small growth: waiting for growth (pruning stays active and is reported as such).
    const more = [...msgs, ...transcript({ rounds: 2, bigRead: 2_000 })]
    await runContext(f, "s", more)
    await step(f, "s", 1_500, 35_000)
    await runContext(f, "s", more)
    expect(jev.calls.length).toBe(first)
    let t = await trigger(f, "s")
    expect(t.growthTokens).toBeLessThan(8_000)
    expect(t.reason).toBe("pruning_active")
    // Large growth within the cooldown: still no evaluation.
    const big = [...more, ...transcript({ rounds: 6 })]
    await step(f, "s", 1_500, 50_000)
    await runContext(f, "s", big)
    t = await trigger(f, "s")
    expect(jev.calls.length).toBe(first)
    expect(t.cooldownRemainingMs).toBeGreaterThan(0)
    // After the cooldown, the next request is evaluated.
    tick(61_000)
    await runContext(f, "s", big)
    expect(jev.calls.length).toBeGreaterThan(first)
  })

  it("reports each waiting reason without making requests", async () => {
    const { f, jev, tick } = await setup({ cooldownMs: 60_000, minGrowthTokens: 50_000 })
    const msgs = transcript()
    await runContext(f, "s", msgs)
    await step(f, "s", 1_500, 33_000)
    await runContext(f, "s", msgs)
    const n = jev.calls.length
    await f.rpc.reset({ sessionID: "s" }) // no applied decisions: reasons show without the pruning label
    await runContext(f, "s", msgs)
    expect((await trigger(f, "s")).reason).toBe("waiting_growth")
    expect(jev.calls.length).toBe(n)
    tick(1)
    expect(["waiting_growth", "cooldown"]).toContain((await trigger(f, "s")).reason)
  })

  it("all-protected tool results: no request, reason no_eligible_results", async () => {
    const { f, jev } = await setup({ compactAtTokens: 1_000, minGrowthTokens: 0, cooldownMs: 0 })
    const msgs: any[] = [new UserMessage({ role: "user", content: [{ type: "text", text: "Implement the feature." }] })]
    for (let i = 0; i < 8; i++) {
      const id = `edit_${i}`
      msgs.push(new AssistantMessage({ role: "assistant", content: [{ type: "tool-call", id, name: "edit", input: { path: `src/f${i}.ts` } }] }))
      msgs.push(new ToolMessage({ role: "tool", content: [{ type: "tool-result", id, name: "edit", result: { type: "text", value: "y".repeat(5_000) } }] }))
    }
    msgs.push(new UserMessage({ role: "user", content: [{ type: "text", text: "Continue." }] }))
    const ev = await runContext(f, "s", msgs)
    expect(jev.calls).toHaveLength(0)
    expect(ev.messages).toBe(msgs)
    const t = await trigger(f, "s")
    expect(t).toMatchObject({ reason: "no_eligible_results", eligibleResults: 0 })
    expect(t.protectedResults).toBe(8)
  })

  it("an identical context is not re-evaluated (no_new_tool_calls)", async () => {
    const { f, jev } = await setup({ compactAtTokens: 1_000, minGrowthTokens: 0, cooldownMs: 0, minReductionRatio: 0.99 })
    const msgs = transcript()
    await runContext(f, "s", msgs)
    const n = jev.calls.length
    expect(n).toBeGreaterThan(0)
    expect((await trigger(f, "s")).reason).toBe("insufficient_reduction")
    await runContext(f, "s", msgs)
    expect(jev.calls.length).toBe(n)
    expect(["no_new_tool_calls", "no_eligible_results"]).toContain((await trigger(f, "s")).reason)
  })

  it("session override off: disabled, no requests, unpruned; another session still evaluates", async () => {
    const { f, jev } = await setup({ compactAtTokens: 1_000 })
    await runContext(f, "A", transcript())
    const before = jev.calls.length
    await f.rpc.setSessionMode({ sessionID: "A", mode: "off" })
    const msgs = transcript()
    const ev = await runContext(f, "A", msgs)
    expect(ev.messages).toBe(msgs)
    expect(jev.calls.length).toBe(before)
    expect((await trigger(f, "A")).reason).toBe("disabled")
    await runContext(f, "B", transcript())
    expect(jev.calls.length).toBeGreaterThan(before)
  })

  it("budget exhausted is detected locally before any request", async () => {
    const { f, jev } = await setup({ compactAtTokens: 1_000, budget: { perDayUSD: 0, perSessionUSD: null } })
    await runContext(f, "s", transcript())
    expect(jev.calls).toHaveLength(0)
    expect((await trigger(f, "s")).reason).toBe("budget_exhausted")
    expect(((await f.rpc.snapshot({ sessionID: "s" })) as any).state).toBe("budget")
  })

  it("missing credentials: auth_unavailable, fail open, nothing counted as a failed evaluation", async () => {
    const f = fakeContext({ ...base, compactAtTokens: 1_000 })
    const jev = mockJev()
    await createPlugin({ fetch: jev.fetch, env: {}, readFile: async () => { throw new Error("no file") }, snapshotPath: "/dev/null" }).setup(f.ctx)
    const msgs = transcript()
    const ev = await runContext(f, "s", msgs)
    expect(ev.messages).toBe(msgs)
    expect(jev.calls).toHaveLength(0)
    const snap: any = await f.rpc.snapshot({ sessionID: "s" })
    expect(snap.session.trigger.reason).toBe("auth_unavailable")
    expect(snap.session.trigger.lastError).toMatch(/no API key/)
    expect(snap.session.failures).toBe(0)
  })

  it("API failure: evaluation_failed with a sanitized error; request unpruned; stored history untouched", async () => {
    const { f, jev } = await setup({ compactAtTokens: 1_000, maxRetries: 0 }, mockJev({ status: [500, 500, 500] }))
    const msgs = transcript({ secret: true })
    const snapshot = JSON.stringify(msgs)
    const ev = await runContext(f, "s", msgs)
    expect(ev.messages).toBe(msgs)
    expect(JSON.stringify(msgs)).toBe(snapshot)
    const snap: any = await f.rpc.snapshot({ sessionID: "s" })
    expect(snap.session.trigger.reason).toBe("evaluation_failed")
    expect(snap.session.trigger.lastError).toMatch(/HTTP 500/)
    expect(snap.session).toMatchObject({ attempts: 1, evaluations: 0, failures: 1 })
    expect(JSON.stringify(snap)).not.toMatch(/sk-proj|ts-test-key|output 0/)
    expect(jev.calls.length).toBeGreaterThan(0)
  })

  it("successful pruning keeps protected and recent content and never mutates the stored history", async () => {
    const { f } = await setup({ compactAtTokens: 1_000 })
    const msgs = transcript()
    const edit: any[] = [
      new AssistantMessage({ role: "assistant", content: [{ type: "tool-call", id: "keep_edit", name: "edit", input: { path: "src/a.ts" } }] }),
      new ToolMessage({ role: "tool", content: [{ type: "tool-result", id: "keep_edit", name: "edit", result: { type: "text", value: "edited " + "z".repeat(4_000) } }] }),
    ]
    const all = [...msgs.slice(0, 2), ...edit, ...msgs.slice(2)]
    const snapshot = JSON.stringify(all)
    const ev = await runContext(f, "s", all)
    expect(ev.messages.length).toBeLessThan(all.length)
    const ids = ev.messages.flatMap((m: any) => m.content.filter((p: any) => p.type === "tool-call").map((p: any) => p.id))
    expect(ids).toContain("keep_edit")
    // The newest messages (recent window) are sent unchanged.
    expect(ev.messages.slice(-3)).toEqual(all.slice(-3))
    expect(JSON.stringify(all)).toBe(snapshot)
    const snap: any = await f.rpc.snapshot({ sessionID: "s" })
    expect(snap.session).toMatchObject({ attempts: 1, evaluations: 1, applied: 1 })
    expect(snap.session.trigger.reason).toBe("pruning_active")
  })

  it("after a plugin reload, the last diagnostics stay visible and the trigger resumes from the persisted provider figure", async () => {
    const ledgerPath = process.env.JEV_LEDGER_FILE
    const a = await setup({}, mockJev(), { ledgerPath })
    await runContext(a.f, "s", transcript())
    await step(a.f, "s", 1_500, 33_000)
    await runContext(a.f, "s", transcript())
    await a.cleanup()
    const b = await setup({}, mockJev(), { ledgerPath })
    const snap: any = await b.f.rpc.snapshot({ sessionID: "s" })
    expect(snap.session.trigger).toMatchObject({ reason: "pruning_active", providerContextTokens: 34_500 }) // persisted
    expect(snap.session.evaluations).toBeGreaterThan(0) // persisted history
    expect((await b.f.rpc.status({ sessionID: "s" })).text).toMatch(/trigger: Pruning active/)
    const fresh: any = await b.f.rpc.snapshot({ sessionID: "never-seen" })
    expect(fresh.session.trigger).toBeNull()
    expect((await b.f.rpc.status({ sessionID: "never-seen" })).text).toMatch(/trigger: not checked yet/)
    // The reloaded instance resumes from the persisted provider figure (no fallback to the low estimate).
    await runContext(b.f, "s", transcript())
    expect((await trigger(b.f, "s")).providerContextTokens).toBe(34_500)
    expect((await trigger(b.f, "s")).triggerContextTokens).toBeGreaterThanOrEqual(34_500)
    // A session without a persisted provider figure falls back to the estimate until the provider reports.
    await runContext(b.f, "n", transcript())
    expect((await trigger(b.f, "n")).providerContextTokens).toBeNull()
    await step(b.f, "n", 1_500, 33_000)
    await runContext(b.f, "n", transcript())
    expect((await trigger(b.f, "n")).providerContextTokens).toBe(34_500)
  })

  it("/jev-status and /jev-stats show the trigger diagnostics; status commands make no requests", async () => {
    const { f, jev } = await setup()
    await runContext(f, "s", transcript())
    await step(f, "s", 1_000, 10_000)
    await runContext(f, "s", transcript())
    const status = (await f.rpc.status({ sessionID: "s" })).text
    expect(status).toMatch(/trigger: Waiting for context threshold \[waiting_threshold\]/)
    expect(status).toMatch(/provider-reported 11k, estimated messages [\d.]+k, used for trigger [\d.]+k \/ threshold 30k/)
    expect(status).toMatch(/tool results: \d+ eligible, \d+ pinned/)
    const stats = (await f.rpc.stats({ sessionID: "s" })).text
    expect(stats).toMatch(/trigger: Waiting for context threshold/)
    expect(stats).toMatch(/Evaluation attempts: 0; successful 0; failed 0/)
    expect(jev.calls).toHaveLength(0)
  })
})
