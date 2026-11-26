export type Mode = "off" | "dry-run" | "active"
export type Endpoint = "typesafe" | "opencode-zen"

export const ENDPOINTS: Record<Endpoint, string> = {
  typesafe: "https://api.typesafe.ai/v1/systemone",
  "opencode-zen": "https://opencode.ai/inference/systemone/v1/systemone",
}

/** USD per 1M input tokens, from the official pricing pages (checked 2026-11-25). Output is free. */
export const KNOWN_PRICES: Record<string, number> = {
  "jev-1.14": 0.042,
  "jev-1.14.0": 0.042,
  "jev-1.13": 0.042,
  "jev-1.13.0": 0.042,
}

/** Free / rate-limited models we refuse unless explicitly approved. */
const FREE_MODELS = new Set(["jev-1.13-free"])

export const HARD_MAX_PRICE_PER_MTOK = 1.5

export interface JevConfig {
  mode: Mode
  endpoint: Endpoint
  /** Overrides the endpoint URL; must be https. */
  url?: string
  model: string
  /** Required only for models not in KNOWN_PRICES. */
  approvedPricePerMTok?: number
  maxPricePerMTok: number
  keepThreshold: number
  /** Absolute token threshold; the effective threshold is min(this, contextFraction * window). */
  compactAtTokens: number
  compactAtContextFraction: number
  preserveRecentMessages: number
  truncateHeadChars: number
  minReductionRatio: number
  maxStateTokens: number
  maxRequestTokens: number
  /** Re-ask Jev only after context grows this many estimated tokens since the last run. */
  minGrowthTokens: number
  cooldownMs: number
  timeoutMs: number
  maxRetries: number
  /** USD limits on estimated Jev spend. `null` = unlimited (spend is still tracked). */
  budget: { perSessionUSD: number | null; perDayUSD: number | null }
  /** Ask OpenCode to run native summary compaction when Jev cannot reduce enough. */
  nativeFallback: boolean
  /** Extra regexes (as strings) whose matching tool names are never pruned. */
  protectTools: string[]
  logDecisions: boolean
  /** Optional advisory session-health threshold overrides (tokens). */
  health?: { growing?: number; compaction?: number; freshSession?: number; strongFreshSession?: number }
}

export const DEFAULTS: JevConfig = {
  mode: "dry-run",
  endpoint: "typesafe",
  model: "jev-1.14",
  maxPricePerMTok: HARD_MAX_PRICE_PER_MTOK,
  keepThreshold: 0.5,
  compactAtTokens: 60_000,
  compactAtContextFraction: 0.6,
  preserveRecentMessages: 6,
  truncateHeadChars: 300,
  minReductionRatio: 0.15,
  maxStateTokens: 25_000,
  maxRequestTokens: 30_000,
  minGrowthTokens: 8_000,
  cooldownMs: 60_000,
  timeoutMs: 20_000,
  maxRetries: 2,
  budget: { perSessionUSD: 0.25, perDayUSD: 1 },
  nativeFallback: true,
  protectTools: [],
  logDecisions: false,
}

export class ConfigError extends Error {}

function num(v: unknown, fallback: number, min: number, max: number, name: string): number {
  if (v === undefined) return fallback
  if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > max)
    throw new ConfigError(`${name} must be a number in [${min}, ${max}]`)
  return v
}

/** A spending limit: a number in [0, max], or `null` for explicitly unlimited. Anything else is rejected. */
function limit(v: unknown, fallback: number, max: number, name: string): number | null {
  if (v === null) return null
  return num(v, fallback, 0, max, name + " (or null for unlimited)")
}

/** True when `spent + add` would exceed the limit. Unlimited never exceeds. */
export const exceeds = (limitUSD: number | null, spent: number, add = 0) => limitUSD !== null && spent + add > limitUSD
export const reached = (limitUSD: number | null, spent: number) => limitUSD !== null && spent >= limitUSD
export const formatLimit = (limitUSD: number | null) => (limitUSD === null ? "Unlimited" : `$${limitUSD.toFixed(2)}`)

/**
 * Accepts either a flat options object or the nested `{ compaction: {...}, routing: {...} }`
 * shape from the original brief. Routing is not supported and must be disabled if present.
 */
export function resolveConfig(raw: Record<string, unknown> = {}): JevConfig {
  const routing = raw.routing as { enabled?: unknown } | undefined
  if (routing && routing.enabled) throw new ConfigError("routing is not supported by this plugin; set routing.enabled=false")
  const src: Record<string, any> = { ...raw, ...((raw.compaction as object) ?? {}) }
  if (src.enabled === false) src.mode = "off"

  const mode = (src.mode ?? DEFAULTS.mode) as Mode
  if (!["off", "dry-run", "active"].includes(mode)) throw new ConfigError("mode must be off, dry-run or active")
  const endpoint = (src.endpoint ?? DEFAULTS.endpoint) as Endpoint
  if (!(endpoint in ENDPOINTS)) throw new ConfigError("endpoint must be typesafe or opencode-zen")
  if (src.url !== undefined && (typeof src.url !== "string" || !/^(https:\/\/|http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/)/.test(src.url)))
    throw new ConfigError("url must be https (plain http only for localhost testing)")
  const model = src.model ?? DEFAULTS.model
  if (typeof model !== "string" || !model) throw new ConfigError("model must be a string")

  const maxPrice = num(src.maxPricePerMTok, DEFAULTS.maxPricePerMTok, 0, HARD_MAX_PRICE_PER_MTOK, "maxPricePerMTok")
  const cfg: JevConfig = {
    mode,
    endpoint,
    url: src.url,
    model,
    approvedPricePerMTok: src.approvedPricePerMTok === undefined ? undefined : num(src.approvedPricePerMTok, 0, 0, HARD_MAX_PRICE_PER_MTOK, "approvedPricePerMTok"),
    maxPricePerMTok: maxPrice,
    keepThreshold: num(src.keepThreshold, DEFAULTS.keepThreshold, 0, 1, "keepThreshold"),
    compactAtTokens: num(src.compactAtTokens, DEFAULTS.compactAtTokens, 1_000, 10_000_000, "compactAtTokens"),
    compactAtContextFraction: num(src.compactAtContextFraction, DEFAULTS.compactAtContextFraction, 0.05, 0.95, "compactAtContextFraction"),
    preserveRecentMessages: num(src.preserveRecentMessages, DEFAULTS.preserveRecentMessages, 2, 1_000, "preserveRecentMessages"),
    truncateHeadChars: num(src.truncateHeadChars, DEFAULTS.truncateHeadChars, 0, 20_000, "truncateHeadChars"),
    minReductionRatio: num(src.minReductionRatio, DEFAULTS.minReductionRatio, 0, 1, "minReductionRatio"),
    maxStateTokens: num(src.maxStateTokens, DEFAULTS.maxStateTokens, 1_000, 60_000, "maxStateTokens"),
    maxRequestTokens: num(src.maxRequestTokens, DEFAULTS.maxRequestTokens, 2_000, 64_000, "maxRequestTokens"),
    minGrowthTokens: num(src.minGrowthTokens, DEFAULTS.minGrowthTokens, 0, 1_000_000, "minGrowthTokens"),
    cooldownMs: num(src.cooldownMs, DEFAULTS.cooldownMs, 0, 86_400_000, "cooldownMs"),
    timeoutMs: num(src.timeoutMs, DEFAULTS.timeoutMs, 1_000, 120_000, "timeoutMs"),
    maxRetries: num(src.maxRetries, DEFAULTS.maxRetries, 0, 5, "maxRetries"),
    budget: {
      perSessionUSD: limit(src.budget?.perSessionUSD, DEFAULTS.budget.perSessionUSD!, 100, "budget.perSessionUSD"),
      perDayUSD: limit(src.budget?.perDayUSD, DEFAULTS.budget.perDayUSD!, 1_000, "budget.perDayUSD"),
    },
    nativeFallback: src.nativeFallback ?? DEFAULTS.nativeFallback,
    protectTools: Array.isArray(src.protectTools) ? src.protectTools.map(String) : [],
    logDecisions: src.logDecisions === true,
    health: src.health && typeof src.health === "object" ? { ...src.health } : undefined,
  }
  if (cfg.maxStateTokens >= cfg.maxRequestTokens) throw new ConfigError("maxStateTokens must be below maxRequestTokens")
  for (const pattern of cfg.protectTools) new RegExp(pattern)
  return cfg
}

/** Price per 1M input tokens, or throws when the model is unpriced/unapproved/over the cap. */
export function priceFor(cfg: Pick<JevConfig, "model" | "approvedPricePerMTok" | "maxPricePerMTok">): number {
  if (FREE_MODELS.has(cfg.model) && cfg.approvedPricePerMTok === undefined)
    throw new ConfigError(`${cfg.model} is the rate-limited free tier; set approvedPricePerMTok: 0 to use it explicitly`)
  const price = KNOWN_PRICES[cfg.model] ?? cfg.approvedPricePerMTok
  if (price === undefined)
    throw new ConfigError(`no known price for ${cfg.model}; set approvedPricePerMTok to approve it explicitly`)
  if (price > cfg.maxPricePerMTok) throw new ConfigError(`${cfg.model} costs $${price}/Mtok, above the $${cfg.maxPricePerMTok} cap`)
  return price
}

/** TypeSafe Direct needs versioned IDs (`jev-1.14.0`); OpenCode Zen uses `jev-1.14`. */
const TYPESAFE_IDS: Record<string, string> = { "jev-1.14": "jev-1.14.0", "jev-1.13": "jev-1.13.0" }
export function wireModel(cfg: Pick<JevConfig, "endpoint" | "model">): string {
  if (cfg.endpoint === "typesafe") return TYPESAFE_IDS[cfg.model] ?? cfg.model
  return cfg.model.replace(/^(jev-\d+\.\d+)\.0$/, "$1")
}

export function endpointUrl(cfg: Pick<JevConfig, "endpoint" | "url">): string {
  return cfg.url ?? ENDPOINTS[cfg.endpoint]
}

/** Effective compaction threshold for a model with the given context window. */
export function thresholdFor(cfg: Pick<JevConfig, "compactAtTokens" | "compactAtContextFraction">, contextWindow?: number): number {
  if (!contextWindow || contextWindow <= 0) return cfg.compactAtTokens
  return Math.min(cfg.compactAtTokens, Math.floor(contextWindow * cfg.compactAtContextFraction))
}
