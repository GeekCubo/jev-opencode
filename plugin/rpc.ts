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
  /** Jev evaluations run for this session. */
  evaluations: number
  /** Estimated (character-based) tokens removed from outgoing requests so far. */
  tokensRemovedEstimated: number
  /** Estimated context reduction of the last evaluations, 0–100. */
  reductionPctEstimated: number
  /** Jev input tokens as reported by the TypeSafe API. */
  jevTokensMeasured: number
  /** Jev cost: reported tokens × list price (an estimate of the bill). */
  costUSDEstimated: number
  pruned: { dropped: number; truncated: number }
  lastEvaluationAt: string | null
  evaluating: boolean
}

export interface JevSnapshot {
  state: JevState
  mode: "off" | "dry-run" | "active"
  reason: string | null
  endpoint: string
  model: string
  todayUSDEstimated: number
  perDayUSD: number
  perSessionUSD: number
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
