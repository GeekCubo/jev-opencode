/**
 * Optional provider-independent agent configuration assistant (0.3.0).
 *
 * Entirely local: it reads the model catalogue through the plugin context, computes
 * deterministic recommendations, and edits the user's global OpenCode configuration
 * ONLY after explicit approval, with a timestamped backup and rollback. It never
 * makes inference requests, never touches credentials, and never changes providers
 * or routing. The default is "keep my existing configuration".
 */
import { readFileSync, writeFileSync, copyFileSync, existsSync, mkdirSync, renameSync } from "node:fs"
import { applySplices, deepEqual, insertProperty, parse, parseTree, prop, type JsonValue, type Node, type Splice } from "./jsonc.ts"
import { join } from "node:path"

export type Preset = "keep" | "quality" | "balanced" | "economy" | "custom"

export const PRESET_LABEL: Record<Preset, string> = {
  keep: "Keep my existing configuration (recommended default)",
  quality: "Maximum quality",
  balanced: "Balanced",
  economy: "Economy",
  custom: "Custom (choose per role)",
}

/** Agent roles the assistant can recommend assignments for. */
export type Role = "build" | "plan" | "builder" | "reviewer" | "general" | "explore"

export const ROLE_LABEL: Record<Role, string> = {
  build: "Build (primary implementation)",
  plan: "Plan (planning and architectural analysis)",
  builder: "Builder (delegated implementation subagent)",
  reviewer: "Reviewer (independent review subagent)",
  general: "General (general-purpose delegated work)",
  explore: "Explore (fast repository exploration)",
}

export interface CatalogModel {
  /** providerID/modelID — the exact configured identifier. */
  id: string
  name: string
  modelID: string | null
  providerID: string | null
  tools: boolean | null
  reasoning: boolean | null
  context: number | null
  output: number | null
  /** USD per million input tokens, when the provider publishes pricing. */
  inputPrice: number | null
  outputPrice: number | null
  cacheReadPrice: number | null
}

export interface Recommendation {
  role: Role
  /** Exact provider/model identifier, or null when nothing suitable exists. */
  model: string | null
  /** Exact modelID shown to the user. */
  modelID: string | null
  providerID: string | null
  reason: string
  priceKnown: boolean
}

/** Known-quality heuristics — capabilities and pricing, never display names. */
interface Suitability {
  tools: boolean
  context: number
  reasoning: boolean
  /** Higher is better; input+output price blend, USD/M, null when unknown. */
  price: number | null
}

const suitability = (m: CatalogModel): Suitability | null => {
  // Agents need tool support; unknown tools is acceptable only when nothing else exists.
  if (m.tools === false) return null
  return {
    tools: m.tools === true,
    context: m.context ?? 0,
    reasoning: m.reasoning === true,
    price: m.inputPrice !== null && m.outputPrice !== null ? (m.inputPrice! + m.outputPrice!) / 2 : null,
  }
}

/**
 * Deterministic, local recommendation per role. Known metadata only; unknown stays unknown.
 * Ranking: required capability (tools) first, then context, reasoning and price according to
 * the preset. Ties resolve to the cheapest KNOWN price, then the larger context. Unknown
 * prices never disqualify a model; they are reported as "unknown".
 */
export function recommend(models: CatalogModel[], role: Role, preset: Preset, current?: string): Recommendation {
  const usable = models.map(m => ({ m, s: suitability(m) })).filter(x => x.s !== null) as Array<{ m: CatalogModel; s: Suitability }>
  if (usable.length === 0) return none(role, "no model advertises tool support or basic capability metadata")
  const of = (m: CatalogModel) => usable.find(u => u.m.id === m.id)!.s

  const needsTools = (r: Role) => r !== "plan"
  let pool = usable.filter(u => (needsTools(role) ? u.s.tools : true))
  // Plan can use any reasoning-capable model; other roles need tools. If nothing qualifies,
  // relax rather than fail: report the relaxation in the reason.
  let relaxed = false
  if (pool.length === 0) (pool = usable), (relaxed = true)

  // Role-specific capability floors (advisory, from observed agent workloads).
  const minContext = role === "explore" || role === "builder" ? 32_000 : 64_000
  let candidates = pool.filter(u => u.s.context === 0 || u.s.context >= minContext)
  if (candidates.length === 0) candidates = pool

  // Price preference by preset: quality ranks price last; economy ranks it first.
  const priceWeight = preset === "economy" ? 1 : preset === "balanced" ? 0.5 : preset === "quality" ? 0.1 : 0.35
  const score = (u: { m: CatalogModel; s: Suitability }): number[] => {
    const p = u.s.price
    // Normalize price score: cheaper known price scores higher; unknown prices score neutral (0.5).
    const priceScore = p === null ? 0.5 : Math.max(0, Math.min(1, 1 / (1 + p / 5)))
    const reasoningScore = u.s.reasoning ? 1 : 0.4
    const contextScore = Math.min(1, u.s.context / 200_000)
    const toolsScore = u.s.tools ? 1 : 0.2
    const stays = current === u.m.id ? 0.05 : 0 // mild stability bonus for the existing assignment
    return [
      toolsScore * (role === "plan" ? 0.5 : 1),
      reasoningScore * (role === "reviewer" || role === "plan" ? 1 : 0.4),
      priceScore * priceWeight * 2,
      contextScore * 0.8,
      stays,
    ]
  }
  const total = (u: { m: CatalogModel; s: Suitability }): number => score(u).reduce((a, b) => a + b, 0)
  const ranked = [...candidates].sort((a, b) => {
    const d = total(b) - total(a)
    if (Math.abs(d) > 0.01) return d
    // Deterministic tie-breaks: known cheaper price, then larger context, then id.
    const pa = a.s.price, pb = b.s.price
    if (pa !== null && pb !== null && pa !== pb) return pa - pb
    if (pa !== null && pb === null) return -1
    if (pa === null && pb !== null) return 1
    if (a.s.context !== b.s.context) return b.s.context - a.s.context
    return a.m.id < b.m.id ? -1 : 1
  })
  const best = ranked[0]!
  const priceKnown = best.s.price !== null
  const reasons: string[] = []
  if (relaxed) reasons.push("no model advertises the role's required capabilities; best available suggested")
  reasons.push(
    role === "explore"
      ? `fast exploration: ${best.m.tools ? "tool-capable" : "tools unknown"}, ${fmtCtx(best.s.context)} context${best.s.price !== null ? `, $${best.s.price.toFixed(2)}/M blended` : ", price unknown"}`
      : role === "reviewer" || role === "plan"
        ? `reasoning-capable for ${role === "reviewer" ? "independent review" : "planning"}${best.s.reasoning ? "" : " (reasoning unconfirmed)"}${best.s.price !== null ? `, $${best.s.price.toFixed(2)}/M blended` : ", price unknown"}`
        : `balanced implementation capability${best.s.price !== null ? `, $${best.s.price.toFixed(2)}/M blended` : ", price unknown"}`,
  )
  return {
    role,
    model: best.m.id,
    modelID: best.m.modelID ?? best.m.id.split("/")[1] ?? null,
    providerID: best.m.providerID ?? best.m.id.split("/")[0] ?? null,
    reason: reasons.join("; "),
    priceKnown,
  }
}

const none = (role: Role, why: string): Recommendation => ({ role, model: null, modelID: null, providerID: null, reason: why, priceKnown: false })
const fmtCtx = (c: number) => (c > 0 ? `${Math.round(c / 1000)}k` : "unknown")

/** All role recommendations for a preset, deterministic. */
export function recommendAll(models: CatalogModel[], preset: Preset, current: Partial<Record<Role, string>>): Recommendation[] {
  if (preset === "keep") return []
  const roles: Role[] = ["build", "plan", "builder", "reviewer", "general", "explore"]
  return roles.map(r => recommend(models, r, preset, current[r]))
}

// ---------------------------------------------------------------------------
// Configuration editing: parse JSONC text, edit the agents section, keep the rest verbatim.
// ---------------------------------------------------------------------------

export interface ConfigEdit {
  /** The full new configuration text (JSONC preserved where it existed). */
  text: string
  backupPath: string | null
  /** Human-readable summary of sections affected. */
  changes: string[]
}

/**
 * Applies approved agent-model assignments to global OpenCode configuration.
 * - Reads the existing file (JSON or JSONC: comments and trailing commas).
 * - Refuses an invalid file without touching it.
 * - Backs it up to <dir>/backups/jev-agent-setup-<timestamp>.jsonc (never overwrites).
 * - Edits the text in place: only the `model` value of an existing agent is
 *   replaced, and missing agents (or a missing `agent` object) are inserted.
 *   Comments, formatting, other agent keys and every unrelated property are kept
 *   byte for byte. The result is re-parsed and checked: if anything other than
 *   the approved agent models would change, nothing is written.
 * - New agent entries (builder/reviewer) get the documented safe defaults.
 * The write is atomic: written to a temp file, then renamed.
 */
export function applyAgentAssignments(
  configPath: string,
  assignments: Partial<Record<Role, string>>,
  options: { skipUnassigned?: boolean } = {},
): ConfigEdit {
  const exists = existsSync(configPath)
  const raw = exists ? readFileSync(configPath, "utf8") : "{}\n"
  let root: Node
  try {
    root = parseTree(raw)
  } catch (e) {
    throw new Error(`existing configuration at ${configPath} is not valid JSON/JSONC: ${(e as Error).message}`)
  }
  if (root.type !== "object") throw new Error(`existing configuration at ${configPath} is not valid JSON/JSONC: top level is not an object`)

  const NEW_AGENTS: Partial<Record<Role, { description: string; mode: string; permissions: any }>> = {
    builder: {
      description: "Delegated implementation subagent for bounded coding tasks (added by /jev-setup).",
      mode: "subagent",
      permissions: { deny: ["git push", "rm -rf /", "sudo"], ask: ["destructive operations"] },
    },
    reviewer: {
      description: "Independent review subagent for correctness, regressions and quality (added by /jev-setup).",
      mode: "subagent",
      permissions: { deny: ["*"], allow: ["read", "grep", "glob", "lsp", "git diff", "git log", "git show"] },
    },
  }
  const changes: string[] = []
  const splices: Splice[] = []
  const agentNode = prop(root, "agent")
  if (agentNode && agentNode.type !== "object") throw new Error(`existing configuration at ${configPath}: "agent" is not an object; nothing changed`)
  const newAgents: Record<string, JsonValue> = {}
  const expected: any = structuredClone(root.value)
  expected.agent ??= {}
  for (const [role, model] of Object.entries(assignments)) {
    if (!model) continue
    const r = role as Role
    const existing = prop(agentNode, r)
    if (existing && existing.type !== "object") throw new Error(`existing configuration at ${configPath}: agent.${r} is not an object; nothing changed`)
    if (existing) {
      const modelNode = prop(existing, "model")
      const oldModel = (modelNode?.value as string | undefined) ?? "(unset)"
      if (modelNode) splices.push({ at: modelNode.start, remove: modelNode.end - modelNode.start, insert: JSON.stringify(model) })
      else splices.push({ ...asSplice(insertProperty(raw, existing, "model", model)) })
      expected.agent[r] = { ...expected.agent[r], model }
      changes.push(`agent.${r}: model ${oldModel} → ${model} (other keys preserved)`)
    } else {
      const entry = NEW_AGENTS[r] && !options.skipUnassigned ? { ...NEW_AGENTS[r]!, model } : { model }
      newAgents[r] = entry as JsonValue
      expected.agent[r] = entry
      changes.push(NEW_AGENTS[r] && !options.skipUnassigned
        ? `agent.${r}: new agent (model ${model}, restricted permissions as documented)`
        : `agent.${r}: model set to ${model}`)
    }
  }
  if (Object.keys(newAgents).length) {
    if (agentNode) {
      for (const [k, v] of Object.entries(newAgents).reverse()) splices.push(asSplice(insertProperty(raw, agentNode, k, v)))
    } else splices.push(asSplice(insertProperty(raw, root, "agent", newAgents)))
  }
  if (!changes.length) return { text: raw, backupPath: null, changes }
  const text = mergeInsertsAt(raw, splices)
  // Verify: the edited text parses and differs from the original only by the approved agent fields.
  let after: JsonValue
  try {
    after = parse(text)
  } catch (e) {
    throw new Error(`internal edit produced invalid configuration; nothing changed (${(e as Error).message})`)
  }
  if (!deepEqual(after, expected)) throw new Error("internal edit verification failed; nothing changed")

  const backupPath = exists ? backupOf(configPath) : null
  if (backupPath) copyFileSync(configPath, backupPath)
  const tmp = `${configPath}.jev-tmp-${Date.now()}`
  writeFileSync(tmp, text, "utf8")
  renameSync(tmp, configPath)
  return { text, backupPath, changes }
}

const asSplice = (x: { at: number; insert: string }): Splice => ({ at: x.at, remove: 0, insert: x.insert })

/** Several insertions at the same offset are concatenated in the order given. */
const mergeInsertsAt = (text: string, edits: Splice[]): string => {
  const byAt = new Map<number, Splice>()
  const out: Splice[] = []
  for (const e of edits) {
    const prev = e.remove === 0 ? byAt.get(e.at) : undefined
    if (prev) prev.insert += e.insert
    else {
      const copy = { ...e }
      out.push(copy)
      if (e.remove === 0) byAt.set(e.at, copy)
    }
  }
  return applySplices(text, out)
}

/** Conservative comment stripper for JSONC parsing (strings preserved). */
export function stripComments(text: string): string {
  let out = ""
  let i = 0
  let inString = false
  while (i < text.length) {
    const c = text[i]!
    if (inString) {
      out += c
      if (c === "\\") (out += text[i + 1] ?? ""), (i += 2)
      else {
        if (c === '"') inString = false
        i++
      }
      continue
    }
    if (c === '"') (inString = true), (out += c), i++
    else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++
    } else if (c === "/" && text[i + 1] === "*") {
      i += 2
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++
      i += 2
    } else (out += c), i++
  }
  return out
}

const backupOf = (configPath: string) => {
  const dir = join(configPath, "..", "backups")
  mkdirSync(dir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, "-")
  let path = join(dir, `jev-agent-setup-${stamp}.jsonc`)
  // Never overwrite an existing backup: extend the name until unique.
  for (let i = 1; existsSync(path); i++) path = join(dir, `jev-agent-setup-${stamp}-${i}.jsonc`)
  writeFileSync(path, "", "utf8") // reserve the name atomically-enough for our purposes
  return path
}

/** Reads the model catalogue through the plugin context (local metadata; no inference). */
export async function catalog(ctx: any): Promise<CatalogModel[]> {
  const list = await ctx.model.list()
  return list.data.map((m: any) => ({
    id: `${m.providerID}/${m.id}`,
    name: (m.name ?? m.id) as string,
    modelID: m.id as string,
    providerID: m.providerID as string,
    tools: m.capabilities?.tools ?? null,
    reasoning: m.capabilities?.reasoning ?? null,
    context: m.limit?.context ?? null,
    output: m.limit?.output ?? null,
    inputPrice: m.cost?.[0]?.input ?? null,
    outputPrice: m.cost?.[0]?.output ?? null,
    cacheReadPrice: m.cost?.[0]?.cache?.read ?? null,
  }))
}

/** The user's current agent assignments from the live config (context.config or file). */
export function currentAssignments(configPath: string): Partial<Record<Role, string>> {
  if (!existsSync(configPath)) return {}
  try {
    const cfg = parse(readFileSync(configPath, "utf8")) as any
    const out: Partial<Record<Role, string>> = {}
    for (const role of ["build", "plan", "builder", "reviewer", "general", "explore"] as Role[])
      if (typeof cfg.agent?.[role]?.model === "string") out[role] = cfg.agent[role].model
    return out
  } catch {
    return {}
  }
}
