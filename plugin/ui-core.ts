// Client-neutral command and indicator logic shared by the TUI part (tui.tsx) and the Desktop GUI part (gui.tsx).
// No OpenCode imports: each client adapts its own toast/dialog/session APIs to `UiHost`.
import { TRIGGER_LABEL, type JevSnapshot } from "./rpc.ts"

export interface JevClient {
  status(input: { sessionID?: string }): Promise<{ text: string }>
  stats(input: { sessionID?: string }): Promise<{ text: string }>
  snapshot(input: { sessionID?: string }): Promise<unknown>
  setMode(input: { mode: "off" | "dry-run" | "active" }): Promise<{ text: string }>
  reset(input: { sessionID: string }): Promise<{ text: string }>
  compact(input: { sessionID: string }): Promise<{ text: string }>
  setSessionMode(input: { sessionID: string; mode: "off" | "dry-run" | "active" | "inherit" }): Promise<{ text: string }>
}

export type Tone = "info" | "success" | "warning" | "error"

export interface UiHost {
  rpc(): JevClient
  sessionID(): string | undefined
  notify(message: string, tone: Tone): void
  show(title: string, text: string): void
}

export interface JevCommand {
  name: string
  title: string
  run(): Promise<void>
}

export function errorText(error: unknown): string {
  if (error instanceof Error) return error.message
  if (error && typeof error === "object" && "message" in error) return String((error as { message: unknown }).message)
  return String(error)
}

const NO_SESSION = (cmd: string) => `Open a session first: /${cmd} acts on the current session.`

/** The seven Jev commands. Success never throws; real failures become an error notification. */
export function jevCommandList(host: UiHost): JevCommand[] {
  const guard = (fn: () => Promise<void>) => async () => {
    try {
      await fn()
    } catch (error) {
      host.notify(`Command failed: ${errorText(error)}`, "error")
    }
  }
  const mode = (m: "off" | "dry-run" | "active") => guard(async () => host.notify((await host.rpc().setMode({ mode: m })).text, "success"))
  const perSession = (name: string, call: (sessionID: string) => Promise<{ text: string }>) =>
    guard(async () => {
      const sid = host.sessionID()
      if (!sid) return host.notify(NO_SESSION(name), "warning")
      host.notify((await call(sid)).text, "success")
    })
  return [
    { name: "jev-status", title: "Jev: status", run: guard(async () => host.show("Jev status", (await host.rpc().status({ sessionID: host.sessionID() })).text)) },
    { name: "jev-stats", title: "Jev: statistics", run: guard(async () => host.show("Jev statistics", (await host.rpc().stats({ sessionID: host.sessionID() })).text)) },
    { name: "jev-enable", title: "Jev: enable active pruning (all sessions)", run: mode("active") },
    { name: "jev-dry-run", title: "Jev: dry-run mode (all sessions)", run: mode("dry-run") },
    { name: "jev-disable", title: "Jev: disable (all sessions)", run: mode("off") },
    { name: "jev-reset", title: "Jev: restore full context for this session", run: perSession("jev-reset", (sessionID) => host.rpc().reset({ sessionID })) },
    { name: "jev-compact", title: "Jev: evaluate this session on its next request", run: perSession("jev-compact", (sessionID) => host.rpc().compact({ sessionID })) },
    { name: "jev-session-enable", title: "Jev: active for this session only", run: perSession("jev-session-enable", (sessionID) => host.rpc().setSessionMode({ sessionID, mode: "active" })) },
    { name: "jev-session-dry-run", title: "Jev: dry-run for this session only", run: perSession("jev-session-dry-run", (sessionID) => host.rpc().setSessionMode({ sessionID, mode: "dry-run" })) },
    { name: "jev-session-disable", title: "Jev: off for this session only", run: perSession("jev-session-disable", (sessionID) => host.rpc().setSessionMode({ sessionID, mode: "off" })) },
    { name: "jev-session-inherit", title: "Jev: this session follows the global mode", run: perSession("jev-session-inherit", (sessionID) => host.rpc().setSessionMode({ sessionID, mode: "inherit" })) },
  ]
}

export const STATE_LABEL: Record<JevSnapshot["state"] | "unreachable", string> = {
  active: "Active",
  "dry-run": "Dry-run",
  off: "Disabled",
  evaluating: "Evaluating",
  unavailable: "Unavailable",
  budget: "Budget reached",
  unreachable: "Unavailable",
}

export function stateTone(state: JevSnapshot["state"] | "unreachable"): "success" | "warning" | "danger" | undefined {
  if (state === "active" || state === "evaluating") return "success"
  if (state === "dry-run") return undefined
  if (state === "off") return undefined
  return state === "budget" ? "warning" : "danger"
}

const usd = (n: number) => `$${n < 0.01 ? n.toFixed(4) : n.toFixed(2)}`
const ago = (iso: string | null, now: number) => {
  if (!iso) return "never"
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000))
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : `${Math.round(s / 3600)}h ago`
}

const limit = (n: number | null) => (n === null ? "Unlimited" : usd(n))

/** One-line welcome/footer label, e.g. "Jev: Active · TypeSafe". */
export function shortLabel(snap: JevSnapshot | undefined): string {
  if (!snap) return "Jev: Unavailable"
  const provider = snap.endpoint === "typesafe" ? "TypeSafe" : snap.endpoint === "opencode-zen" ? "OpenCode Zen" : snap.endpoint
  return `Jev: ${STATE_LABEL[snap.state]} · ${provider}`
}

/** Compact sidebar rows. "~" marks estimates; "measured" marks API-reported values. */
export function sidebarRows(snap: JevSnapshot | undefined, now = Date.now()): Array<[string, string]> {
  if (!snap) return [["Status", "Unavailable"]]
  const s = snap.session
  const source = snap.modeSource === "session override" ? "session" : snap.modeSource === "config kill switch" ? "config" : snap.modeSource === "unavailable" ? "" : "global"
  const rows: Array<[string, string]> = [
    ["Status", STATE_LABEL[snap.state] + (source ? ` · ${source}` : "") + (snap.reason && snap.state !== "off" ? ` (${snap.reason})` : "")],
    ["Model", snap.model],
    ["Version", snap.version ?? "unknown"],
    ["Evaluations", String(s?.evaluations ?? 0)],
    ["Tokens removed", `~${(s?.tokensRemovedEstimated ?? 0).toLocaleString("en-US")} (est.)`],
    ["Reduction", `~${s?.reductionPctEstimated ?? 0}% (est.)`],
    ["Session cost", `${usd(s?.costUSDEstimated ?? 0)} / ${limit(snap.perSessionUSD)} (est.; ${(s?.jevTokensMeasured ?? 0).toLocaleString("en-US")} tok measured)`],
    ["Today", `${usd(snap.todayUSDEstimated)} / ${limit(snap.perDayUSD)}`],
    ["Last run", ago(s?.lastEvaluationAt ?? null, now)],
  ]
  const t = s?.trigger
  if (t) {
    const k = (n: number) => `${Math.round(n / 1000)}k`
    rows.push(
      ["Trigger", TRIGGER_LABEL[t.reason]],
      ["Context", `${k(t.triggerContextTokens)} / ${k(t.thresholdTokens)}${t.providerContextTokens === null ? " (est.)" : ""}`],
      ["Candidates", `${t.eligibleResults} eligible · ${t.protectedResults} pinned`],
    )
    if (t.reason === "evaluation_failed" && t.lastError) rows.push(["Last error", t.lastError.slice(0, 60)])
  } else if (s) rows.push(["Trigger", "Not checked yet (next request)"])
  return rows
}
