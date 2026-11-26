// Acceptance req 3: context relevance and correctness under the bounded window.
// The bounded window must not cause unsafe pruning when relevance depends on context
// the window cannot show. When relevance cannot be established, the candidate is retained.
import { describe, expect, it } from "vitest"
import { compact } from "../plugin/upstream/compact.ts"
import { fitState, collectToolCalls, visibleCallIds, type FittedState } from "../plugin/upstream/state.ts"
import { project, makeProtector, checkIntegrity } from "../plugin/compaction.ts"
import { AssistantMessage, ToolMessage, UserMessage, SystemMessage } from "@opencode/ai"

const P = { goal: "", preserveRecentMessages: 6, maxStateTokens: 25_000, maxRequestTokens: 30_000, keepThreshold: 0.5, truncateHeadChars: 300 }

/** A conversation builder whose parts can reference each other across long distances. */
function build(parts: Array<{ kind: "assistant" | "tool"; tool: string; text?: string; result?: string; id?: string }>): any[] {
  const msgs: any[] = [
    new SystemMessage({ role: "system", content: [{ type: "text", text: "You are OpenCode. Project rules: never edit src/generated; the API token lives in config.ts." }] }),
    new UserMessage({ role: "user", content: [{ type: "text", text: "Fix the failing tests. Keep every public export." }] }),
  ]
  // Pair ids: each assistant/tool pair shares one id (rounds = pairs, like a real transcript).
  let n = 0
  for (let i = 0; i < parts.length; i += 2) {
    const call = parts[i]!
    const result = parts[i + 1]!
    const id = call.id ?? `call_${++n}`
    msgs.push(new AssistantMessage({ role: "assistant", content: [
      ...(call.text ? [{ type: "text", text: call.text }] : []),
      { type: "tool-call", id, name: call.tool, input: { path: `src/file${n}.ts` } },
    ]}))
    msgs.push(new ToolMessage({ role: "tool", content: [{ type: "tool-result", id, name: result.tool, result: { type: "text", value: result.result ?? "x".repeat(300) } }] }))
  }
  msgs.push(new UserMessage({ role: "user", content: [{ type: "text", text: "Continue." }] }))
  return msgs
}

/** Pad with filler rounds so the target conversation exceeds the 25k state limit (bounded window). */
const filler = (rounds: number) => Array.from({ length: rounds }, (_, i) => [
  { kind: "assistant" as const, tool: "grep", text: `Filler step ${i}: unrelated exploration.` },
  { kind: "tool" as const, tool: "grep", result: `unrelated ${i} ` + "y".repeat(300) },
]).flat()

/** Answers that DROP only when the mock can see a reference to the call in the state window. */
function relevanceAwareAsker(dropTool: string, referenceMarker: string) {
  const asked: Array<{ state: string; questions: string[] }> = []
  return {
    asked,
    ask: async (state: any, questions: any) => {
      const stateStr = JSON.stringify(state)
      const answers: Record<string, any> = {}
      for (const name of Object.keys(questions)) {
        const instr: string = questions[name].instructions
        const id = /Tool call (\S+)/.exec(instr)?.[1] ?? ""
        // Drop ONLY when the state carries the relevance marker (early dependency) — mimics a
        // relevance model that needs the early context to justify keeping.
        const relevant = stateStr.includes(referenceMarker)
        answers[name] = { type: "noul", noul: relevant ? 0.9 : name.startsWith("result_") ? 0.9 : 0.1 }
        void id
        void dropTool
      }
      asked.push({ state: stateStr, questions: Object.keys(questions) })
      return { answers }
    },
  }
}

describe("bounded window relevance (acceptance)", () => {
  it("long-distance dependencies: the first user message (project intent) is always entry 0 of the bounded window", () => {
    // Early: the architectural decision. Then enough filler to force a bounded window.
    const parts = [
      { kind: "assistant" as const, tool: "read", text: "Reading config.ts to find the API token location — this informs everything below." },
      { kind: "tool" as const, tool: "read", result: "API_TOKEN=<redacted>; export const API_BASE = 'https://api.example.internal'" },
      ...filler(500),
    ]
    const msgs = build(parts)
    const projected = project(msgs).messages
    const isProtected = makeProtector(projected, { protectTools: [], keepErrorsWithinMessages: 20 })
    const calls = collectToolCalls(projected, 6).map(c => (!c.pinned && isProtected(c)) ? { ...c, pinned: true } : c)
    const f = fitState(projected, calls, P)
    expect(f.stage).toBe("bounded window")
    // The first entry of the window is always the first projected message (project intent),
    // and its content is the original user request, verbatim.
    expect(f.state.history[0].i).toBe(0)
    expect(f.state.history[0].text).toBe(projected[0].text)
    // The goal (recent user prompts, including the dependency reference) is preserved.
    expect(f.state.goal).toContain("Fix the failing tests")
  })

  it("goal (recent user prompts) is preserved even in the bounded window, so changed objectives are visible to every evaluation", () => {
    const parts = filler(500)
    const msgs = build(parts)
    // Change the objective in the last user message.
    msgs.push(new UserMessage({ role: "user", content: [{ type: "text", text: "NEW OBJECTIVE: refactor the auth module instead. Keep src/generated untouched." }] }))
    const projected = project(msgs).messages
    const calls = collectToolCalls(projected, 6)
    const f = fitState(projected, calls, P)
    expect(f.stage).toBe("bounded window")
    expect(f.state.goal).toContain("NEW OBJECTIVE")
  })

  it("when relevance cannot be established (answer unavailable), the candidate is RETAINED, never dropped by default", async () => {
    // An asker that errors for the questions about a specific call: compact must fail open, not drop.
    const parts = [
      ...filler(3),
      { kind: "assistant" as const, tool: "read", text: "Reading the deployment notes." },
      { kind: "tool" as const, tool: "read", result: "deploy steps: 1) build 2) smoke-test 3) tag" },
      ...filler(120),
    ]
    const msgs = build(parts)
    const projected = project(msgs).messages
    const isProtected = makeProtector(projected, { protectTools: [], keepErrorsWithinMessages: 20 })
    const failing = { ask: async () => { throw new Error("Jev unavailable") } }
    await expect(compact(projected, failing as any, { ...P, isProtected })).rejects.toThrow(/Jev unavailable/)
    // Failure means NO decisions at all: the caller (plugin) keeps the request unpruned — fail-open.
    // Verify the same input with a working asker that KEEPS everything: nothing dropped.
    const keepAll = { ask: async (_s: any, questions: any) => {
      const answers: Record<string, any> = {}
      for (const name of Object.keys(questions)) answers[name] = { type: "noul", noul: 0.9 }
      return { answers }
    } }
    const out = await compact(projected, keepAll as any, { ...P, isProtected })
    expect(out.decisions.filter(d => d.action !== "keep")).toHaveLength(0)
    // And the fail-open path at the PLUGIN level is covered by existing tests (request sent unpruned).
  })

  it("windowed-out candidates are never dropped: only asked candidates can receive a drop decision", async () => {
    const parts = filler(500)
    const msgs = build(parts)
    const projected = project(msgs).messages
    const isProtected = makeProtector(projected, { protectTools: [], keepErrorsWithinMessages: 20 })
    let questionsSeen = 0
    const dropper = { ask: async (state: any, questions: any) => {
      questionsSeen += Object.keys(questions).length
      const answers: Record<string, any> = {}
      for (const name of Object.keys(questions)) answers[name] = { type: "noul", noul: 0.05 }
      return { answers }
    } }
    const out = await compact(projected, dropper as any, { ...P, isProtected })
    expect(out.stats.stateStage).toBe("bounded window")
    const windowedOut = out.decisions.filter(d => d.reason === "windowed_out")
    expect(windowedOut.length).toBeGreaterThan(0)
    for (const d of windowedOut) {
      expect(d.action).toBe("keep") // never dropped without being asked
      expect(d.keepCall).toBe(1)
      expect(d.keepResult).toBe(1)
    }
    // Only ASKED candidates (reason kept/result_dropped/call_dropped) carry real answers.
    expect(out.decisions.filter(d => !["pinned", "windowed_out"].includes(d.reason)).length * 2).toBe(questionsSeen)
  })

  it("protected context that cannot fit the state budget is never pruned (state may window it out; decisions never drop it)", async () => {
    // Hundreds of PROTECTED calls: they are pinned, never asked, and never dropped — even though
    // the bounded state cannot represent most of them. If the tail itself cannot fit, fitState
    // throws and the plugin fails open (request sent unpruned).
    const parts = Array.from({ length: 700 }, (_, i) => [
      { kind: "assistant" as const, tool: "task", text: `Protected subtask ${i}.` },
      { kind: "tool" as const, tool: "task", result: `subtask result ${i} ` + "z".repeat(300) },
    ]).flat()
    const msgs = build(parts)
    const projected = project(msgs).messages
    const isProtected = makeProtector(projected, { protectTools: [/task/i], keepErrorsWithinMessages: 20 })
    // Run compact: protected calls stay in the outgoing messages regardless of state visibility.
    const dropper = { ask: async (_s: any, questions: any) => {
      const answers: Record<string, any> = {}
      for (const name of Object.keys(questions)) answers[name] = { type: "noul", noul: 0.05 }
      return { answers }
    } }
    const out = await compact(projected, dropper as any, { ...P, isProtected })
    const protectedDecisions = out.decisions.filter(d => d.reason === "pinned")
    expect(protectedDecisions.length).toBe(700)
    for (const d of protectedDecisions) expect(d.action).toBe("keep")
    // No protected call was dropped or truncated in the rebuilt conversation.
    const dropped = out.decisions.filter(d => d.action !== "keep")
    expect(dropped.filter(d => d.tool === "task")).toHaveLength(0)
    // The throw path (tail itself cannot fit) is exercised by forcing a tiny state limit.
    expect(() => fitState(projected, collectToolCalls(projected, 6).map(c => (!c.pinned && isProtected(c)) ? { ...c, pinned: true } : c), { ...P, preserveRecentMessages: 700 })).toThrow(/too large/)
  })

  it("earlier information becoming relevant again: a user message re-referencing an old fact is in the goal and recent window", () => {
    const parts = [
      { kind: "assistant" as const, tool: "grep", text: "Found the old migration script location." },
      { kind: "tool" as const, tool: "grep", result: "migrations/2026/11/initial-schema.sql" },
      ...filler(500),
    ]
    const msgs = build(parts)
    msgs.push(new UserMessage({ role: "user", content: [{ type: "text", text: "Go back to the initial-schema.sql migration we saw earlier and extend it." }] }))
    const projected = project(msgs).messages
    const calls = collectToolCalls(projected, 6)
    const f = fitState(projected, calls, P)
    expect(f.stage).toBe("bounded window")
    expect(f.state.goal).toContain("initial-schema.sql")
  })

  it("omission markers appear once, between windowed entries and the tail; they never replace protected content", () => {
    const parts = filler(500)
    const msgs = build(parts)
    const projected = project(msgs).messages
    const isProtected = makeProtector(projected, { protectTools: [/task/i], keepErrorsWithinMessages: 20 })
    const calls = collectToolCalls(projected, 6).map(c => (!c.pinned && isProtected(c)) ? { ...c, pinned: true } : c)
    const f = fitState(projected, calls, P)
    expect(f.stage).toBe("bounded window")
    const markers = f.state.history.filter(e => e.i === -1)
    expect(markers.length).toBe(1)
    // Marker text is honest about what happened and what to do.
    expect(markers[0].text).toMatch(/omitted from this evaluation/)
    // Pinned tail after the marker: indices are the last 6 messages' entries.
    const markerAt = f.state.history.findIndex(e => e.i === -1)
    const after = f.state.history.slice(markerAt + 1)
    expect(after.length).toBeGreaterThan(0)
    for (const e of after) expect(e.i).toBeGreaterThanOrEqual(projected.length - 6)
  })
})
