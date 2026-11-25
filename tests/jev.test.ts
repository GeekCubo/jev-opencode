import { describe, expect, it, vi } from "vitest"
import { createPlugin, estimateContextTokens, applyCached } from "../plugin/index.ts"
import { resolveConfig, priceFor, thresholdFor, ConfigError } from "../plugin/config.ts"
import { createJevClient, resolveApiKey } from "../plugin/jev.ts"
import { project, prune, checkIntegrity, applyToOpenCode } from "../plugin/compaction.ts"
import { redact, redactValue, estimateTokens } from "../plugin/util.ts"
import { SECRET, fakeContext, mockJev, runContext, transcript } from "./fixtures.ts"

const base = { mode: "active", compactAtTokens: 5_000, minGrowthTokens: 0, cooldownMs: 0, maxRetries: 2, minReductionRatio: 0.1 }
const env = { TYPESAFE_API_KEY: "ts-test-key-123456" }
const SNAP = `/tmp/opencode/jev-test-snapshot-${process.pid}.json`

async function setup(options: Record<string, unknown> = {}, jev = mockJev(), extra = {}) {
  const f = fakeContext({ ...base, ...options }, extra)
  const plugin = createPlugin({ fetch: jev.fetch, env, readFile: async () => { throw new Error("no file") }, snapshotPath: SNAP })
  const cleanup = await plugin.setup(f.ctx)
  return { f, jev, cleanup }
}

const toolIds = (msgs: any[], type: string) => msgs.flatMap((m) => m.content.filter((p: any) => p.type === type).map((p: any) => p.id))

describe("config", () => {
  it("accepts the brief's nested shape and rejects routing", () => {
    const c = resolveConfig({ compaction: { enabled: true, mode: "dry-run", keepThreshold: 0.5, compactAtTokens: 60000, nativeFallback: true }, routing: { enabled: false } })
    expect(c.mode).toBe("dry-run")
    expect(c.compactAtTokens).toBe(60000)
    expect(() => resolveConfig({ routing: { enabled: true } })).toThrow(ConfigError)
    expect(resolveConfig({ compaction: { enabled: false } }).mode).toBe("off")
  })
  it("enforces price cap and requires approval for unpriced or free models", () => {
    expect(priceFor(resolveConfig({ model: "jev-1.14" }))).toBe(0.042)
    expect(() => priceFor(resolveConfig({ model: "jev-9" }))).toThrow(/approvedPricePerMTok/)
    expect(() => priceFor(resolveConfig({ model: "jev-1.13-free" }))).toThrow(/free/)
    expect(priceFor(resolveConfig({ model: "jev-9", approvedPricePerMTok: 1 }))).toBe(1)
    expect(() => resolveConfig({ approvedPricePerMTok: 2 })).toThrow()
    expect(() => priceFor(resolveConfig({ model: "jev-9", approvedPricePerMTok: 1.2, maxPricePerMTok: 1 }))).toThrow(/cap/)
    expect(() => resolveConfig({ url: "http://insecure" })).toThrow()
  })
  it("scales threshold with model context window", () => {
    const c = resolveConfig({})
    expect(thresholdFor(c, 1_000_000)).toBe(60_000)
    expect(thresholdFor(c, 32_768)).toBe(Math.floor(32_768 * 0.6))
    expect(thresholdFor(c, undefined)).toBe(60_000)
  })
})

describe("pruning adapter (upstream algorithm)", () => {
  it("drops/truncates stale tool calls, keeps text verbatim, preserves order and integrity", async () => {
    const msgs = transcript()
    const jev = mockJev()
    const client = createJevClient({ url: "https://x", model: "jev-1.14", apiKey: "k", timeoutMs: 5000, maxRetries: 0, fetch: jev.fetch }, estimateTokens)
    const out = await prune(msgs, client, { keepThreshold: 0.5, preserveRecentMessages: 6, truncateHeadChars: 300, maxStateTokens: 25000, maxRequestTokens: 30000, protection: { protectTools: [], keepErrorsWithinMessages: 20 } }, (m: any, content) => new m.constructor({ ...m, content }))
    expect(out.result.stats.callsDropped).toBeGreaterThan(0)
    expect(out.result.stats.resultsDropped).toBeGreaterThan(0)
    expect(checkIntegrity(out.messages)).toBeUndefined()
    // all text parts verbatim, same order
    const texts = (ms: any[]) => ms.flatMap((m) => m.content.filter((p: any) => p.type === "text").map((p: any) => p.text))
    expect(texts(out.messages).filter((t) => !t.startsWith("Step"))).toEqual(texts(msgs).filter((t) => !t.startsWith("Step")))
    expect(out.messages[0]).toBe(msgs[0]) // system untouched (identity)
    expect(out.messages.at(-1)).toBe(msgs.at(-1)) // newest message untouched
    // recent context (last 6 projected messages) untouched
    for (const m of msgs.slice(-6)) expect(out.messages).toContain(m)
    // rebuilt messages are real class instances
    for (const m of out.messages) expect(m.constructor).toBe((msgs.find((o) => o.role === m.role) as any).constructor)
  })

  it("protects edits, todos, instruction reads and recent errors", async () => {
    const msgs: any[] = transcript({ rounds: 0 })
    const { AssistantMessage, ToolMessage } = await import("@opencode/ai")
    const add = (id: string, name: string, input: any, out: string) => {
      msgs.splice(msgs.length - 1, 0,
        new AssistantMessage({ role: "assistant", content: [{ type: "tool-call", id, name, input }] }),
        new ToolMessage({ role: "tool", content: [{ type: "tool-result", id, name, result: { type: "text", value: out } }] }))
    }
    add("e1", "edit", { path: "src/a.ts" }, "x".repeat(3000))
    add("t1", "todowrite", { todos: [] }, "x".repeat(3000))
    add("r1", "read", { path: "AGENTS.md" }, "x".repeat(3000))
    add("g1", "grep", { pattern: "q" }, "Error: test failed\n" + "x".repeat(3000))
    for (let i = 0; i < 6; i++) add(`grep${i}`, "grep", { pattern: `p${i}` }, "y".repeat(3000))
    const jev = mockJev()
    const client = createJevClient({ url: "https://x", model: "jev-1.14", apiKey: "k", timeoutMs: 5000, maxRetries: 0, fetch: jev.fetch }, estimateTokens)
    const out = await prune(msgs, client, { keepThreshold: 0.5, preserveRecentMessages: 2, truncateHeadChars: 300, maxStateTokens: 25000, maxRequestTokens: 30000, protection: { protectTools: [], keepErrorsWithinMessages: 20 } }, (m: any, c) => new m.constructor({ ...m, content: c }))
    const kept = toolIds(out.messages, "tool-call")
    for (const id of ["e1", "t1", "r1", "g1"]) expect(kept).toContain(id)
    expect(kept).not.toContain("grep0")
    // protected calls are never even asked about
    const asked = jev.calls.flatMap((c) => Object.values(c.body.questions).map((q: any) => q.instructions)).join("\n")
    expect(asked).not.toMatch(/\(edit|\(todowrite/)
  })

  it("projection excludes system messages and maps tool roles", () => {
    const p = project(transcript({ rounds: 1 }))
    expect(p.messages.every((m) => m.role !== ("system" as any))).toBe(true)
    expect(p.messages[1].toolUses[0].tool).toBe("grep")
    expect(p.messages[2].toolResults![0].text).toContain("grep output")
  })

  it("never leaves an orphan tool-result", () => {
    const msgs = transcript({ rounds: 2 })
    const callId = toolIds(msgs, "tool-call")[0]
    const bad = msgs.map((m) => (m.role === "assistant" ? ({ ...m, content: m.content.filter((p) => p.id !== callId) } as any) : m))
    expect(checkIntegrity(bad)).toMatch(/orphan/)
    expect(applyCached(msgs, { drop: new Set(), truncate: new Map(), evaluated: new Set() }).changed).toBe(false)
  })
})

describe("privacy", () => {
  it("redacts secrets in Jev payloads without touching the session", async () => {
    const msgs = transcript({ secret: true })
    const snapshot = JSON.stringify(msgs)
    const { f, jev } = await setup()
    await runContext(f, "s1", msgs)
    expect(jev.calls.length).toBeGreaterThan(0)
    const sent = JSON.stringify(jev.calls.map((c) => c.body))
    expect(sent).not.toContain(SECRET)
    expect(sent).not.toContain(env.TYPESAFE_API_KEY)
    expect(JSON.stringify(msgs)).toBe(snapshot) // originals not mutated
  })
  it("redact covers common credential shapes", () => {
    const s = redact(`Authorization: Bearer abcdefghijklmnop\npostgres://u:p4ss@db/x\nDB_PASSWORD=hunter2\n-----BEGIN RSA PRIVATE KEY-----\nAAA\n-----END RSA PRIVATE KEY-----\nghp_${"a".repeat(36)} AKIAABCDEFGHIJKLMNOP {"api_key": "zzz"}`)
    for (const leak of ["abcdefghijklmnop", "p4ss", "hunter2", "AAA", "ghp_", "AKIAABCDEFGHIJKLMNOP", "zzz"]) expect(s).not.toContain(leak)
    expect(redactValue({ a: [`token=${SECRET}`] }).a[0]).not.toContain(SECRET)
  })
  it("never logs keys on HTTP errors", async () => {
    const jev = mockJev({ status: [401] })
    const client = createJevClient({ url: "https://x", model: "m", apiKey: "SUPERSECRET-KEY-1", timeoutMs: 1000, maxRetries: 0, fetch: jev.fetch }, estimateTokens)
    await expect(client.ask("s", { q: { type: "noul", instructions: "x" } })).rejects.toThrow(/^Jev HTTP 401$/)
  })
})

describe("paths", () => {
  it("honour XDG_CONFIG_HOME and XDG_STATE_HOME like OpenCode", async () => {
    const { configDir, statsSnapshotPath } = await import("../plugin/util.ts")
    expect(configDir({ XDG_CONFIG_HOME: "/x/cfg" })).toBe("/x/cfg/opencode")
    expect(statsSnapshotPath({ XDG_STATE_HOME: "/x/state" })).toBe("/x/state/opencode-jev/stats.json")
    expect(statsSnapshotPath({ JEV_STATS_FILE: "/x/s.json", XDG_STATE_HOME: "/x/state" })).toBe("/x/s.json")
    expect(await resolveApiKey("typesafe", { env: { XDG_CONFIG_HOME: "/x/cfg" }, readFile: async (p) => (p === "/x/cfg/opencode/typesafe-api-key" ? "k" : Promise.reject(new Error())) })).toBe("k")
  })
})

describe("credentials", () => {
  it("resolves per endpoint from env, OpenCode credential, then file", async () => {
    expect(await resolveApiKey("typesafe", { env: { TYPESAFE_API_KEY: "a" } })).toBe("a")
    expect(await resolveApiKey("typesafe", { env: {}, readFile: async () => " b\n", configDir: "/x" })).toBe("b")
    expect(await resolveApiKey("opencode-zen", { env: {}, opencodeCredential: async () => "c" })).toBe("c")
    expect(await resolveApiKey("opencode-zen", { env: { OPENCODE_API_KEY: "d" }, opencodeCredential: async () => "c" })).toBe("d")
    expect(await resolveApiKey("typesafe", { env: {}, readFile: async () => { throw new Error() } })).toBeUndefined()
  })
})

describe("API failures", () => {
  it("retries 429/529 with bounded attempts then succeeds", async () => {
    const jev = mockJev({ status: [429, 529] })
    const client = createJevClient({ url: "https://x", model: "m", apiKey: "k", timeoutMs: 1000, maxRetries: 2, fetch: jev.fetch, random: () => 0 }, estimateTokens)
    const r = await client.ask("s", { result_t1: { type: "noul", instructions: "(read" } })
    expect(r.answers.result_t1).toBeDefined()
    expect(client.usage.rateLimited).toBe(1)
    expect(client.usage.retries).toBe(2)
  }, 10000)
  it("gives up after maxRetries and the request is sent unpruned", async () => {
    const jev = mockJev({ status: [429, 429, 429, 429, 429, 429, 429, 429] })
    const { f } = await setup({ maxRetries: 1 }, jev)
    const msgs = transcript()
    const ev = await runContext(f, "s1", msgs)
    expect(ev.messages).toBe(msgs)
    expect(jev.calls.length).toBe(2)
  }, 10000)
  it("times out slow requests", async () => {
    const jev = mockJev({ delayMs: 3000 })
    const client = createJevClient({ url: "https://x", model: "m", apiKey: "k", timeoutMs: 1000, maxRetries: 0, fetch: (async (u: string, i: any) => {
      await new Promise((r, j) => { const t = setTimeout(r, 3000); i.signal.addEventListener("abort", () => (clearTimeout(t), j(new Error("abort")))) })
      return jev.fetch(u, i)
    }) as any }, estimateTokens)
    await expect(client.ask("s", { q: { type: "noul", instructions: "x" } })).rejects.toThrow(/timed out/)
  })
  it("does not retry 4xx validation errors", async () => {
    const jev = mockJev({ status: [422] })
    const client = createJevClient({ url: "https://x", model: "m", apiKey: "k", timeoutMs: 1000, maxRetries: 3, fetch: jev.fetch }, estimateTokens)
    await expect(client.ask("s", { q: { type: "noul", instructions: "x" } })).rejects.toThrow(/422/)
    expect(jev.calls.length).toBe(1)
  })
})

describe("plugin lifecycle", () => {
  it("registers documented hooks and the RPC; no throwing server commands by default", async () => {
    const { f } = await setup()
    expect(Object.keys(f.hooks).sort()).toEqual(["compaction", "context", "generate"])
    expect(Object.keys(f.rpc).sort()).toEqual(["compact", "reset", "setMode", "setSessionMode", "snapshot", "stats", "status"])
    expect(Object.keys(f.serverCommands)).toEqual([])
  })

  it("command actions resolve normally (never throw) and need no session", async () => {
    const { f, jev } = await setup()
    for (const m of ["status", "stats"]) expect((await f.rpc[m]!({})).text).toMatch(/mode=|Jev runs/)
    expect((await f.rpc.reset!({})).text).toMatch(/No session yet/)
    expect((await f.rpc.compact!({})).text).toMatch(/No session yet/)
    expect((await f.rpc.setMode!({ mode: "dry-run" })).text).toMatch(/dry-run/)
    expect(jev.calls.length).toBe(0)
    expect(f.synthetic.length).toBe(0)
  })

  it("headless server commands (serverCommands: true) succeed silently and change state", async () => {
    const { f } = await setup({ serverCommands: true })
    expect(Object.keys(f.serverCommands).sort()).toEqual(["jev-compact", "jev-disable", "jev-dry-run", "jev-enable", "jev-reset", "jev-stats", "jev-status"])
    for (const c of Object.values(f.serverCommands)) await expect(c.execute({ sessionID: "x" })).resolves.toBeUndefined()
    expect(f.storage.get("mode")).toBe("off")
  })

  it("mode is global and persisted; reset/compact are per session", async () => {
    const { f, jev } = await setup()
    const a = transcript(), b = transcript()
    await runContext(f, "A", a)
    await runContext(f, "B", b)
    await f.commands["jev-compact"].execute({ sessionID: "A" })
    await f.commands["jev-reset"].execute({ sessionID: "A" })
    const n = jev.calls.length
    const rb = await runContext(f, "B", [...b])
    expect(rb.messages.length).toBeLessThan(b.length) // B still pruned
    expect(jev.calls.length).toBe(n) // compact on A did not trigger B
    await f.commands["jev-disable"].execute({})
    expect(f.storage.get("mode")).toBe("off")
    const g = fakeContext({ ...base })
    g.storage.set("mode", "off")
    for (const [k, v] of f.storage) g.storage.set(k, v)
    await createPlugin({ fetch: jev.fetch, env, snapshotPath: SNAP }).setup(g.ctx)
    expect((await g.rpc.status!({})).text).toMatch(/mode=off/) // survives reload
  })

  it("active mode prunes outgoing request, keeps history intact, and reuses decisions without new Jev calls", async () => {
    const { f, jev } = await setup()
    const msgs = transcript()
    const before = estimateContextTokens(msgs)
    const ev = await runContext(f, "s1", msgs)
    expect(estimateContextTokens(ev.messages)).toBeLessThan(before * 0.8)
    expect(msgs.length).toBe(transcript().length) // original array untouched
    const n = jev.calls.length
    const ev2 = await runContext(f, "s1", [...msgs]) // unchanged context
    expect(jev.calls.length).toBe(n) // no repeated Jev requests
    expect(JSON.stringify(ev2.messages)).toBe(JSON.stringify(ev.messages)) // deterministic, cache-stable prefix
  })

  it("never re-asks Jev about calls it already decided", async () => {
    const { f, jev } = await setup()
    const msgs = transcript()
    await runContext(f, "s1", msgs)
    const asked1 = jev.calls.flatMap((c) => Object.keys(c.body.questions)).length
    const more = [...msgs, ...transcript({ rounds: 12 }).slice(1)]
    await runContext(f, "s1", more)
    const second = jev.calls.slice(-1)[0]
    const asked2 = Object.keys(second.body.questions).length
    expect(asked2).toBeLessThanOrEqual(2 * 12) // only new calls
    expect(asked1).toBeGreaterThan(0)
  })

  it("/jev-reset restores full context for one session, keeps stats, does not re-prune or re-bill", async () => {
    const { f, jev } = await setup()
    const a = transcript(), b = transcript()
    const ea = await runContext(f, "A", a)
    const eb = await runContext(f, "B", b)
    expect(ea.messages.length).toBeLessThan(a.length)
    await f.commands["jev-stats"].execute({ sessionID: "A" })
    const statsBefore = f.synthetic.at(-1).text.match(/Jev requests: (\d+)/)![1]
    const n = jev.calls.length
    await f.commands["jev-reset"].execute({ sessionID: "A" })
    expect(f.synthetic.at(-1).text).toMatch(/Restored \d+ pruned/)
    const ra = await runContext(f, "A", [...a])
    expect(ra.messages.length).toBe(a.length) // full context restored
    expect(jev.calls.length).toBe(n) // no re-evaluation / no spend
    const rb = await runContext(f, "B", [...b])
    expect(rb.messages.length).toBe(eb.messages.length) // other session unaffected
    await f.commands["jev-stats"].execute({ sessionID: "A" })
    expect(f.synthetic.at(-1).text.match(/Jev requests: (\d+)/)![1]).toBe(statsBefore) // stats preserved
    expect(f.synthetic.at(-1).text).toMatch(/\/jev-reset used 1/)
  })

  it("writes a credential-free stats snapshot readable by the CLI", async () => {
    const { readFileSync, statSync } = await import("node:fs")
    const { f } = await setup()
    await runContext(f, "S", transcript({ secret: true }))
    await f.commands["jev-status"].execute({ sessionID: "S" })
    await new Promise((r) => setTimeout(r, 2300))
    const raw = readFileSync(SNAP, "utf8")
    expect((statSync(SNAP).mode & 0o777).toString(8)).toBe("600")
    expect(raw).not.toContain(env.TYPESAFE_API_KEY)
    expect(raw).not.toContain(SECRET)
    const data = JSON.parse(raw)
    expect(data.sessions.S.counters.jevRequests).toBeGreaterThan(0)
    const { execFileSync } = await import("node:child_process")
    const out = execFileSync("node", ["--experimental-strip-types", "--no-warnings", "plugin/cli.ts", "S"], { env: { ...process.env, JEV_STATS_FILE: SNAP } }).toString()
    expect(out).toMatch(/Session S/)
    expect(out).toMatch(/NOT measured/)
  }, 10_000)

  it("below threshold: no Jev request", async () => {
    const { f, jev } = await setup({ compactAtTokens: 1_000_000 })
    await runContext(f, "s1", transcript())
    expect(jev.calls.length).toBe(0)
  })

  it("respects small context windows", async () => {
    const { f, jev } = await setup({ compactAtTokens: 1_000_000 }, mockJev(), { models: [{ providerID: "p", id: "small", limit: { context: 32_000 }, cost: [{ input: 3 }] }] })
    await runContext(f, "s1", transcript({ rounds: 12 }), { providerID: "p", id: "small" })
    expect(jev.calls.length).toBeGreaterThan(0)
  })

  it("dry-run calls Jev but never modifies the request", async () => {
    const { f, jev } = await setup({ mode: "dry-run" })
    const msgs = transcript()
    const ev = await runContext(f, "s1", msgs)
    expect(jev.calls.length).toBeGreaterThan(0)
    expect(ev.messages).toBe(msgs)
  })

  it("off mode makes no requests and changes nothing", async () => {
    const { f, jev } = await setup({ mode: "off" })
    const msgs = transcript()
    const ev = await runContext(f, "s1", msgs)
    expect(jev.calls.length).toBe(0)
    expect(ev.messages).toBe(msgs)
  })

  it("commands switch mode, persist it, and output never reaches the model", async () => {
    const { f, jev } = await setup({ mode: "active" })
    await f.commands["jev-disable"].execute({ sessionID: "s1" })
    expect(f.storage.get("mode")).toBe("off")
    expect(f.synthetic.at(-1).text).toMatch(/^Global: off/)
    const { UserMessage } = await import("@opencode/ai")
    // legacy status messages (from earlier builds) are still stripped from model requests
    const status = new UserMessage({ role: "user", content: [{ type: "text", text: "[jev-compaction status]\nold" }] })
    const ev = await runContext(f, "s1", [...transcript(), status])
    expect(ev.messages).not.toContain(status)
    expect(jev.calls.length).toBe(0)
    await f.commands["jev-status"].execute({ sessionID: "s1" })
    await f.commands["jev-stats"].execute({ sessionID: "s1" })
    expect(f.synthetic.at(-1).text).toMatch(/NOT measured/)
  })

  it("/jev-compact forces an evaluation regardless of threshold", async () => {
    const { f, jev } = await setup({ compactAtTokens: 1_000_000 })
    await f.commands["jev-compact"].execute({ sessionID: "s1" })
    await runContext(f, "s1", transcript())
    expect(jev.calls.length).toBeGreaterThan(0)
  })

  it("cooldown and growth gate prevent loops", async () => {
    let t = 1_000_000
    const jev = mockJev({ keepAll: true })
    const f = fakeContext({ ...base, cooldownMs: 60_000, minGrowthTokens: 4_000 })
    await createPlugin({ fetch: jev.fetch, env, now: () => t }).setup(f.ctx)
    const msgs = transcript()
    await runContext(f, "s1", msgs)
    const n = jev.calls.length
    t += 1000
    await runContext(f, "s1", [...msgs, ...transcript({ rounds: 4 })])
    expect(jev.calls.length).toBe(n) // cooldown
    t += 120_000
    await runContext(f, "s1", [...msgs])
    expect(jev.calls.length).toBe(n) // no growth
    await runContext(f, "s1", [...msgs, ...transcript({ rounds: 6 })])
    expect(jev.calls.length).toBeGreaterThan(n)
  })

  it("isolates sessions and serialises concurrent requests per session", async () => {
    const jev = mockJev({ delayMs: 50 })
    const { f } = await setup({}, jev)
    const a = transcript(), b = transcript()
    const [ea, ea2, eb] = await Promise.all([runContext(f, "A", a), runContext(f, "A", [...a]), runContext(f, "B", b)])
    const idsA = new Set(toolIds(a, "tool-call")), idsB = new Set(toolIds(b, "tool-call"))
    expect(toolIds(eb.messages, "tool-call").every((id: string) => idsB.has(id))).toBe(true)
    expect(toolIds(ea.messages, "tool-call").every((id: string) => idsA.has(id))).toBe(true)
    // per session only one Jev evaluation ran (its batches), not two
    expect(jev.calls.length).toBe(2)
    expect(ea2.messages.length).toBeLessThanOrEqual(a.length)
  })

  it("budget blocks requests when exhausted", async () => {
    const { f, jev } = await setup({ budget: { perSessionUSD: 0, perDayUSD: 1 } })
    const msgs = transcript()
    const ev = await runContext(f, "s1", msgs)
    expect(jev.calls.length).toBe(0)
    expect(ev.messages).toBe(msgs)
  })

  it("unpriced model is blocked without approval", async () => {
    const { f, jev } = await setup({ model: "jev-unknown" })
    await runContext(f, "s1", transcript())
    expect(jev.calls.length).toBe(0)
  })

  it("insufficient reduction leaves native compaction in charge", async () => {
    const { f, jev } = await setup({ minReductionRatio: 0.9 }, mockJev({ keepAll: true }))
    const msgs = transcript()
    const ev = await runContext(f, "s1", msgs)
    expect(jev.calls.length).toBeGreaterThan(0)
    expect(ev.messages).toBe(msgs)
    await f.commands["jev-stats"].execute({ sessionID: "s1" })
    expect(f.synthetic.at(-1).text).toMatch(/fallbacks requested 1/)
  })

  it("uses the selected endpoint and model", async () => {
    const { f, jev } = await setup({ endpoint: "opencode-zen" }, mockJev())
    // zen key comes from env OPENCODE_API_KEY in this test
    const g = fakeContext({ ...base, endpoint: "opencode-zen" })
    const j2 = mockJev()
    await createPlugin({ fetch: j2.fetch, env: { OPENCODE_API_KEY: "zen-key-123" } }).setup(g.ctx)
    await runContext(g, "s", transcript())
    expect(j2.calls[0].url).toBe("https://opencode.ai/inference/systemone/v1/systemone")
    expect(j2.calls[0].body.model).toBe("jev-1.14")
    const g2 = fakeContext({ ...base })
    const j3 = mockJev()
    await createPlugin({ fetch: j3.fetch, env }).setup(g2.ctx)
    await runContext(g2, "s", transcript())
    expect(j3.calls[0].body.model).toBe("jev-1.14.0")
    expect(j2.calls[0].headers.authorization).toBe("Bearer zen-key-123")
    void f; void jev
  })

  it("works across providers (anthropic/openai-compatible models get the same pruning)", async () => {
    const { f } = await setup()
    for (const model of [{ providerID: "provider-b", id: "model-b1" }, { providerID: "provider-c", id: "auto" }, { providerID: "provider-a", id: "model-large" }]) {
      const msgs = transcript()
      const ev = await runContext(f, `s-${model.providerID}`, msgs, model)
      expect(checkIntegrity(ev.messages)).toBeUndefined()
      expect(ev.messages.length).toBeLessThan(msgs.length)
      expect(ev.model).toEqual(model) // plugin never touches the model
    }
  })

  it("compaction hook applies decisions; native compaction resets state", async () => {
    const { f } = await setup()
    const msgs = transcript()
    await runContext(f, "s1", msgs)
    const cev: any = { sessionID: "s1", messages: [...msgs] }
    await f.hooks.compaction[0](cev)
    expect(cev.messages.length).toBeLessThan(msgs.length)
    f.emit({ type: "session.compaction.ended", data: { sessionID: "s1" } })
    await new Promise((r) => setTimeout(r, 10))
    const cev2: any = { sessionID: "s1", messages: [...msgs] }
    await f.hooks.compaction[0](cev2)
    expect(cev2.messages.length).toBe(msgs.length)
  })

  it("accounts measured cost, cache tokens and estimated savings separately", async () => {
    const { f } = await setup()
    await runContext(f, "s1", transcript())
    f.emit({ type: "session.step.ended", data: { sessionID: "s1", cost: 0.01, tokens: { input: 5000, output: 10, reasoning: 0, cache: { read: 100, write: 4000 } } } })
    await new Promise((r) => setTimeout(r, 10))
    await f.commands["jev-stats"].execute({ sessionID: "s1" })
    const text = f.synthetic.at(-1).text
    expect(text).toMatch(/input tokens measured \d+/)
    expect(text).toMatch(/cache read 100, cache write 4000/)
    expect(text).toMatch(/after a pruning change: 4000/)
    expect(text).toMatch(/Jev cost \$0\.000/)
  })
})

describe("fallback compaction model", () => {
  const agents = [
    { id: "build", model: { providerID: "provider-a", id: "model-large" }, request: { settings: { reasoningEffort: "high" } } },
    { id: "compaction", model: undefined, request: { settings: {} } },
    { id: "title", model: { providerID: "provider-a", id: "model-small" }, request: { settings: {} } },
  ]
  const models = [
    { providerID: "provider-a", id: "model-large", limit: { context: 1_048_576 } },
    { providerID: "provider-a", id: "model-fast", limit: { context: 1_048_576 } },
  ]
  it("no fallback configured: no agent transform at all", async () => {
    const { f } = await setup({}, mockJev(), { agents, models })
    expect(f.agentTransforms.length).toBe(0)
    expect(f.rebuildAgents().get("compaction")!.model).toBeUndefined()
  })
  it("configured fallback applies only to the compaction agent and survives every registry rebuild", async () => {
    const { f } = await setup({ fallbackCompactionModel: "provider-a/model-fast" }, mockJev(), { agents, models })
    for (let i = 0; i < 3; i++) {
      const reg = f.rebuildAgents()
      expect(reg.get("compaction")!.model).toEqual({ providerID: "provider-a", id: "model-fast" })
      expect(reg.get("build")).toEqual(agents[0])
      expect(reg.get("title")).toEqual(agents[2])
    }
  })
  it("malformed fallback is ignored", async () => {
    const { f } = await setup({ fallbackCompactionModel: "nonsense" }, mockJev(), { agents, models })
    expect(f.agentTransforms.length).toBe(0)
  })
})

describe("shared state for TUI/GUI indicators", () => {
  it("snapshot reflects mode, session metrics and is read-only (no Jev or model request)", async () => {
    const { f, jev } = await setup()
    const home = await f.rpc.snapshot!({})
    expect(home).toMatchObject({ state: "active", mode: "active", endpoint: "typesafe", model: "jev-1.14", session: null })
    expect(jev.calls.length).toBe(0)
    await runContext(f, "s1", transcript())
    const n = jev.calls.length
    const s = await f.rpc.snapshot!({ sessionID: "s1" })
    expect(s.session.evaluations).toBe(1)
    expect(s.session.tokensRemovedEstimated).toBeGreaterThan(0)
    expect(s.session.reductionPctEstimated).toBeGreaterThan(0)
    expect(s.session.jevTokensMeasured).toBeGreaterThan(0)
    expect(s.session.lastEvaluationAt).toMatch(/^\d{4}-/)
    for (let i = 0; i < 5; i++) await f.rpc.snapshot!({ sessionID: "s1" })
    expect(jev.calls.length).toBe(n)
    expect((await f.rpc.snapshot!({ sessionID: "other" })).session).toMatchObject({ evaluations: 0, costUSDEstimated: 0, lastEvaluationAt: null })
  })
  it("states: dry-run, off, budget reached, unavailable", async () => {
    const { f } = await setup()
    await f.rpc.setMode!({ mode: "dry-run" })
    expect((await f.rpc.snapshot!({})).state).toBe("dry-run")
    await f.rpc.setMode!({ mode: "off" })
    expect((await f.rpc.snapshot!({})).state).toBe("off")
    const b = await setup({ budget: { perSessionUSD: 0.25, perDayUSD: 0 } })
    expect((await b.f.rpc.snapshot!({})).state).toBe("budget")
    const u = await setup({ model: "jev-unknown" })
    expect((await u.f.rpc.snapshot!({})).state).toBe("unavailable")
  })
  it("emits `changed` on mode change, evaluation and reset so every client refreshes", async () => {
    const { f } = await setup()
    await f.rpc.setMode!({ mode: "dry-run" })
    await f.rpc.setMode!({ mode: "active" })
    await runContext(f, "s1", transcript())
    await f.rpc.reset!({ sessionID: "s1" })
    const types = f.rpcEvents.map((e) => e.type)
    expect(types.every((t) => t === "changed")).toBe(true)
    expect(f.rpcEvents.filter((e: any) => e.data.sessionID === "s1").length).toBeGreaterThanOrEqual(3)
  })
})

describe("compatibility", () => {
  it("disables itself with a warning when the context hook is missing, without throwing", async () => {
    const f = fakeContext({ ...base })
    delete f.ctx.session.hook
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    await expect(createPlugin({ fetch: mockJev().fetch, env }).setup(f.ctx)).resolves.toBeUndefined()
    expect(warn.mock.calls.flat().join(" ")).toMatch(/missing session\.hook; Jev disabled/)
    expect(Object.keys(f.rpc)).toEqual([])
    warn.mockRestore()
  })
  it("keeps pruning when RPC is unavailable (commands/indicators degrade only)", async () => {
    const f = fakeContext({ ...base })
    delete f.ctx.rpc
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    await createPlugin({ fetch: mockJev().fetch, env }).setup(f.ctx)
    const msgs = transcript()
    const ev = await runContext(f, "s1", msgs)
    expect(ev.messages.length).toBeLessThan(msgs.length)
    expect(warn.mock.calls.flat().join(" ")).toMatch(/RPC unavailable/)
    warn.mockRestore()
  })
})
