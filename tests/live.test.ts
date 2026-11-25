// Live TypeSafe test. Runs only with LIVE_JEV=1. Hard cap enforced before every request.
import { describe, expect, it } from "vitest"
import { homedir } from "node:os"
import { join } from "node:path"
import { writeFileSync } from "node:fs"
import { AssistantMessage, SystemMessage, ToolMessage, UserMessage } from "@opencode/ai"
import { createPlugin } from "../plugin/index.ts"
import { createJevClient, resolveApiKey } from "../plugin/jev.ts"
import { estimateTokens } from "../plugin/util.ts"
import { fakeContext, runContext } from "./fixtures.ts"

const CAP_USD = 0.05
const PRICE = 0.042 / 1e6
const URL = "https://api.typesafe.ai/v1/systemone"
const ledger = { estimatedUSD: 0, measuredTokens: 0, requests: 0, latencies: [] as number[], statuses: [] as number[] }
let halted: string | undefined

/** Real fetch with pre-request cap enforcement and a hard stop on auth/persistent failures. */
const guardedFetch = (async (url: string, init: any) => {
  if (halted) throw new Error(`halted: ${halted}`)
  if (url !== URL) throw new Error("unexpected URL")
  const est = Math.ceil(estimateTokens(init.body) * 1.3) // conservative margin
  if (ledger.estimatedUSD + est * PRICE > CAP_USD) throw new Error("spending cap reached")
  ledger.estimatedUSD += est * PRICE
  const t0 = performance.now()
  const res = await fetch(url, init)
  ledger.latencies.push(Math.round(performance.now() - t0))
  ledger.statuses.push(res.status)
  ledger.requests++
  if (res.status === 401 || res.status === 403) halted = `auth error ${res.status}`
  if (ledger.statuses.slice(-3).length === 3 && ledger.statuses.slice(-3).every((s) => s >= 429)) halted = "persistent API failures"
  const text = await res.clone().text()
  try {
    const n = JSON.parse(text)?.usage?.input_tokens
    if (typeof n === "number") ledger.measuredTokens += n
  } catch {}
  return res
}) as unknown as typeof fetch

const big = (label: string, n: number) => Array.from({ length: n }, (_, i) => `${label} line ${i}: ${"lorem ipsum dolor sit amet ".repeat(3)}`).join("\n")

/** Synthetic non-sensitive dev transcript: relevant + irrelevant tool calls. */
function transcript() {
  const m: any[] = [
    new SystemMessage({ role: "system", content: [{ type: "text", text: "You are a coding agent. Follow AGENTS.md." }] }),
    new UserMessage({ role: "user", content: [{ type: "text", text: "Fix the off-by-one bug in src/range.ts so `range(1,3)` returns [1,2,3]. Acceptance: npm test passes. Never edit vendor/." }] }),
  ]
  let k = 0
  const call = (name: string, input: any, out: string, text = "") => {
    const id = `toolu_live_${++k}`
    m.push(new AssistantMessage({ role: "assistant", content: [...(text ? [{ type: "text" as const, text }] : []), { type: "tool-call" as const, id, name, input }] }))
    m.push(new ToolMessage({ role: "tool", content: [{ type: "tool-result", id, name, result: { type: "text", value: out } }] }))
    return id
  }
  const ids: Record<string, string> = {}
  ids.agents = call("read", { path: "AGENTS.md" }, "# Rules\n- Never edit vendor/\n- Run npm test before finishing\n" + big("rule", 20), "Reading project rules.")
  ids.ls = call("bash", { command: "ls -R node_modules | head -400" }, big("node_modules/pkg", 120), "Exploring.")
  ids.grepVendor = call("grep", { pattern: "range", path: "vendor/" }, big("vendor/lodash/range.js match", 100))
  ids.readmeOther = call("read", { path: "vendor/lodash/README.md" }, big("lodash readme", 120))
  ids.oldLog = call("bash", { command: "cat logs/build-2025-01-01.log" }, big("2025-01-01 build ok", 120))
  ids.readRange1 = call("read", { path: "src/range.ts" }, "export function range(a: number, b: number) {\n  const out = []\n  for (let i = a; i < b; i++) out.push(i)\n  return out\n}\n", "Reading the buggy file.")
  ids.testFail = call("bash", { command: "npm test" }, "FAIL test/range.test.ts\n  expected [1,2,3] received [1,2]\n" + big("jest trace", 30))
  ids.grepSrc = call("grep", { pattern: "range(", path: "src/" }, "src/range.ts:1\nsrc/index.ts:4\n")
  ids.readIndex = call("read", { path: "src/index.ts" }, big("index export", 40))
  ids.oldLog2 = call("bash", { command: "cat logs/deploy-old.log" }, big("deploy old", 120))
  ids.edit = call("edit", { path: "src/range.ts", old: "i < b", new: "i <= b" }, "Edit applied.", "Fixing the comparison.")
  ids.testPass = call("bash", { command: "npm test" }, "PASS test/range.test.ts\n3 passed")
  m.push(new UserMessage({ role: "user", content: [{ type: "text", text: "Now also add a test for range(0,0)." }] }))
  return { messages: m, ids }
}

const partsById = (msgs: any[]) => {
  const map = new Map<string, any>()
  for (const x of msgs) for (const p of x.content) if (p.type === "tool-result") map.set(p.id, p)
  return map
}
const callIds = (msgs: any[]) => new Set(msgs.flatMap((x) => x.content.filter((p: any) => p.type === "tool-call").map((p: any) => p.id)))
const chars = (msgs: any[]) => JSON.stringify(msgs).length

const live = process.env.LIVE_JEV === "1"
const report: Record<string, unknown> = {}
const options = { endpoint: "typesafe", model: "jev-1.14", compactAtTokens: 2_000, minGrowthTokens: 0, cooldownMs: 0, minReductionRatio: 0.05, preserveRecentMessages: 4, maxRetries: 1, budget: { perSessionUSD: CAP_USD, perDayUSD: CAP_USD } }
const deps = { fetch: guardedFetch, env: {}, configDir: join(homedir(), ".config", "opencode") }

describe.runIf(live).sequential("LIVE TypeSafe jev-1.14", () => {
  it("1-3 auth, request compatibility, parsing, usage", async () => {
    const key = await resolveApiKey("typesafe", { env: {}, configDir: deps.configDir })
    expect(typeof key === "string" && key.length > 10 && key === key.trim()).toBe(true)
    const client = createJevClient({ url: URL, model: "jev-1.14.0", apiKey: key!, timeoutMs: 20_000, maxRetries: 0, fetch: guardedFetch }, estimateTokens)
    const t0 = performance.now()
    const r = await client.ask("The test suite failed with an off-by-one error.", { failed: { type: "noul", instructions: "Did a test fail?" } })
    report.smoke = { status: ledger.statuses.at(-1), model: r.model, noul: (r.answers.failed as any).noul, usage: r.usage, ms: Math.round(performance.now() - t0) }
    expect(halted).toBeUndefined()
    expect(typeof (r.answers.failed as any).noul).toBe("number")
    expect(typeof r.usage?.input_tokens).toBe("number")
  }, 30_000)

  it("4 dry-run: Jev evaluates, request untouched", async () => {
    const { messages } = transcript()
    const snapshot = JSON.stringify(messages)
    const f = fakeContext({ ...options, mode: "dry-run" })
    await createPlugin(deps).setup(f.ctx)
    const before = ledger.requests
    const ev = await runContext(f, "dry", messages)
    expect(halted).toBeUndefined()
    expect(ledger.requests).toBeGreaterThan(before)
    expect(ev.messages).toBe(messages)
    expect(JSON.stringify(messages)).toBe(snapshot)
    await f.commands["jev-stats"].execute({ sessionID: "dry" })
    report.dryRun = { jevRequests: ledger.requests - before, stats: f.synthetic.at(-1).text.split("\n").slice(1, 6) }
  }, 60_000)

  it("4-7 active: pruning, protection, verbatim, history unchanged, recovery", async () => {
    const { messages, ids } = transcript()
    const snapshot = JSON.stringify(messages)
    const f = fakeContext({ ...options, mode: "active", logDecisions: true })
    await createPlugin(deps).setup(f.ctx)
    const before = ledger.requests
    const ev = await runContext(f, "act", messages)
    expect(halted).toBeUndefined()
    const out = ev.messages
    const kept = callIds(out)
    const orig = partsById(messages), now = partsById(out)
    // protected: AGENTS.md read, edit, failing/passing test output, latest user prompt, system
    for (const k of ["agents", "edit", "testPass"]) expect(kept.has(ids[k])).toBe(true)
    expect(out[0]).toBe(messages[0])
    expect(out.at(-1)).toBe(messages.at(-1))
    // retained results verbatim or explicitly marked truncated; never silently altered
    let verbatim = 0, truncated = 0
    for (const [id, p] of now) {
      if (p === orig.get(id) || JSON.stringify(p) === JSON.stringify(orig.get(id))) verbatim++
      else (expect(String(p.result.value)).toMatch(/fast-jev-compaction truncated/), expect(orig.get(id).result.value.startsWith(String(p.result.value).split("\n[fast-jev")[0])).toBe(true), truncated++)
    }
    // user/assistant text verbatim
    const texts = (ms: any[]) => ms.filter((x) => x.role === "user").flatMap((x) => x.content.filter((p: any) => p.type === "text").map((p: any) => p.text))
    expect(texts(out)).toEqual(texts(messages))
    // 6 stored history unchanged
    expect(JSON.stringify(messages)).toBe(snapshot)
    // 7 recovery: disabling returns the full original context on the next request
    await f.commands["jev-disable"].execute({ sessionID: "act" })
    const restored = await runContext(f, "act", messages)
    expect(restored.messages).toBe(messages)
    await f.commands["jev-enable"].execute({ sessionID: "act" })
    await f.commands["jev-stats"].execute({ sessionID: "act" })
    const name = Object.fromEntries(Object.entries(ids).map(([k, v]) => [v, k]))
    report.active = {
      jevRequests: ledger.requests - before,
      charsBefore: chars(messages),
      charsAfter: chars(out),
      reductionPct: +(100 * (1 - chars(out) / chars(messages))).toFixed(1),
      dropped: [...callIds(messages)].filter((id) => !kept.has(id)).map((id) => name[id]),
      truncated: [...now].filter(([id, p]) => p !== orig.get(id) && JSON.stringify(p) !== JSON.stringify(orig.get(id))).map(([id]) => name[id]),
      keptVerbatim: verbatim,
      stats: f.synthetic.at(-1).text.split("\n").slice(1, 7),
    }
    void truncated
  }, 60_000)

  it("8 failures leave the request intact (no spend)", async () => {
    const { messages } = transcript()
    for (const failing of [
      (async () => { throw new TypeError("network down") }) as unknown as typeof fetch,
      (async () => new Response("{}", { status: 500 })) as unknown as typeof fetch,
    ]) {
      const f = fakeContext({ ...options, mode: "active", maxRetries: 0 })
      await createPlugin({ ...deps, fetch: failing }).setup(f.ctx)
      const ev = await runContext(f, "fail", messages)
      expect(ev.messages).toBe(messages)
    }
  })

  it("ledger", () => {
    report.ledger = {
      requests: ledger.requests,
      statuses: ledger.statuses,
      measuredInputTokens: ledger.measuredTokens,
      measuredCostUSD: +(ledger.measuredTokens * PRICE).toFixed(6),
      reservedEstimateUSD: +ledger.estimatedUSD.toFixed(6),
      latencyMs: { min: Math.min(...ledger.latencies), median: ledger.latencies.sort((a, b) => a - b)[Math.floor(ledger.latencies.length / 2)], max: Math.max(...ledger.latencies) },
      halted: halted ?? null,
    }
    writeFileSync("reports/live-jev.json", JSON.stringify(report, null, 2))
    expect(ledger.estimatedUSD).toBeLessThanOrEqual(CAP_USD)
  })
})
