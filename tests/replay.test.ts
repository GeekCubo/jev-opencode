// Local-only replay of a real OpenCode 2.2.7 session through the plugin's context hook (mock Jev; no network).
// Not part of the repository. REPLAY_MSGS points at a /api/session/:id/message export.
import { readFileSync } from "node:fs"
import { AssistantMessage, ToolMessage, UserMessage } from "@opencode/ai"
import { it } from "vitest"
import { createPlugin } from "../plugin/index.ts"
import { fakeContext, mockJev, runContext } from "./fixtures.ts"

it.skipIf(!process.env.REPLAY_MSGS)("replays an exported OpenCode session through the context hook", async () => {
  const raw = JSON.parse(readFileSync(process.env.REPLAY_MSGS!, "utf8")).data.slice().reverse()
  const options = JSON.parse(process.env.REPLAY_OPTIONS!)
  const f = fakeContext(options, { models: [{ providerID: "provider-b", id: "model-b1", limit: { context: 1_000_000 }, cost: [{ input: 5 }] }] })
  const jev = mockJev()
  // The clock follows the session's own message timestamps, so cooldowns behave as they did in the real session.
  let clock = raw[0]?.time?.created ?? Date.now()
  await createPlugin({ fetch: jev.fetch, env: { TYPESAFE_API_KEY: "replay-key-123456" }, snapshotPath: "/dev/null", now: () => clock }).setup(f.ctx)
  const sid = "ses_replay"
  const history: any[] = []
  const rows: string[] = []
  for (const m of raw) {
    if (m.type === "user") history.push(new UserMessage({ role: "user", content: [{ type: "text", text: m.text }] }))
    if (m.type === "synthetic") history.push(new UserMessage({ role: "user", content: [{ type: "text", text: m.text ?? "" }] }))
    if (m.type !== "assistant") continue
    clock = m.time?.created ?? clock
    // The request that produced this assistant message is sent with the history so far.
    const before = jev.calls.length
    const ev = await runContext(f, sid, history.slice(), { providerID: "provider-b", id: "model-b1" })
    const snap: any = await f.rpc.snapshot({ sessionID: sid })
    const t = m.tokens
    const provider = t.input + t.cache.read + t.cache.write
    const tr = snap.session.trigger
    rows.push(`${String(rows.length + 1).padStart(2)} provider=${provider} sent=${ev.messages.length}/${history.length} jev+${jev.calls.length - before} ${tr ? `${tr.reason} trig=${tr.triggerContextTokens} est=${tr.estimatedContextTokens} thr=${tr.thresholdTokens} growth=${tr.growthTokens} cool=${Math.round(tr.cooldownRemainingMs / 1000)}s elig=${tr.eligibleResults}/${tr.protectedResults}` : "-"}`)
    f.emit({ type: "session.step.ended", data: { sessionID: sid, cost: 0, tokens: { input: t.input, output: t.output, cache: t.cache } } })
    await new Promise((r) => setTimeout(r, 5))
    const content: any[] = []
    for (const c of m.content ?? []) {
      if (c.type === "text") content.push({ type: "text", text: c.text })
      if (c.type === "tool") content.push({ type: "tool-call", id: c.id, name: c.name, input: c.state?.input ?? {} })
    }
    history.push(new AssistantMessage({ role: "assistant", content }))
    for (const c of m.content ?? [])
      if (c.type === "tool")
        history.push(new ToolMessage({ role: "tool", content: [{ type: "tool-result", id: c.id, name: c.name, result: { type: "text", value: (c.state?.content ?? []).map((p: any) => p.text ?? "").join("") } }] }))
  }
  const snap: any = await f.rpc.snapshot({ sessionID: sid })
  console.log(rows.join("\n"))
  console.log("TOTAL jev requests", jev.calls.length, "evaluations", snap.session.evaluations, "applied", snap.session.applied, "requestsPruned", snap.session.requestsPruned)
}, 120_000)
