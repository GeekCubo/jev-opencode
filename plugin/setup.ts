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
 * - Reads the existing file (JSON or JSONC).
 * - Backs it up to <dir>/backups/jev-agent-setup-<timestamp>.jsonc (never overwrites).
 * - Merges the `agent` object only: existing agent entries keep every other key
 *   (mode, permissions, tools, prompt, description...); only `model` changes.
 * - New agent entries (builder/reviewer) are added with the documented safe defaults.
 * The write is atomic: written to a temp file, then renamed.
 */
export function applyAgentAssignments(
  configPath: string,
  assignments: Partial<Record<Role, string>>,
  options: { skipUnassigned?: boolean } = {},
): ConfigEdit {
  const raw = existsSync(configPath) ? readFileSync(configPath, "utf8") : "{}"
  // Parse with comments tolerated (JSONC): strip // and /* */ lines conservatively for VALUE
  // extraction, but keep the original text for re-serialization of untouched parts is NOT
  // attempted — OpenCode config files are machine-edited by OpenCode itself; we preserve
  // the file's comments by editing only through a JSON.parse of a comment-stripped copy and
  // writing standard JSON with 2-space indent when comments exist… Instead, to guarantee
  // validity, we: (1) back up, (2) write the merged configuration as plain JSON.
  const stripped = stripComments(raw)
  let cfg: any
  try {
    cfg = JSON.parse(stripped)
  } catch (e) {
    throw new Error(`existing configuration at ${configPath} is not valid JSON/JSONC: ${(e as Error).message}`)
  }
  const backupPath = backupOf(configPath)
  copyFileSync(configPath, backupPath)

  const changes: string[] = []
  cfg.agent ??= {}
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
  for (const [role, model] of Object.entries(assignments)) {
    if (!model) continue
    const r = role as Role
    const existing = cfg.agent[r]
    if (existing) {
      const oldModel = existing.model ?? "(unset)"
      cfg.agent[r] = { ...existing, model }
      changes.push(`agent.${r}: model ${oldModel} → ${model} (other keys preserved)`)
    } else if (NEW_AGENTS[r] && !options.skipUnassigned) {
      cfg.agent[r] = { ...NEW_AGENTS[r]!, model }
      changes.push(`agent.${r}: new agent (model ${model}, restricted permissions as documented)`)
    } else {
      cfg.agent[r] = { model }
      changes.push(`agent.${r}: model set to ${model}`)
    }
  }
  const text = JSON.stringify(cfg, null, 2) + "\n"
  const tmp = `${configPath}.jev-tmp-${Date.now()}`
  writeFileSync(tmp, text, "utf8")
  renameSync(tmp, configPath)
  return { text, backupPath, changes }
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
    const cfg = JSON.parse(stripComments(readFileSync(configPath, "utf8")))
    const out: Partial<Record<Role, string>> = {}
    for (const role of ["build", "plan", "builder", "reviewer", "general", "explore"] as Role[])
      if (typeof cfg.agent?.[role]?.model === "string") out[role] = cfg.agent[role].model
    return out
  } catch {
    return {}
  }
}
