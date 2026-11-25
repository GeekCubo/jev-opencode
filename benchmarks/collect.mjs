// Summarises one benchmark run from an OpenCode 2.2.x server (no model or Jev requests are made).
// Usage: node benchmarks/collect.mjs <serverURL> <directory> <sessionID> [--jev-stats <stats.json>] > run.json
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
const sum = { requests: 0, inputUncached: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0, providerCostUSD: 0, peakContext: 0, compactions: 0 }
for (const id of sessions) {
  for (const m of await messages(id)) {
    if (m.type === "compaction" || m.type === "summary") sum.compactions++
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
if (flag === "--jev-stats" && jevFile) {
  const s = JSON.parse((await import("node:fs")).readFileSync(jevFile, "utf8"))
  const g = s.global ?? {}
  jev = {
    evaluations: g.runs ?? 0,
    requests: g.jevRequests ?? 0,
    inputTokensMeasured: g.jevInputTokensMeasured ?? 0,
    costUSDEstimated: g.jevCostUSD ?? 0,
    contextTokensBeforeEstimated: g.contextTokensBefore ?? 0,
    contextTokensAfterEstimated: g.contextTokensAfter ?? 0,
  }
}
console.log(JSON.stringify({
  sessions: sessions.length,
  measured: { ...sum, note: "tokens and cost as reported by OpenCode/provider; cost is 0 where the provider reports none" },
  jev,
  totalCostUSD: { provider: sum.providerCostUSD, jevEstimated: jev?.costUSDEstimated ?? 0 },
}, null, 2))
