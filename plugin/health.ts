/**
 * Session health assessment (0.3.0). Pure local computation from existing Jev
 * diagnostics — no inference requests, no state changes, no I/O.
 *
 * Two token spaces are kept strictly separate:
 * - Primary model context: what the session's model receives (provider-reported
 *   input + cache read + cache write, or the character-based estimate).
 * - Jev evaluation state: the bounded state Jev scores tool calls against
 *   (capped by maxStateTokens); unrelated to the primary context.
 */
import type { JevConfig } from "./config.ts"

export type HealthLevel = "healthy" | "growing" | "compaction_recommended" | "new_session_recommended"

export const HEALTH_LABEL: Record<HealthLevel, string> = {
  healthy: "Healthy",
  growing: "Growing",
  compaction_recommended: "Compaction recommended",
  new_session_recommended: "New session recommended",
}

/** Advisory recommendation for the level; Jev never acts on it automatically. */
export const HEALTH_RECOMMENDATION: Record<HealthLevel, string> = {
  healthy: "Continue normally.",
  growing: "Monitor context growth.",
  compaction_recommended: "Complete the current operation and consider native compaction.",
  new_session_recommended: "Complete the current development checkpoint, prepare a handover (/jev-handover) and start a fresh session.",
}

export interface HealthInput {
  /** Primary context tokens: provider-reported (input + cache read + cache write) or estimated. */
  contextTokens: number
  /** Provider-reported when available, else the character estimate. */
  contextIsProviderReported: boolean
  /** Model context window, when known. */
  contextWindow?: number
  /** Jev evaluation state tokens of the latest evaluation, when one ran. */
  stateTokens?: number
  maxStateTokens: number
  /** Eligible / protected tool results at the last check, when known. */
  eligibleResults?: number
  protectedResults?: number
  /** Last evaluation's estimated context reduction, 0–100 (evaluation snapshot, not provider billing). */
  reductionPctEstimated?: number
  /** Consecutive insufficient-reduction outcomes. */
  insufficientReductions: number
  /** Consecutive evaluation failures. */
  evaluationFailures: number
  /** Native compactions this session. */
  nativeCompactions: number
  /** When the latest native compaction ran (epoch ms), if ever. */
  lastNativeCompactionAt?: number
  now: number
}

export interface HealthResult {
  level: HealthLevel
  /** 0–100 context utilisation vs the model window when known. */
  utilizationPct: number | null
  /** The specific signals that drove the level, newest-signal-first. */
  reasons: string[]
  recommendation: string
  /** Suggested next action, phrased as a user action. */
  nextAction: string
}

/** Advisory absolute thresholds (tokens of primary context). Overridable via `health` in the plugin options. */
export const DEFAULT_HEALTH_THRESHOLDS = {
  growing: 100_000,
  compaction: 200_000,
  freshSession: 300_000,
  strongFreshSession: 500_000,
}

export interface HealthThresholds {
  growing: number
  compaction: number
  freshSession: number
  strongFreshSession: number
}

const k = (n: number) => `${Math.round(n / 1000)}k`

/**
 * Session health from local evidence. Adaptive: with a known context window the
 * absolute thresholds are scaled down so a 128k-window session is warned at
 * proportionally earlier context (e.g. growing at 25% of the window, compaction
 * at 50%, fresh-session at 75%); window-relative advice never waits for the
 * model's hard limit. Without a window only the absolute thresholds apply.
 * Hysteresis is applied by the caller (see `healthShouldNotify`).
 */
export function assessHealth(input: HealthInput, thresholds: HealthThresholds = DEFAULT_HEALTH_THRESHOLDS): HealthResult {
  const reasons: string[] = []
  const t = scaleThresholds(thresholds, input.contextWindow)
  let level: HealthLevel = "healthy"

  // Utilisation vs the model window (when known): the earliest useful signal.
  const utilization = input.contextWindow && input.contextWindow > 0 ? (input.contextTokens / input.contextWindow) * 100 : null
  if (utilization !== null) {
    const pct = Math.round(utilization)
    if (utilization >= 90) {
      level = "new_session_recommended"
      reasons.push(`Context is ${pct}% of the model's ${k(input.contextWindow!)}-token window; headroom is nearly exhausted`)
    } else if (utilization >= 75) {
      level = max(level, "new_session_recommended")
      reasons.push(`Context is ${pct}% of the model's ${k(input.contextWindow!)}-token window`)
    } else if (utilization >= 50) {
      level = max(level, "compaction_recommended")
      reasons.push(`Context is ${pct}% of the model's ${k(input.contextWindow!)}-token window`)
    } else if (utilization >= 25) {
      level = max(level, "growing")
      reasons.push(`Context is ${pct}% of the model's ${k(input.contextWindow!)}-token window`)
    }
  }

  // Absolute context size (always applicable, provider-reported or estimated).
  if (input.contextTokens >= t.strongFreshSession) {
    level = max(level, "new_session_recommended")
    reasons.push(`Context ${k(input.contextTokens)} tokens (strongly above the ${k(t.strongFreshSession)} advisory limit)`)
  } else if (input.contextTokens >= t.freshSession) {
    level = max(level, "new_session_recommended")
    reasons.push(`Context ${k(input.contextTokens)} tokens (above the ${k(t.freshSession)} advisory threshold)`)
  } else if (input.contextTokens >= t.compaction) {
    level = max(level, "compaction_recommended")
    reasons.push(`Context ${k(input.contextTokens)} tokens (above the ${k(t.compaction)} advisory threshold)`)
  } else if (input.contextTokens >= t.growing) {
    level = max(level, "growing")
    reasons.push(`Context ${k(input.contextTokens)} tokens (above the ${k(t.growing)} advisory threshold)`)
  }

  // Optimization effectiveness (Jev evidence).
  if (input.insufficientReductions >= 2) {
    level = max(level, "compaction_recommended")
    reasons.push(`${input.insufficientReductions} consecutive evaluations found too little to reduce (minReductionRatio not met)`)
  }
  if (input.evaluationFailures >= 3) {
    level = max(level, "new_session_recommended")
    reasons.push(`${input.evaluationFailures} consecutive evaluation failures`)
  } else if (input.evaluationFailures > 0) {
    level = max(level, "growing")
    reasons.push(`${input.evaluationFailures} consecutive evaluation failure(s) (Jev falls back to native behaviour)`)
  }
  // Repeated compactions without relief: native compaction is not helping.
  if (input.nativeCompactions >= 2 && input.contextTokens >= t.compaction) {
    level = max(level, "new_session_recommended")
    reasons.push(`${input.nativeCompactions} native compactions this session and context is still ${k(input.contextTokens)} tokens`)
  }
  // The primary context dwarfs the state Jev can see: windowed evaluation.
  if (input.stateTokens !== undefined && input.stateTokens > 0 && input.contextTokens > 4 * input.maxStateTokens && input.eligibleResults !== undefined && input.eligibleResults > 0) {
    level = max(level, "compaction_recommended")
    reasons.push(`Primary context ${k(input.contextTokens)} far exceeds Jev's ${k(input.maxStateTokens)} evaluation-state window (${input.eligibleResults} results still eligible)`)
  }

  if (reasons.length === 0) reasons.push("Context manageable; no optimization problems detected")
  return {
    level,
    utilizationPct: utilization === null ? null : Math.round(utilization),
    reasons,
    recommendation: HEALTH_RECOMMENDATION[level],
    nextAction: nextActionFor(level, input),
  }
}

const max = (a: HealthLevel, b: HealthLevel): HealthLevel => (RANK[a] >= RANK[b] ? a : b)
const RANK: Record<HealthLevel, number> = { healthy: 0, growing: 1, compaction_recommended: 2, new_session_recommended: 3 }

const nextActionFor = (level: HealthLevel, input: HealthInput): string => {
  switch (level) {
    case "healthy":
      return "No action needed."
    case "growing":
      return input.contextIsProviderReported
        ? "Keep working; the next Jev evaluation will run on the threshold/growth gates as usual."
        : "Keep working; context is estimated (provider-reported tokens will refine the assessment)."
    case "compaction_recommended":
      return input.nativeCompactions > 0
        ? "At the next checkpoint consider /jev-compact (a forced Jev evaluation) or native compaction."
        : "At the next checkpoint consider /jev-compact (a forced Jev evaluation) or native compaction."
    case "new_session_recommended":
      return "Run /jev-handover to prepare a continuation summary, then start a fresh session at the next logical milestone."
  }
}

/** Scales absolute thresholds down for small context windows (never up). */
function scaleThresholds(t: HealthThresholds, window?: number): HealthThresholds {
  if (!window || window <= 0) return t
  // A 128k window should warn earlier than a 1M window: 25% / 50% / 75% of the window,
  // bounded above by the absolute advisory thresholds.
  const rel = (pct: number, abs: number) => Math.min(abs, Math.floor(window * pct))
  return {
    growing: Math.min(t.growing, rel(0.25, t.growing)),
    compaction: Math.min(t.compaction, rel(0.5, t.compaction)),
    freshSession: Math.min(t.freshSession, rel(0.75, t.freshSession)),
    strongFreshSession: Math.min(t.strongFreshSession, window),
  }
}

// ---------------------------------------------------------------------------
// Notifications: hysteresis + cooldown, per session, in memory.
// ---------------------------------------------------------------------------

export interface NotifyState {
  lastLevel: HealthLevel
  lastNotifyAt: number
  lastLevelAt: number
}

/** Notification cadence: transitions notify once; the same level re-notifies after 30 minutes. */
export const NOTIFY_RE_NOTIFY_MS = 30 * 60 * 1000
/** Hysteresis: a deterioration notifies immediately; an improvement must persist… */
export const NOTIFY_SETTLE_MS = 60_000

export function newNotifyState(): NotifyState {
  return { lastLevel: "healthy", lastNotifyAt: 0, lastLevelAt: 0 }
}

/**
 * Whether the user should be notified now: only on meaningful deterioration
 * (rank increase), or the same non-healthy level re-notifying after the
 * cooldown. Improvements are silent (no interruption), just recorded.
 */
export function healthShouldNotify(state: NotifyState, level: HealthLevel, now: number, cooldownMs = NOTIFY_RE_NOTIFY_MS): boolean {
  const worse = RANK[level] > RANK[state.lastLevel]
  if (worse) return true
  const sameBad = level === state.lastLevel && level !== "healthy"
  return sameBad && now - state.lastNotifyAt >= cooldownMs
}

/** Records the observation after deciding. */
export function recordNotify(state: NotifyState, level: HealthLevel, now: number): void {
  if (level !== state.lastLevel) state.lastLevelAt = now
  state.lastLevel = level
  state.lastNotifyAt = now
}

/** Resets notification state (fresh session semantics / after successful compaction relief). */
export function resetNotifyState(state: NotifyState): void {
  state.lastLevel = "healthy"
  state.lastNotifyAt = 0
  state.lastLevelAt = 0
}

/** Message shown for a level; never claims financial savings. */
export function healthNotifyMessage(level: HealthLevel, input: HealthInput): string {
  const k = (n: number) => `${Math.round(n / 1000)}k`
  switch (level) {
    case "healthy":
      return "Session healthy."
    case "growing":
      return `Session context has reached ${k(input.contextTokens)} tokens. Monitor context growth.`
    case "compaction_recommended":
      return input.insufficientReductions >= 2
        ? `Session context ${k(input.contextTokens)} tokens and recent evaluations found too little to reduce. Consider native compaction at the next checkpoint.`
        : `Session context has reached ${k(input.contextTokens)} tokens. Consider native compaction at the next development checkpoint.`
    case "new_session_recommended":
      return input.evaluationFailures >= 3
        ? "Jev has encountered repeated evaluation-state failures. Review session health (/jev-health) before continuing."
        : `Session context has reached ${k(input.contextTokens)} tokens and recent context optimization effectiveness has declined. Consider preparing a handover (/jev-handover) and starting a fresh session.`
  }
}

/** Resolves optional `health` overrides from the plugin options through the existing config mechanism. */
export function healthThresholdsFromConfig(cfg: JevConfig): HealthThresholds | undefined {
  const h = (cfg as JevConfig & { health?: Partial<HealthThresholds> }).health
  if (!h || typeof h !== "object") return undefined
  const merged: HealthThresholds = { ...DEFAULT_HEALTH_THRESHOLDS, ...h }
  for (const v of Object.values(merged)) if (typeof v !== "number" || !Number.isFinite(v) || v < 1000) return undefined
  return merged
}
