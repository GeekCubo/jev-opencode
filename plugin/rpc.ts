// Typed RPC contract between the Jev server part and its clients (TUI part, Desktop GUI part, HTTP).
// Documented API: https://opencode.ai/docs/build/plugins/rpc
import { Rpc } from "@opencode/plugin/rpc"

const sessionInput = {
  type: "object",
  properties: { sessionID: { type: "string" } },
  additionalProperties: false,
} as const
const textOutput = {
  type: "object",
  properties: { text: { type: "string" } },
  required: ["text"],
  additionalProperties: false,
} as const

/** Display state shared by every client. */
export type JevState = "active" | "dry-run" | "off" | "evaluating" | "unavailable" | "budget"

/** Outcome of the latest trigger check (or evaluation) for a session. */
export type TriggerReason =
  | "disabled"
  | "waiting_threshold"
  | "waiting_growth"
  | "cooldown"
  | "no_eligible_results"
  | "no_new_tool_calls"
  | "budget_exhausted"
  | "auth_unavailable"
  | "concurrency_limit"
  | "evaluating"
  | "evaluation_failed"
  | "insufficient_reduction"
  | "evaluated_dry_run"
  | "pruning_active"

export const TRIGGER_LABEL: Record<TriggerReason, string> = {
  disabled: "Disabled",
  waiting_threshold: "Waiting for context threshold",
  waiting_growth: "Waiting for context growth",
  cooldown: "Cooldown",
  no_eligible_results: "No eligible tool results",
  no_new_tool_calls: "No changed tool calls",
  budget_exhausted: "Budget exhausted",
  auth_unavailable: "Authentication unavailable",
  concurrency_limit: "Waiting for another evaluation",
  evaluating: "Evaluation in progress",
  evaluation_failed: "Evaluation failed",
  insufficient_reduction: "Evaluated, insufficient reduction",
  evaluated_dry_run: "Evaluated (dry-run, not applied)",
  pruning_active: "Pruning active",
}

/** Per-session trigger diagnostics (in memory; numbers and codes only, never content). */
export interface TriggerDiagnostics {
  reason: TriggerReason
  /** Last context size reported by the provider for this session (input + cache read + cache write), if seen. */
  providerContextTokens: number | null
  /** Character-based estimate of the messages Jev sees (excludes system prompt and tool definitions). */
  estimatedContextTokens: number
  /** Context size the trigger compares with the threshold. */
  triggerContextTokens: number
  thresholdTokens: number
  growthTokens: number
  minGrowthTokens: number
  cooldownRemainingMs: number
  eligibleResults: number
  protectedResults: number
  /** True when every gate passed on the last check. */
  eligible: boolean
  checkedAt: string
  lastError: string | null
  lastErrorAt: string | null
}

export interface JevSessionSnapshot {
  /** Jev evaluations run for this session (persisted across reloads and restarts). */
  evaluations: number
  applied: number
  dryRuns: number
  failures: number
  /** Outgoing requests that had cached decisions applied, and estimated tokens removed across them. */
  requestsPruned: number
  tokensRemovedFromRequestsEstimated: number
  nativeCompactions: number
  resets: number
  /** Cumulative estimated tokens removed from outgoing requests (per-request accounting, not proven savings). */
  tokensRemovedEstimated: number
  /** Estimated context reduction of the last evaluation snapshots, 0–100 (not the primary model's context). */
  reductionPctEstimated: number
  /** Jev input tokens as reported by the TypeSafe API. */
  jevTokensMeasured: number
  /** Jev cost: reported tokens × list price (an estimate of the bill). */
  costUSDEstimated: number
  /** Decisions applied right now (in memory; cleared on reload, reset, mode change or native compaction). */
  pruned: { dropped: number; truncated: number }
  lastEvaluationAt: string | null
  evaluating: boolean
  attempts: number
  /** Null until this server instance has seen a request for the session (e.g. right after a reload). */
  trigger: TriggerDiagnostics | null
}

export interface JevSnapshot {
  state: JevState
  /** Effective mode for the requested session (or the global mode without a session). */
  mode: "off" | "dry-run" | "active"
  globalMode: "off" | "dry-run" | "active"
  modeSource: "inherited from global" | "session override" | "config kill switch" | "unavailable"
  /** Plugin version serving this snapshot. */
  version: string
  reason: string | null
  endpoint: string
  model: string
  todayUSDEstimated: number
  /** null = unlimited. */
  perDayUSD: number | null
  perSessionUSD: number | null
  session: JevSessionSnapshot | null
}

export const JevRpc = Rpc.define({
  id: "jev-compaction",
  methods: {
    status: { input: sessionInput, output: textOutput },
    stats: { input: sessionInput, output: textOutput },
    /** Structured state for status indicators. Reads in-memory state only: never calls Jev or a model. */
    snapshot: { input: sessionInput, output: { type: "object" } },
    setMode: {
      input: {
        type: "object",
        properties: { mode: { type: "string", enum: ["off", "dry-run", "active"] } },
        required: ["mode"],
        additionalProperties: false,
      },
      output: textOutput,
    },
    reset: { input: { ...sessionInput, required: ["sessionID"] }, output: textOutput },
    compact: { input: { ...sessionInput, required: ["sessionID"] }, output: textOutput },
    /** Per-session mode override; "inherit" removes it. */
    setSessionMode: {
      input: {
        type: "object",
        properties: { sessionID: { type: "string" }, mode: { type: "string", enum: ["off", "dry-run", "active", "inherit"] } },
        required: ["sessionID", "mode"],
        additionalProperties: false,
      },
      output: textOutput,
    },
  },
  events: {
    /** Jev state changed (mode, evaluation started/finished, reset, budget). Clients re-read `snapshot`. */
    changed: {
      schema: {
        type: "object",
        properties: { sessionID: { type: "string" } },
        additionalProperties: false,
      },
    },
  },
})
