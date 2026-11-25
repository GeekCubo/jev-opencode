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
const sessions = [sessionID]
// Include child (subagent) sessions when the server lists them.
try {
  for (const s of (await get(`/api/session/${sessionID}/children`)).data) sessions.push(s.id)
} catch {}
const sum = { requests: 0, inputUncached: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0, providerCostUSD: 0, peakContext: 0, compactions: 0, toolCalls: 0, toolErrors: 0, failedSteps: 0, firstAt: Infinity, lastAt: 0 }
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
console.log(JSON.stringify({
  sessions: sessions.length,
  durationSec,
  measured: { ...sum, note: "tokens and cost as reported by OpenCode/provider; cost is 0 where the provider reports none" },
  jev,
  totalCostUSD: { provider: sum.providerCostUSD, jevEstimated: jev?.costUSDEstimated ?? 0 },
}, null, 2))
