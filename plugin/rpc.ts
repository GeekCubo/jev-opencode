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
  /** Estimated (character-based) tokens removed from outgoing requests so far. */
  tokensRemovedEstimated: number
  /** Estimated context reduction of the last evaluations, 0–100. */
  reductionPctEstimated: number
  /** Jev input tokens as reported by the TypeSafe API. */
  jevTokensMeasured: number
  /** Jev cost: reported tokens × list price (an estimate of the bill). */
  costUSDEstimated: number
  /** Decisions applied right now (in memory; cleared on reload, reset, mode change or native compaction). */
  pruned: { dropped: number; truncated: number }
  lastEvaluationAt: string | null
  evaluating: boolean
}

export interface JevSnapshot {
  state: JevState
  /** Effective mode for the requested session (or the global mode without a session). */
  mode: "off" | "dry-run" | "active"
  globalMode: "off" | "dry-run" | "active"
  modeSource: "inherited from global" | "session override" | "config kill switch" | "unavailable"
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
