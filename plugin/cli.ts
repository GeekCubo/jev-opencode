#!/usr/bin/env node
// Prints the Jev status snapshot written by the plugin. Usage: node --experimental-strip-types cli.ts [sessionID]
import { readFileSync } from "node:fs"

import { formatStats, emptyCounters } from "./statistics.ts"
import { statsSnapshotPath } from "./util.ts"

const path = statsSnapshotPath()
let data: any
try {
  data = JSON.parse(readFileSync(path, "utf8"))
} catch {
  console.log(`No Jev statistics yet (${path}).`)
  process.exit(0)
}
console.log(`Jev compaction — mode=${data.mode} endpoint=${data.endpoint} model=${data.model} ($${data.pricePerMTok}/Mtok input), updated ${data.updatedAt}`)
const lim = (n: number | null) => (n === null ? "Unlimited" : `$${n}`)
console.log(`Budget: today $${Number(data.spentTodayUSD).toFixed(5)} of ${lim(data.budget.perDayUSD)}/day, ${lim(data.budget.perSessionUSD)}/session`)
const id = process.argv[2]
if (id) {
  const s = data.sessions[id]
  if (s?.trigger) {
    const t = s.trigger
    console.log(`Trigger: ${t.reason} (checked ${t.checkedAt}); context provider ${t.providerContextTokens ?? "n/a"}, estimated ${t.estimatedContextTokens}, used ${t.triggerContextTokens} / threshold ${t.thresholdTokens}; growth ${t.growthTokens}/${t.minGrowthTokens}; tool results ${t.eligibleResults} eligible, ${t.protectedResults} pinned${t.lastError ? `; last error: ${t.lastError}` : ""}`)
  }
  console.log(s ? formatStats(`Session ${id} (spent $${s.spentUSD.toFixed(5)}; pruned ${JSON.stringify(s.pruned)})`, { ...emptyCounters(), ...s.counters }) : `No data for ${id} in this server run.`)
} else {
  for (const [sid, s] of Object.entries<any>(data.sessions)) console.log(`  ${sid}: spent $${s.spentUSD.toFixed(5)}, Jev requests ${s.counters.jevRequests}, pruned ${JSON.stringify(s.pruned)}`)
}
console.log(formatStats("All sessions (persisted)", { ...emptyCounters(), ...data.global }))
