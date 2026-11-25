// Shared accounting (locked ledger file), persistent session statistics, optional limits and per-session modes.
// Each plugin instance stands for one project location; all share the ledger file like real instances do.
import { fork } from "node:child_process"
import { mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { createPlugin } from "../plugin/index.ts"
import { FileLedger } from "../plugin/ledger-file.ts"
import { resolveConfig } from "../plugin/config.ts"
import { fakeContext, mockJev, runContext, transcript } from "./fixtures.ts"

const env = { TYPESAFE_API_KEY: "ts-test-key-123456" }
const base = { mode: "active", compactAtTokens: 5_000, minGrowthTokens: 0, cooldownMs: 0, minReductionRatio: 0.1 }
const PRICE = 0.042 / 1e6
const day = () => new Date().toISOString().slice(0, 10)

/** One plugin instance. `storage` is shared between instances of one service (mode); `ledger` is the shared file. */
async function instance(ledgerPath: string, options: Record<string, unknown> = {}, storage = new Map<string, unknown>(), now?: () => number) {
  const f = fakeContext({ ...base, ...options })
  f.ctx.storage.get = async (k: string) => structuredClone(storage.get(k))
  f.ctx.storage.set = async (k: string, v: unknown) => void storage.set(k, structuredClone(v))
  const jev = mockJev()
  const cleanup = (await createPlugin({ fetch: jev.fetch, env, snapshotPath: "/dev/null", ledgerPath, now }).setup(f.ctx)) as () => Promise<void>
  return { f, jev, cleanup }
}
const newLedger = () => join(mkdtempSync(join(tmpdir(), "jev-acct-")), "ledger.json")
const read = (p: string) => JSON.parse(readFileSync(p, "utf8"))

describe("shared ledger file", () => {
  it("two instances (projects) accumulate one daily total; nothing is overwritten", async () => {
    const p = newLedger()
    const a = await instance(p)
    const b = await instance(p)
    await runContext(a.f, "sa", transcript())
    await runContext(b.f, "sb", transcript())
    await a.cleanup()
    await b.cleanup()
    const d = read(p)
    const requests = a.jev.calls.length + b.jev.calls.length
    expect(d.days[day()]).toBeCloseTo(requests * 1_000 * PRICE, 12)
    expect(d.sessions.sa.spentUSD + d.sessions.sb.spentUSD).toBeCloseTo(d.days[day()], 12)
    expect(d.counters.jevRequests).toBe(requests)
    expect(Object.keys(d.reservations)).toHaveLength(0)
    expect(statSync(p).mode & 0o777).toBe(0o600)
  })

  it("no lost updates from separate OS processes writing concurrently", async () => {
    const p = newLedger()
    const worker = join(mkdtempSync(join(tmpdir(), "jev-w-")), "w.mjs")
    writeFileSync(worker, `
      const { FileLedger } = await import(${JSON.stringify(join(process.cwd(), "plugin/ledger-file.ts"))})
      const l = new FileLedger({ path: process.argv[2] })
      for (let i = 0; i < 200; i++) l.update((d) => { d.days.x = (d.days.x ?? 0) + 1 })
    `)
    const run = () => new Promise<void>((res, rej) => fork(worker, [p], { execArgv: ["--experimental-strip-types", "--no-warnings"] }).on("exit", (c) => (c ? rej(new Error(`exit ${c}`)) : res())))
    await Promise.all([run(), run(), run(), run()])
    expect(read(p).days.x).toBe(800)
  }, 30_000)

  it("abandoned reservations and stale locks are recovered", () => {
    let t = 1_000_000
    const p = newLedger()
    const l = new FileLedger({ path: p, now: () => t, reservationTtlMs: 60_000, staleLockMs: 5_000 })
    l.update((d) => void (d.reservations.dead = { usd: 0.5, day: "x", sessionID: "s", pid: 1, at: t }))
    t += 61_000
    l.update(() => {})
    expect(read(p).reservations).toEqual({})
    // A lock left behind by a crashed process (old mtime) is removed; a live lock makes others wait, then time out.
    writeFileSync(`${p}.lock`, "999999")
    utimesSync(`${p}.lock`, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000))
    const l2 = new FileLedger({ path: p, staleLockMs: 5_000 })
    expect(() => l2.update((d) => void (d.days.y = 1))).not.toThrow()
    writeFileSync(`${p}.lock`, "999999")
    const l3 = new FileLedger({ path: p, staleLockMs: 60_000, lockTimeoutMs: 200 })
    expect(() => l3.update(() => {})).toThrow(/lock timeout/)
  })

  it("stores numbers only: no content, keys or tool output", async () => {
    const p = newLedger()
    const a = await instance(p)
    await runContext(a.f, "s", transcript({ secret: true }))
    await a.cleanup()
    const raw = readFileSync(p, "utf8")
    expect(raw).not.toMatch(/sk-proj|ts-test-key|output|Fix failing test|src\//)
  })
})

describe("budgets (limited and unlimited)", () => {
  it("null means unlimited; numbers are limits; other values are rejected", () => {
    expect(resolveConfig({ budget: { perDayUSD: null, perSessionUSD: null } }).budget).toEqual({ perDayUSD: null, perSessionUSD: null })
    expect(resolveConfig({}).budget).toEqual({ perDayUSD: 1, perSessionUSD: 0.25 })
    expect(() => resolveConfig({ budget: { perDayUSD: -1 } })).toThrow()
    expect(() => resolveConfig({ budget: { perDayUSD: "unlimited" } })).toThrow()
  })

  it("unlimited budgets still track spend and show Unlimited", async () => {
    const p = newLedger()
    const a = await instance(p, { budget: { perDayUSD: null, perSessionUSD: null } })
    await runContext(a.f, "s", transcript())
    expect(a.jev.calls.length).toBeGreaterThan(0)
    const snap: any = await a.f.rpc.snapshot({ sessionID: "s" })
    expect(snap.perDayUSD).toBeNull()
    expect(snap.session.costUSDEstimated).toBeGreaterThan(0)
    expect((await a.f.rpc.status({ sessionID: "s" })).text).toMatch(/session \$[\d.]+ \/ Unlimited, today \$[\d.]+ \/ Unlimited/)
  })

  it("daily limit counts other projects' spend; a reached limit stops new evaluations but keeps applied pruning", async () => {
    const p = newLedger()
    const a = await instance(p, { budget: { perSessionUSD: null, perDayUSD: 1 } })
    await runContext(a.f, "s1", transcript())
    const msgs = transcript()
    const before = (await runContext(a.f, "s1", msgs)).messages.length
    new FileLedger({ path: p }).update((d) => void (d.days[day()] = 1)) // another project spent the rest
    const calls = a.jev.calls.length
    const ev = await runContext(a.f, "s1", [...msgs, ...transcript({ rounds: 20 })])
    expect(a.jev.calls.length).toBe(calls)
    expect(ev.messages.length).toBeLessThan(msgs.length + transcript({ rounds: 20 }).length) // earlier decisions still applied
    expect(before).toBeLessThan(msgs.length)
    const b = await instance(p, { budget: { perSessionUSD: null, perDayUSD: 1 } })
    await runContext(b.f, "s2", transcript())
    expect(b.jev.calls.length).toBe(0)
    expect(((await b.f.rpc.snapshot({ sessionID: "s2" })) as any).state).toBe("budget")
  })

  it("session limit survives a plugin reload and a restart", async () => {
    const p = newLedger()
    const a = await instance(p, { budget: { perSessionUSD: 0.25, perDayUSD: null } })
    await runContext(a.f, "s1", transcript())
    await a.cleanup()
    const spent = read(p).sessions.s1.spentUSD
    const b = await instance(p, { budget: { perSessionUSD: spent * 0.99, perDayUSD: null } })
    await runContext(b.f, "s1", transcript({ rounds: 30 }))
    expect(b.jev.calls.length).toBe(0)
  })

  it("concurrent reservations from two projects cannot overshoot a limit together", async () => {
    const p = newLedger()
    const perBatch = 3_000 * PRICE
    const opts = { maxStateTokens: 2_000, maxRequestTokens: 3_000, budget: { perSessionUSD: null, perDayUSD: perBatch * 2.5 } }
    const a = await instance(p, opts)
    const b = await instance(p, opts)
    await Promise.all([runContext(a.f, "x", transcript({ rounds: 30 })), runContext(b.f, "y", transcript({ rounds: 30 }))])
    expect(a.jev.calls.length + b.jev.calls.length).toBeGreaterThan(0)
    expect(a.jev.calls.length + b.jev.calls.length).toBeLessThanOrEqual(2)
    expect(Object.keys(read(p).reservations)).toHaveLength(0)
  })

  it("failed requests release their reservation and add no spend", async () => {
    const p = newLedger()
    const f = fakeContext({ ...base, maxRetries: 0 })
    await createPlugin({ fetch: (async () => new Response("{}", { status: 500 })) as any, env, snapshotPath: "/dev/null", ledgerPath: p }).setup(f.ctx)
    await runContext(f, "s", transcript())
    const d = read(p)
    expect(d.reservations).toEqual({})
    expect(d.days[day()] ?? 0).toBe(0)
  })
})

describe("persistent session statistics", () => {
  it("survive reload; TUI/Desktop snapshot, /jev-stats and the CLI snapshot agree; last run is not 'never'", async () => {
    const p = newLedger()
    const snapFile = join(mkdtempSync(join(tmpdir(), "jev-snap-")), "stats.json")
    const storage = new Map<string, unknown>()
    const a = await instance(p, {}, storage)
    await runContext(a.f, "s1", transcript())
    await runContext(a.f, "s1", transcript()) // applies decisions to an outgoing request
    await a.cleanup()
    const f = fakeContext({ ...base })
    f.ctx.storage.get = async (k: string) => storage.get(k)
    f.ctx.storage.set = async (k: string, v: unknown) => void storage.set(k, v)
    const cleanup = (await createPlugin({ fetch: mockJev().fetch, env, snapshotPath: snapFile, ledgerPath: p }).setup(f.ctx)) as () => Promise<void>
    const snap: any = await f.rpc.snapshot({ sessionID: "s1" })
    expect(snap.session.evaluations).toBeGreaterThan(0)
    expect(snap.session.applied).toBeGreaterThan(0)
    expect(snap.session.requestsPruned).toBeGreaterThan(0)
    expect(snap.session.lastEvaluationAt).not.toBeNull()
    expect(snap.session.pruned).toEqual({ dropped: 0, truncated: 0 }) // decisions are not persisted
    const stats = (await f.rpc.stats({ sessionID: "s1" })).text
    expect(stats).toContain(`Jev runs: ${snap.session.evaluations}`)
    expect(stats).not.toMatch(/last successful evaluation never/)
    await cleanup()
    const cli = JSON.parse(readFileSync(snapFile, "utf8"))
    expect(cli.sessions.s1.counters.runs).toBe(snap.session.evaluations)
    expect(cli.sessions.s1.spentUSD).toBeCloseTo(snap.session.costUSDEstimated, 12)
    expect(cli.spentTodayUSD).toBeCloseTo(snap.todayUSDEstimated, 12)
  })

  it("resets and native compactions are counted per session", async () => {
    const p = newLedger()
    const a = await instance(p)
    await runContext(a.f, "s1", transcript())
    await a.f.rpc.reset({ sessionID: "s1" })
    a.f.emit({ type: "session.compaction.ended", data: { sessionID: "s1" } })
    await new Promise((r) => setTimeout(r, 20))
    const snap: any = await a.f.rpc.snapshot({ sessionID: "s1" })
    expect(snap.session.resets).toBe(1)
    expect(snap.session.nativeCompactions).toBe(1)
  })
})

describe("global mode and per-session overrides", () => {
  it("session A off while B stays active; A sends unpruned and makes no Jev requests", async () => {
    const p = newLedger()
    const a = await instance(p)
    await a.f.rpc.setSessionMode({ sessionID: "A", mode: "off" })
    const msgsA = transcript()
    const evA = await runContext(a.f, "A", msgsA)
    expect(evA.messages).toBe(msgsA)
    expect(a.jev.calls.length).toBe(0)
    const msgsB = transcript()
    const evB = await runContext(a.f, "B", msgsB)
    expect(a.jev.calls.length).toBeGreaterThan(0)
    expect(evB.messages.length).toBeLessThan(msgsB.length)
    const sa: any = await a.f.rpc.snapshot({ sessionID: "A" })
    const sb: any = await a.f.rpc.snapshot({ sessionID: "B" })
    expect([sa.mode, sa.modeSource]).toEqual(["off", "session override"])
    expect([sb.mode, sb.modeSource]).toEqual(["active", "inherited from global"])
  })

  it("overrides persist across restart; inherit restores the global mode; global change leaves overrides", async () => {
    const p = newLedger()
    const storage = new Map<string, unknown>()
    const a = await instance(p, {}, storage)
    await a.f.rpc.setSessionMode({ sessionID: "A", mode: "dry-run" })
    await a.cleanup()
    const b = await instance(p, {}, storage)
    expect(((await b.f.rpc.snapshot({ sessionID: "A" })) as any).mode).toBe("dry-run")
    await b.f.rpc.setMode({ mode: "off" })
    expect(((await b.f.rpc.snapshot({ sessionID: "A" })) as any).mode).toBe("dry-run")
    expect(((await b.f.rpc.snapshot({ sessionID: "Z" })) as any).mode).toBe("off")
    await b.f.rpc.setSessionMode({ sessionID: "A", mode: "inherit" })
    expect(((await b.f.rpc.snapshot({ sessionID: "A" })) as any)).toMatchObject({ mode: "off", modeSource: "inherited from global" })
  })

  it("re-enabling a session does not reuse old pruning decisions", async () => {
    const p = newLedger()
    const a = await instance(p)
    const msgs = transcript()
    await runContext(a.f, "A", msgs)
    expect((await runContext(a.f, "A", msgs)).messages.length).toBeLessThan(msgs.length)
    await a.f.rpc.setSessionMode({ sessionID: "A", mode: "off" })
    await a.f.rpc.setSessionMode({ sessionID: "A", mode: "active" })
    expect(((await a.f.rpc.snapshot({ sessionID: "A" })) as any).session.pruned).toEqual({ dropped: 0, truncated: 0 })
  })

  it("config off is a kill switch above global and session modes; commands cannot override it", async () => {
    const p = newLedger()
    const a = await instance(p, { mode: "off" }, new Map([["mode", "active"]]))
    expect((await a.f.rpc.setSessionMode({ sessionID: "A", mode: "active" })).text).toMatch(/kill switch/)
    expect((await a.f.rpc.setMode({ mode: "active" })).text).toMatch(/disabled in opencode.jsonc/)
    await runContext(a.f, "A", transcript())
    expect(a.jev.calls.length).toBe(0)
    expect(((await a.f.rpc.snapshot({ sessionID: "A" })) as any).modeSource).toBe("config kill switch")
  })

  it("a failing context hook leaves Jev inert and setup completes", async () => {
    const f = fakeContext({ ...base })
    const original = f.ctx.session.hook
    f.ctx.session.hook = async (name: string, cb: Function) => {
      if (name === "context") throw new Error("unsupported")
      return original(name, cb)
    }
    await createPlugin({ fetch: mockJev().fetch, env, snapshotPath: "/dev/null", ledgerPath: newLedger() }).setup(f.ctx)
    expect(((await f.rpc.snapshot({})) as any).state).toBe("unavailable")
    expect((await f.rpc.setMode({ mode: "active" })).text).toMatch(/unavailable/)
  })

  it("status, stats and mode commands make no Jev or model requests", async () => {
    const p = newLedger()
    const a = await instance(p)
    for (const call of [
      () => a.f.rpc.status({ sessionID: "A" }), () => a.f.rpc.stats({ sessionID: "A" }), () => a.f.rpc.snapshot({ sessionID: "A" }),
      () => a.f.rpc.setMode({ mode: "dry-run" }), () => a.f.rpc.setSessionMode({ sessionID: "A", mode: "active" }),
      () => a.f.rpc.setSessionMode({ sessionID: "A", mode: "inherit" }), () => a.f.rpc.reset({ sessionID: "A" }), () => a.f.rpc.compact({ sessionID: "A" }),
    ]) await call()
    expect(a.jev.calls.length).toBe(0)
  })
})
