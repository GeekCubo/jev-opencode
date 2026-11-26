// Large-session evaluation: the bounded state window (0.2.3).
// A session whose collapsed history still exceeds maxStateTokens must still be
// evaluated: the state becomes a bounded window, only visible calls are asked,
// windowed-out calls stay candidates (never silently evaluated), and every
// request respects the token ceilings.
import { describe, expect, it } from "vitest"
import { AssistantMessage, ToolMessage, UserMessage, SystemMessage } from "@opencode/ai"
import { createPlugin } from "../plugin/index.ts"
import { fakeContext, mockJev, runContext, transcript } from "./fixtures.ts"
import { compact } from "../plugin/upstream/compact.ts"
import { fitState, collectToolCalls, estimateTokens } from "../plugin/upstream/state.ts"
import { project, makeProtector, checkIntegrity } from "../plugin/compaction.ts"

const env = { TYPESAFE_API_KEY: "ts-test-key-123456" }
const base = { mode: "active", compactAtTokens: 1_000, minGrowthTokens: 0, cooldownMs: 0, budget: { perDayUSD: null, perSessionUSD: null } }

/** Intelligence-scale transcript: alternating assistant(tool-call)/tool(tool-result) messages. */
export function longSession(messages: number, resultChars = 300): any[] {
  const msgs: any[] = [
    new SystemMessage({ role: "system", content: [{ type: "text", text: "You are OpenCode. AGENTS.md: never edit src/generated." }] }),
    new UserMessage({ role: "user", content: [{ type: "text", text: "Fix failing tests in src/math.ts. Never edit src/generated." }] }),
  ]
  let n = 0
  while (msgs.length < messages) {
    const id = `call_${++n}`
    const tool = n % 5 === 0 ? "write" : n % 7 === 0 ? "task" : n % 3 === 0 ? "grep" : n % 3 === 1 ? "read" : "bash"
    const input = tool === "read" || tool === "write" ? { path: `src/file${n}.ts`, content: "c".repeat(150) } : tool === "grep" ? { pattern: `foo${n}` } : tool === "task" ? { description: `subtask ${n}` } : { command: `npm test -- ${n}` }
    msgs.push(new AssistantMessage({ role: "assistant", content: [
      { type: "text", text: `Step ${n}: checking src/file${n}.ts and the failing assertion.` },
      { type: "tool-call", id, name: tool, input },
    ]}))
    msgs.push(new ToolMessage({ role: "tool", content: [{ type: "tool-result", id, name: tool, result: { type: "text", value: "x".repeat(resultChars) } }] }))
  }
  msgs.push(new UserMessage({ role: "user", content: [{ type: "text", text: "Keep going: fix add() then run tests." }] }))
  return msgs
}

const P = { goal: "", preserveRecentMessages: 6, maxStateTokens: 25_000, maxRequestTokens: 30_000, keepThreshold: 0.5, truncateHeadChars: 300 }

describe("bounded evaluation state (fitState)", () => {
  it("fits a 9,166-message session that previously threw 'history too large'", () => {
    const msgs = longSession(9_166)
    const projected = project(msgs).messages
    const isProtected = makeProtector(projected, { protectTools: [], keepErrorsWithinMessages: 20 })
    const calls = collectToolCalls(projected, 6).map((c) => (!c.pinned && isProtected(c)) ? { ...c, pinned: true } : c)
    const fitted = fitState(projected, calls, P)
    expect(fitted.stage).toBe("bounded window")
    expect(fitted.tokens).toBeLessThanOrEqual(25_000)
    // The pinned tail and the first message survive; an omission marker marks the cut.
    const idx = new Set(fitted.state.history.map((e) => e.i))
    expect(idx.has(0)).toBe(true)
    expect(fitted.state.history.some((e) => e.i === -1)).toBe(true)
    // Text-bearing entries inside the pinned region (i >= length - preserveRecentMessages, or 0);
    // tool-result-only messages are never state entries (their content is folded into the call's
    // result note — upstream behaviour).
    const n = projected.length
    const pinnedText = projected.filter((_, i) => i === 0 || i >= n - 6).filter((m) => m.text.trim().length > 0).map((m) => projected.indexOf(m))
    for (const i of pinnedText) expect(idx.has(i)).toBe(true)
    // The goal (latest user prompts) is preserved.
    expect(fitted.state.goal).toContain("Keep going")
  })

  it("prefers the ordinary stages for sessions that fit (no window marker)", () => {
    const msgs = longSession(60, 600)
    const projected = project(msgs).messages
    const calls = collectToolCalls(projected, 6)
    const fitted = fitState(projected, calls, P)
    expect(fitted.stage).not.toBe("bounded window")
    expect(fitted.state.history.some((e) => e.i === -1)).toBe(false)
  })

  it("still throws when the pinned tail alone cannot fit", () => {
    // Thousands of pinned messages (preserveRecentMessages covers them all), each with a distinct
    // long text: abridged to ~550 chars each they still exceed the ceiling, so nothing fits.
    const msgs: any[] = [new UserMessage({ role: "user", content: [{ type: "text", text: "start" }] })]
    for (let i = 0; i < 2_000; i++)
      msgs.push(new UserMessage({ role: "user", content: [{ type: "text", text: `${i} ` + "lorem ipsum ".repeat(120) }] }))
    const projected = project(msgs).messages
    expect(() => fitState(projected, [], { ...P, preserveRecentMessages: 2_001 })).toThrow(/too large/)
  })
})

describe("bounded evaluation state (compact)", () => {
  it("asks only about visible calls; windowed-out calls are never decided or billed as evaluated", async () => {
    const msgs = longSession(9_166)
    const projected = project(msgs).messages
    const isProtected = makeProtector(projected, { protectTools: [], keepErrorsWithinMessages: 20 })
    let asked: string[] = []
    const asker = { ask: async (_state: any, questions: any) => {
      asked.push(...Object.keys(questions))
      const answers: Record<string, any> = {}
      for (const name of Object.keys(questions)) answers[name] = { type: "noul", noul: 0.1 }
      return { answers }
    } }
    const out = await compact(projected, asker, { ...P, isProtected })
    expect(out.stats.stateStage).toBe("bounded window")
    expect(asked.length).toBeGreaterThan(0)
    // Every asked question belongs to a call represented in the state window.
    const visible = new Set(out.decisions.filter((d) => d.reason !== "windowed_out" && d.reason !== "pinned").map((d) => d.id))
    expect(visible.size).toBe(asked.length / 2) // 2 questions per call
    // Windowed-out calls: kept, flagged, and not asked.
    const windowedOut = out.decisions.filter((d) => d.reason === "windowed_out")
    expect(windowedOut.length).toBeGreaterThan(0)
    for (const d of windowedOut) {
      expect(d.action).toBe("keep")
      expect(asked).not.toContain(`call_${d.id}`)
    }
  })

  it("keeps every request body within the token ceiling", async () => {
    const msgs = longSession(9_166)
    const projected = project(msgs).messages
    const isProtected = makeProtector(projected, { protectTools: [], keepErrorsWithinMessages: 20 })
    let maxBody = 0
    const asker = { ask: async (state: any, questions: any) => {
      maxBody = Math.max(maxBody, estimateTokens(JSON.stringify({ model: "jev-1.14.0", state, questions })))
      const answers: Record<string, any> = {}
      for (const name of Object.keys(questions)) answers[name] = { type: "noul", noul: 0.1 }
      return { answers }
    } }
    await compact(projected, asker, { ...P, isProtected })
    expect(maxBody).toBeLessThanOrEqual(30_000)
  })
})

describe("plugin level: large session flows through the context hook", () => {
  it("evaluates instead of failing; history untouched; protected and recent context preserved; requests bounded", async () => {
    const f = fakeContext({ ...base })
    const jev = mockJev()
    await createPlugin({ fetch: jev.fetch, env, snapshotPath: "/dev/null" }).setup(f.ctx)
    const msgs = longSession(3_000) // enough to overflow 25k, fast enough for the test
    const snapshot = JSON.stringify(msgs)
    const ev = await runContext(f, "s", msgs)
    // Previously: evaluation_failed with 'history too large'. Now: pruned or evaluated.
    const snap: any = await f.rpc.snapshot({ sessionID: "s" })
    expect(snap.session.trigger.lastError).toBeNull()
    expect(snap.session.attempts).toBe(1)
    expect(jev.calls.length).toBeGreaterThan(0)
    // Every request respected the ceiling.
    for (const call of jev.calls) expect(estimateTokens(JSON.stringify(call.body))).toBeLessThanOrEqual(30_000)
    // Protected calls and the recent window survive in the outgoing request.
    const ids = ev.messages.flatMap((m: any) => m.content.filter((p: any) => p.type === "tool-call").map((p: any) => p.id))
    expect(ids).toContain("call_5") // write — protected
    expect(ids).toContain("call_7") // task — protected
    for (const m of msgs.slice(-3)) expect(ev.messages).toContain(m)
    expect(checkIntegrity(ev.messages)).toBeUndefined()
    // The stored history was never modified.
    expect(JSON.stringify(msgs)).toBe(snapshot)
    // Unchanged resend does not re-evaluate (stable).
    const n = jev.calls.length
    await runContext(f, "s", [...msgs])
    expect(jev.calls.length).toBe(n)
  }, 120_000)

  it("a small session keeps its previous behaviour (full state, one request)", async () => {
    const f = fakeContext({ ...base })
    const jev = mockJev()
    await createPlugin({ fetch: jev.fetch, env, snapshotPath: "/dev/null" }).setup(f.ctx)
    const ev = await runContext(f, "s", transcript())
    expect(ev.messages.length).toBeLessThan(transcript().length)
    expect(jev.calls.length).toBeGreaterThan(0)
    const state = jev.calls[0].body.state
    expect(state.history.some((e: any) => e.i === -1)).toBe(false)
  })

  it("native compaction still resets session state and falls back cleanly", async () => {
    const f = fakeContext({ ...base })
    const jev = mockJev()
    await createPlugin({ fetch: jev.fetch, env, snapshotPath: "/dev/null" }).setup(f.ctx)
    const msgs = longSession(400)
    await runContext(f, "s", msgs)
    f.emit({ type: "session.compaction.ended", data: { sessionID: "s" } })
    await new Promise((r) => setTimeout(r, 10))
    const snap: any = await f.rpc.snapshot({ sessionID: "s" })
    expect(snap.session.nativeCompactions).toBe(1)
    expect(snap.session.pruned).toEqual({ dropped: 0, truncated: 0 })
  })
})
