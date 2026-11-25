/**
 * Adapter between OpenCode 2.x request messages (`@opencode/ai` Message: system/user/assistant/tool
 * with `tool-call` / `tool-result` parts) and the upstream fast-jev-compaction `Message` shape.
 * Equivalent of upstream `hooks/fast-jev.ts`, for OpenCode's `context` hook.
 *
 * Only `tool-call` / `tool-result` parts are ever removed or truncated. Every other part (text,
 * reasoning, media, compaction checkpoints, provider metadata) is returned verbatim, untouched
 * messages are returned as the same objects, and message order never changes.
 */
import { applyDecisions, compact, reductionRatio, truncatedResultText } from "./upstream/compact.ts"
import { collectToolCalls } from "./upstream/state.ts"
import type { CallDecision, CompactResult, JevAsker, Message as UMessage, ToolCall } from "./upstream/types.ts"

/** Structural subset of `@opencode/ai` Message we rely on. */
export interface OcPart {
  readonly type: string
  readonly [k: string]: unknown
}
export interface OcMessage {
  readonly role: "system" | "user" | "assistant" | "tool"
  readonly content: ReadonlyArray<OcPart>
  readonly [k: string]: unknown
}

/** Tools whose calls are never pruned: they carry plans, todos, questions, instructions or state changes. */
export const DEFAULT_PROTECTED_TOOLS = [
  /^(todo|todowrite|todoread|task|plan|question|skill|subagent|goal|memory)/i,
  /(write|edit|patch|apply|create|delete|move|rename)/i,
]

const ERROR_TEXT = /(\berror\b|\bfailed\b|\bfailure\b|exception|traceback|panic|assert|✗|FAIL\b|not ok)/i
const INSTRUCTION_READ = /(AGENTS\.md|CLAUDE\.md|CONTRIBUTING|README|SECURITY|\.cursorrules|opencode\.jsonc?|requirements?|spec|acceptance|plan)/i

export function resultText(part: OcPart): string {
  const result = part.result as { type?: string; value?: unknown } | undefined
  if (!result) return ""
  if (result.type === "content" && Array.isArray(result.value))
    return result.value.map((v: any) => (v?.type === "text" ? v.text : `[${v?.mime ?? "file"} ${v?.name ?? v?.uri ?? ""}]`)).join("\n")
  if (typeof result.value === "string") return result.value
  try {
    return JSON.stringify(result.value) ?? ""
  } catch {
    return "[unserializable result]"
  }
}

function textOf(m: OcMessage): string {
  return m.content
    .filter((p) => p.type === "text")
    .map((p) => String(p.text ?? ""))
    .join("\n")
}

export interface Projection {
  /** One upstream message per OpenCode non-system message, same order. */
  messages: UMessage[]
  /** Index into the original array for each projected message. */
  origin: number[]
}

/** Projects OpenCode messages to upstream messages. System messages are excluded (never candidates). */
export function project(messages: readonly OcMessage[]): Projection {
  const out: UMessage[] = []
  const origin: number[] = []
  messages.forEach((m, i) => {
    if (m.role === "system") return
    const role = m.role === "assistant" ? "assistant" : "user"
    const toolUses = m.content
      .filter((p) => p.type === "tool-call" && p.providerExecuted !== true)
      .map((p) => ({ tool_use_id: String(p.id), tool: String(p.name), input: (p.input && typeof p.input === "object" ? p.input : { value: p.input }) as Record<string, unknown> }))
    const toolResults = m.content
      .filter((p) => p.type === "tool-result")
      .map((p) => ({ tool_use_id: String(p.id), text: resultText(p), isError: (p.result as any)?.type === "error" }))
    const u: UMessage = { role, text: textOf(m), toolUses }
    if (toolResults.length) u.toolResults = toolResults
    out.push(u)
    origin.push(i)
  })
  return { messages: out, origin }
}

export interface ProtectionOptions {
  protectTools: RegExp[]
  /** Results with errors in the newest N projected messages after the call stay (unresolved errors). */
  keepErrorsWithinMessages: number
  /** tool_use ids Jev already decided on in an earlier run; never re-asked (cost). */
  alreadyDecided?: ReadonlySet<string>
}

/** Quality protection: calls that are pinned regardless of what Jev says. */
export function makeProtector(projected: readonly UMessage[], opts: ProtectionOptions) {
  const total = projected.length
  const lastUserText = [...projected].reverse().find((m) => m.role === "user" && m.text.trim() && !(m.toolResults ?? []).length)?.text ?? ""
  return (call: ToolCall): boolean => {
    if (opts.alreadyDecided?.has(call.tool_use_id)) return true
    if (DEFAULT_PROTECTED_TOOLS.some((r) => r.test(call.tool))) return true
    if (opts.protectTools.some((r) => r.test(call.tool))) return true
    const input = JSON.stringify(call.input ?? {})
    if (INSTRUCTION_READ.test(input)) return true
    const result = projected[call.resultIndex]?.toolResults?.find((r) => r.tool_use_id === call.tool_use_id)
    const isErrorish = call.isError || (result ? ERROR_TEXT.test(result.text.slice(0, 4000)) : false)
    if (isErrorish && total - call.resultIndex <= opts.keepErrorsWithinMessages) return true
    // Anything the latest user prompt explicitly names (e.g. a file path) stays.
    const path = (call.input as any)?.path ?? (call.input as any)?.file_path ?? (call.input as any)?.filePath
    const base = typeof path === "string" ? path.split("/").filter(Boolean).pop() ?? "" : ""
    if (base.length > 3 && lastUserText.includes(base)) return true
    return false
  }
}

/**
 * Rebuilds OpenCode messages from upstream decisions. A dropped call removes the `tool-call` part and
 * its matching `tool-result`; a truncated result replaces only the result value with the upstream
 * head + note. Messages left empty are removed. Untouched messages keep their identity.
 */
export function applyToOpenCode<M extends OcMessage>(
  messages: readonly M[],
  decisions: readonly CallDecision[],
  calls: readonly ToolCall[],
  headChars: number,
  rebuild: (original: M, content: OcPart[]) => M,
): M[] {
  const byId = new Map(calls.map((c) => [c.id, c]))
  const actions = new Map<string, CallDecision["action"]>()
  for (const d of decisions) {
    const c = byId.get(d.id)
    if (c && d.action !== "keep") actions.set(c.tool_use_id, d.action)
  }
  if (actions.size === 0) return [...messages]
  const out: M[] = []
  for (const m of messages) {
    if (m.role === "system") {
      out.push(m)
      continue
    }
    let changed = false
    const content: OcPart[] = []
    for (const p of m.content) {
      const action = (p.type === "tool-call" || p.type === "tool-result") ? actions.get(String(p.id)) : undefined
      if (!action) {
        content.push(p)
        continue
      }
      if (action === "drop_call") {
        changed = true
        continue
      }
      if (p.type === "tool-result") {
        const text = resultText(p)
        const isError = (p.result as any)?.type === "error"
        const truncated = truncatedResultText(text, isError, headChars)
        if (truncated !== text) {
          changed = true
          content.push({ ...p, result: { type: isError ? "error" : "text", value: truncated } })
          continue
        }
      }
      content.push(p)
    }
    if (!changed) {
      out.push(m)
      continue
    }
    if (content.length === 0) continue
    out.push(rebuild(m, content))
  }
  return out
}

/** Verifies every remaining tool-call has a result and vice versa (provider integrity). */
export function checkIntegrity(messages: readonly OcMessage[]): string | undefined {
  const calls = new Set<string>()
  const results = new Set<string>()
  for (const m of messages)
    for (const p of m.content) {
      if (p.type === "tool-call" && p.providerExecuted !== true) calls.add(String(p.id))
      if (p.type === "tool-result") results.add(String(p.id))
    }
  for (const id of results) if (!calls.has(id)) return `orphan tool-result ${id}`
  return undefined
}

export interface PruneOutcome<M> {
  messages: M[]
  result: CompactResult
  ratio: number
  calls: ToolCall[]
}

/** Runs the upstream algorithm over OpenCode messages. Throws on Jev failure (caller falls back). */
export async function prune<M extends OcMessage>(
  messages: readonly M[],
  asker: JevAsker,
  options: {
    keepThreshold: number
    preserveRecentMessages: number
    truncateHeadChars: number
    maxStateTokens: number
    maxRequestTokens: number
    protection: ProtectionOptions
  },
  rebuild: (original: M, content: OcPart[]) => M,
): Promise<PruneOutcome<M>> {
  const { messages: projected } = project(messages)
  const isProtected = makeProtector(projected, options.protection)
  const result = await compact(projected, asker, { ...options, isProtected })
  const calls = collectToolCalls(projected, options.preserveRecentMessages).map((c) => (!c.pinned && isProtected(c) ? { ...c, pinned: true } : c))
  const rebuilt = applyToOpenCode(messages, result.decisions, calls, options.truncateHeadChars, rebuild)
  const integrity = checkIntegrity(rebuilt)
  if (integrity) throw new Error(`integrity check failed: ${integrity}`)
  return { messages: rebuilt, result, ratio: reductionRatio(result), calls }
}

export { applyDecisions }
