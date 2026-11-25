// Summarises one benchmark run from an OpenCode 2.2.x server (no model or Jev requests are made).
// Usage: node benchmarks/collect.mjs <serverURL> <directory> <sessionID> [--jev-ledger <ledger.json>] > run.json
// Auth: OPENCODE_SERVER_PASSWORD (Basic auth as "opencode"); never pass secrets on the command line.
const [url, directory, sessionID, flag, jevFile] = process.argv.slice(2)
if (!url || !directory || !sessionID) throw new Error("usage: collect.mjs <serverURL> <directory> <sessionID> [--jev-stats file]")
const headers = process.env.OPENCODE_SERVER_PASSWORD
  ? { authorization: "Basic " + Buffer.from(`opencode:${process.env.OPENCODE_SERVER_PASSWORD}`).toString("base64") }
  : {}
const get = async (path) => {
  const r = await fetch(`${url}${path}${path.includes("?") ? "&" : "?"}directory=${encodeURIComponent(directory)}`, { headers })
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`)
  return r.json()
}
/** All messages of a session, following the API's cursor pagination (max 200 per page). */
const messages = async (id) => {
  const out = []
  let cursor
  do {
    const page = await get(`/api/session/${id}/message?limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`)
    out.push(...page.data)
    cursor = page.data.length === 200 ? page.cursor?.next : undefined
  } while (cursor)
  return out
}
// Child (subagent) sessions, recursively. OpenCode 2.2.7 lists them with GET /api/session?parentID=<id>
// (there is no /children route). Retrieval errors are fatal: a silently missing subagent would undercount usage.
const listChildren = async (parentID) => {
  const out = []
  let cursor
  do {
    const page = await get(`/api/session?parentID=${encodeURIComponent(parentID)}&limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`)
    out.push(...page.data)
    cursor = page.data.length === 200 ? page.cursor?.next : undefined
  } while (cursor)
  return out
}
const sessions = [sessionID]
for (let i = 0; i < sessions.length; i++) for (const c of await listChildren(sessions[i])) if (!sessions.includes(c.id)) sessions.push(c.id)
// Session-level totals kept by OpenCode, for reconciliation with the per-message sums below.
const sessionTotals = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }
for (const id of sessions) {
  const info = (await get(`/api/session/${id}`)).data ?? {}
  const t = info.tokens ?? {}
  sessionTotals.input += t.input ?? 0
  sessionTotals.output += t.output ?? 0
  sessionTotals.reasoning += t.reasoning ?? 0
  sessionTotals.cacheRead += t.cache?.read ?? 0
  sessionTotals.cacheWrite += t.cache?.write ?? 0
  sessionTotals.cost += Number(info.cost) || 0
}
const sum = { requests: 0, inputUncached: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0, providerCostUSD: 0, costReportedSteps: 0, peakContext: 0, compactions: 0, toolCalls: 0, toolErrors: 0, failedSteps: 0, firstAt: Infinity, lastAt: 0 }
for (const id of sessions) {
  for (const m of await messages(id)) {
    if (m.type === "compaction" || m.type === "summary") sum.compactions++
    if (m.type === "idle" && m.outcome && m.outcome !== "succeeded") sum.failedSteps++
    if (m.error) sum.failedSteps++
    for (const c of m.content ?? []) if (c.type === "tool") (sum.toolCalls++, c.state?.status === "error" && sum.toolErrors++)
    const t0 = m.time?.created, t1 = m.time?.completed ?? m.time?.created
    if (t0) sum.firstAt = Math.min(sum.firstAt, t0)
    if (t1) sum.lastAt = Math.max(sum.lastAt, t1)
    const t = m.tokens
    if (!t) continue
    sum.requests++
    sum.inputUncached += t.input ?? 0
    sum.cacheRead += t.cache?.read ?? 0
    sum.cacheWrite += t.cache?.write ?? 0
    sum.output += t.output ?? 0
    sum.reasoning += t.reasoning ?? 0
    sum.providerCostUSD += Number(m.cost) || 0
    if (Number(m.cost) > 0) sum.costReportedSteps++
    sum.peakContext = Math.max(sum.peakContext, (t.input ?? 0) + (t.cache?.read ?? 0) + (t.cache?.write ?? 0))
  }
}
let jev = null
if (flag === "--jev-ledger" && jevFile) {
  // Per-session figures from the shared accounting file (main session + subagent sessions).
  const d = JSON.parse((await import("node:fs")).readFileSync(jevFile, "utf8"))
  jev = { evaluations: 0, applied: 0, failures: 0, requests: 0, retries: 0, rateLimited: 0, inputTokensMeasured: 0, costUSDEstimated: 0, contextTokensBeforeEstimated: 0, contextTokensAfterEstimated: 0, requestsPruned: 0, tokensRemovedFromRequestsEstimated: 0, modes: {} }
  for (const id of sessions) {
    const r = d.sessions?.[id]
    if (!r) continue
    const c = r.counters ?? {}
    jev.evaluations += c.runs ?? 0
    jev.applied += c.appliedRuns ?? 0
    jev.failures += c.failures ?? 0
    jev.requests += c.jevRequests ?? 0
    jev.rateLimited += c.rateLimited ?? 0
    jev.inputTokensMeasured += c.jevInputTokensMeasured ?? 0
    jev.costUSDEstimated += r.spentUSD ?? 0
    jev.contextTokensBeforeEstimated += c.contextTokensBefore ?? 0
    jev.contextTokensAfterEstimated += c.contextTokensAfter ?? 0
    jev.requestsPruned += c.requestsPruned ?? 0
    jev.tokensRemovedFromRequestsEstimated += c.tokensRemovedFromRequests ?? 0
    jev.modes[id] = r.override ?? "inherit"
  }
}
const durationSec = sum.lastAt > sum.firstAt ? Math.round((sum.lastAt - sum.firstAt) / 1000) : 0
delete sum.firstAt
delete sum.lastAt
// A provider that reports no cost (0 on every step) means unknown cost, not free usage.
const providerCostUSD = sum.costReportedSteps > 0 ? sum.providerCostUSD : null
const costReportedSteps = sum.costReportedSteps
delete sum.costReportedSteps
sum.providerCostUSD = providerCostUSD
const diff = {
  input: sessionTotals.input - sum.inputUncached,
  output: sessionTotals.output - sum.output,
  reasoning: sessionTotals.reasoning - sum.reasoning,
  cacheRead: sessionTotals.cacheRead - sum.cacheRead,
  cacheWrite: sessionTotals.cacheWrite - sum.cacheWrite,
}
console.log(JSON.stringify({
  sessions: sessions.length,
  sessionIDs: sessions,
  durationSec,
  measured: {
    ...sum,
    note: "tokens as reported by the provider per assistant message; providerCostUSD is null when the provider reported no cost (unknown, not free)",
    costReportedSteps,
  },
  sessionTotals: {
    ...sessionTotals,
    cost: sum.providerCostUSD === null && sessionTotals.cost === 0 ? null : sessionTotals.cost,
    note: "OpenCode's session-level totals; they also include auxiliary requests (e.g. title generation) that have no assistant message",
    differenceFromMessages: diff,
  },
  jev,
  totalCostUSD: { provider: providerCostUSD, jevEstimated: jev?.costUSDEstimated ?? 0 },
}, null, 2))
