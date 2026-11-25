/**
 * Token and expenditure accounting. Every figure is tagged by provenance:
 * - measured: reported by an API (Jev `usage.input_tokens`, OpenCode `session.step.ended` cost/tokens)
 * - estimated: computed locally (character-based token estimates, projected savings)
 */
export interface Counters {
  /** Evaluations started (successful = runs; failed = failures; budget-blocked counted separately). */
  attempts: number
  runs: number
  dryRuns: number
  appliedRuns: number
  skippedInsufficient: number
  failures: number
  rateLimited: number
  budgetBlocked: number
  nativeFallbacks: number
  nativeCompactions: number
  jevRequests: number
  jevInputTokensMeasured: number
  jevInputTokensEstimated: number
  jevCostUSD: number
  durationMsTotal: number
  callsKept: number
  callsPinned: number
  resultsTruncated: number
  callsDropped: number
  /** Estimated tokens before/after pruning, summed per run. */
  contextTokensBefore: number
  contextTokensAfter: number
  /** Estimated tokens removed from outgoing requests, summed over every request decisions were applied to. */
  tokensRemovedFromRequests: number
  requestsPruned: number
  /** Estimated input cost avoided at the primary model's list input price (ignores caching). */
  estimatedSavingsUSD: number
  /** Measured from OpenCode step events. */
  primarySteps: number
  primaryCostUSD: number
  primaryInputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  /** Cache-write tokens on the first step after a pruning change (prompt-cache invalidation signal). */
  cacheWriteAfterPruneChange: number
  resets: number
}

export const emptyCounters = (): Counters => ({
  attempts: 0, runs: 0, dryRuns: 0, appliedRuns: 0, skippedInsufficient: 0, failures: 0, rateLimited: 0, budgetBlocked: 0,
  nativeFallbacks: 0, nativeCompactions: 0, jevRequests: 0, jevInputTokensMeasured: 0, jevInputTokensEstimated: 0,
  jevCostUSD: 0, durationMsTotal: 0, callsKept: 0, callsPinned: 0, resultsTruncated: 0, callsDropped: 0,
  contextTokensBefore: 0, contextTokensAfter: 0, tokensRemovedFromRequests: 0, requestsPruned: 0,
  estimatedSavingsUSD: 0, primarySteps: 0, primaryCostUSD: 0, primaryInputTokens: 0, cacheReadTokens: 0,
  cacheWriteTokens: 0, cacheWriteAfterPruneChange: 0, resets: 0,
})

export interface KeyValueStore {
  get(key: string): Promise<unknown>
  set(key: string, value: any): Promise<void>
}

/**
 * Durable spend and counter accounting. Several plugin instances (one per project location in a single
 * OpenCode service) share one plugin storage, so totals are never written from a cached copy: every
 * flush re-reads the stored value and adds only this instance's unflushed delta. Writes are serialised
 * per instance. Budget checks use the stored value plus pending deltas.
 */
export class Ledger {
  private pending = new Map<string, number>()
  private pendingCounters: Partial<Counters> = {}
  private chain: Promise<void> = Promise.resolve()
  private cache = new Map<string, number>()
  private store: KeyValueStore

  constructor(store: KeyValueStore) {
    this.store = store
  }

  static dayKey = (day: string) => `spend/${day}`
  static sessionKey = (sessionID: string) => `session-spend/${sessionID}`

  private async stored(key: string): Promise<number> {
    const v = Number(await this.store.get(key).catch(() => 0))
    return Number.isFinite(v) ? v : 0
  }

  /** Current total for a key: stored (refreshed) + unflushed delta. */
  async total(key: string): Promise<number> {
    const v = await this.stored(key)
    this.cache.set(key, v)
    return v + (this.pending.get(key) ?? 0)
  }

  /** Last known total without I/O (for display). */
  cachedTotal(key: string): number {
    return (this.cache.get(key) ?? 0) + (this.pending.get(key) ?? 0)
  }

  addSpend(keys: string[], usd: number) {
    for (const k of keys) this.pending.set(k, (this.pending.get(k) ?? 0) + usd)
  }

  addCounters(delta: Partial<Counters>) {
    for (const [k, v] of Object.entries(delta)) (this.pendingCounters as any)[k] = ((this.pendingCounters as any)[k] ?? 0) + (v as number)
  }

  async counters(): Promise<Counters> {
    const stored = { ...emptyCounters(), ...(((await this.store.get("stats").catch(() => undefined)) as object) ?? {}) }
    add(stored, this.pendingCounters)
    return stored
  }

  flush(): Promise<void> {
    this.chain = this.chain.then(async () => {
      const spend = [...this.pending]
      const counters = this.pendingCounters
      this.pending = new Map()
      this.pendingCounters = {}
      try {
        for (const [key, delta] of spend) {
          const next = (await this.stored(key)) + delta
          await this.store.set(key, next)
          this.cache.set(key, next)
        }
        if (Object.keys(counters).length) {
          const stored = { ...emptyCounters(), ...(((await this.store.get("stats").catch(() => undefined)) as object) ?? {}) }
          add(stored, counters)
          await this.store.set("stats", stored)
        }
      } catch {
        // Keep unflushed deltas for the next attempt rather than losing spend.
        for (const [key, delta] of spend) this.pending.set(key, (this.pending.get(key) ?? 0) + delta)
        this.addCounters(counters)
      }
    })
    return this.chain
  }
}

export function add(target: Counters, delta: Partial<Counters>): void {
  for (const [k, v] of Object.entries(delta)) (target as any)[k] += v as number
}

const pct = (a: number, b: number) => (b > 0 ? `${((1 - a / b) * 100).toFixed(1)}%` : "n/a")
const usd = (n: number) => `$${n.toFixed(n < 0.01 ? 5 : 4)}`

export function formatStats(label: string, c: Counters): string {
  return [
    `${label}`,
    `  Evaluation attempts: ${c.attempts}; successful ${c.runs}; failed ${c.failures}; pruning applied ${c.appliedRuns} time(s), to ${c.requestsPruned} outgoing request(s)`,
    `  Jev runs: ${c.runs} (dry-run ${c.dryRuns}, applied ${c.appliedRuns}, insufficient ${c.skippedInsufficient}, failed ${c.failures}, budget-blocked ${c.budgetBlocked}, 429s ${c.rateLimited})`,
    `  Jev requests: ${c.jevRequests}; input tokens measured ${c.jevInputTokensMeasured}, estimated ${c.jevInputTokensEstimated}; Jev cost ${usd(c.jevCostUSD)} (tokens × list price)`,
    `  Avg run duration: ${c.runs ? Math.round(c.durationMsTotal / c.runs) : 0} ms`,
    `  Decisions: kept ${c.callsKept}, pinned ${c.callsPinned}, truncated ${c.resultsTruncated}, dropped ${c.callsDropped}`,
    `  Context per run (estimated, ~3.6 chars/token): ${c.contextTokensBefore} → ${c.contextTokensAfter} tokens (${pct(c.contextTokensAfter, c.contextTokensBefore)} reduction)`,
    `  Requests pruned: ${c.requestsPruned}; tokens removed across them (estimated): ${c.tokensRemovedFromRequests}`,
    `  Estimated downstream savings: ${usd(c.estimatedSavingsUSD)} (list input price, ignores cache discounts; NOT measured)`,
    `  Primary model (measured by OpenCode): ${c.primarySteps} steps, ${usd(c.primaryCostUSD)}, input ${c.primaryInputTokens}, cache read ${c.cacheReadTokens}, cache write ${c.cacheWriteTokens}`,
    `  Cache writes on first step after a pruning change: ${c.cacheWriteAfterPruneChange}`,
    `  Native: fallbacks requested ${c.nativeFallbacks}, native compactions observed ${c.nativeCompactions}; /jev-reset used ${c.resets}`,
  ].join("\n")
}
