import { describe, expect, it, vi } from "vitest"
import { jevCommandList, shortLabel, sidebarRows, type UiHost } from "../plugin/ui-core.ts"
import type { JevSnapshot } from "../plugin/rpc.ts"

function fake(sessionID: string | undefined, rpcImpl: Record<string, Function>) {
  const notes: Array<{ message: string; tone: string }> = [], shown: Array<{ title: string; text: string }> = []
  const host: UiHost = {
    rpc: () => rpcImpl as any,
    sessionID: () => sessionID,
    notify: (message, tone) => notes.push({ message, tone }),
    show: (title, text) => shown.push({ title, text }),
  }
  const cmds = Object.fromEntries(jevCommandList(host).map((c) => [c.name, c]))
  return { cmds, notes, shown }
}
const ok = (text: string) => vi.fn(async () => ({ text }))
const rpc = () => ({ status: ok("mode=active"), stats: ok("Jev runs: 0"), setMode: ok("Active: ..."), reset: ok("Restored 2"), compact: ok("Jev will evaluate"), setSessionMode: ok("This session only"), snapshot: vi.fn() })

describe("shared command layer (TUI and Desktop GUI)", () => {
  it("registers the seven global commands and the four session-override commands", () => {
    expect(Object.keys(fake(undefined, rpc()).cmds).sort()).toEqual(["jev-compact", "jev-disable", "jev-dry-run", "jev-enable", "jev-reset", "jev-session-disable", "jev-session-dry-run", "jev-session-enable", "jev-session-inherit", "jev-stats", "jev-status"])
  })
  it("welcome screen: success never throws, never shows an error, no per-session RPC", async () => {
    const r = rpc()
    const { cmds, notes, shown } = fake(undefined, r)
    for (const c of Object.values(cmds)) await expect(c.run()).resolves.toBeUndefined()
    expect(shown.map((a) => a.title)).toEqual(["Jev status", "Jev statistics"])
    expect(notes.every((t) => t.tone !== "error")).toBe(true)
    expect(notes.filter((t) => t.tone === "warning").map((t) => t.message).join()).toMatch(/Open a session first.*Open a session first/)
    expect(r.reset).not.toHaveBeenCalled()
    expect(r.compact).not.toHaveBeenCalled()
  })
  it("session: passes the current session ID, success tone", async () => {
    const r = rpc()
    const { cmds, notes } = fake("ses_1", r)
    await cmds["jev-reset"]!.run()
    await cmds["jev-compact"]!.run()
    expect(r.reset).toHaveBeenCalledWith({ sessionID: "ses_1" })
    expect(r.compact).toHaveBeenCalledWith({ sessionID: "ses_1" })
    expect(notes.map((n) => n.tone)).toEqual(["success", "success"])
  })
  it("mode commands call setMode with the right mode", async () => {
    const r = rpc()
    const { cmds } = fake(undefined, r)
    await cmds["jev-enable"]!.run(), await cmds["jev-dry-run"]!.run(), await cmds["jev-disable"]!.run()
    expect(r.setMode.mock.calls.map((c: any) => c[0].mode)).toEqual(["active", "dry-run", "off"])
  })
  it("a structured RPC error is shown readably as an error", async () => {
    const { cmds, notes } = fake(undefined, { ...rpc(), stats: async () => { throw { type: "rpc.internal", message: "simulated stats failure" } } })
    await cmds["jev-stats"]!.run()
    expect(notes.at(-1)).toEqual({ tone: "error", message: "Command failed: simulated stats failure" })
  })
  it("a genuine failure shows an error, not success", async () => {
    const { cmds, notes } = fake(undefined, { ...rpc(), status: async () => { throw new Error("RPC unavailable") } })
    await cmds["jev-status"]!.run()
    expect(notes.at(-1)).toEqual({ tone: "error", message: "Command failed: RPC unavailable" })
  })
})

describe("status indicator formatting", () => {
  const snap = (over: Partial<JevSnapshot> = {}): JevSnapshot => ({
    state: "active", mode: "active", globalMode: "active", modeSource: "inherited from global", version: "0.2.3", reason: null, endpoint: "typesafe", model: "jev-1.14", todayUSDEstimated: 0.0157, perDayUSD: 1, perSessionUSD: 0.25,
    session: { evaluations: 3, applied: 3, dryRuns: 0, failures: 0, requestsPruned: 4, tokensRemovedFromRequestsEstimated: 90000, nativeCompactions: 0, resets: 0, attempts: 3, trigger: null, tokensRemovedEstimated: 41234, reductionPctEstimated: 57.1, jevTokensMeasured: 9000, costUSDEstimated: 0.0004, pruned: { dropped: 9, truncated: 1 }, lastEvaluationAt: new Date(Date.now() - 90_000).toISOString(), evaluating: false },
    ...over,
  })
  it("labels every state", () => {
    for (const [state, label] of [["active", "Active"], ["dry-run", "Dry-run"], ["off", "Disabled"], ["evaluating", "Evaluating"], ["unavailable", "Unavailable"], ["budget", "Budget reached"]] as const)
      expect(shortLabel(snap({ state }))).toBe(`Jev: ${label} · TypeSafe`)
    expect(shortLabel(undefined)).toBe("Jev: Unavailable")
  })
  it("sidebar rows mark estimates and measured values", () => {
    const rows = Object.fromEntries(sidebarRows(snap()))
    expect(rows["Tokens removed"]).toBe("~41,234 (est.)")
    expect(rows["Reduction"]).toBe("~57.1% (est.)")
    expect(rows["Session cost"]).toMatch(/\(est\.; 9,000 tok measured\)/)
    expect(rows["Today"]).toBe("$0.02 / $1.00")
    expect(rows["Last run"]).toBe("2m ago")
    expect(rows["Evaluations"]).toBe("3")
  })
})
