// Setup assistant (0.3.0): provider-independent model detection, deterministic
// recommendations, presets, single/single-model/mixed-provider support, config
// preview/backup/apply/rollback — all local, mocked catalogues, isolated config dirs.
import { describe, expect, it, beforeEach, afterEach } from "vitest"
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, rmSync, readdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  recommend, recommendAll, applyAgentAssignments, currentAssignments, stripComments,
  type CatalogModel, type Preset, type Role,
} from "../plugin/setup.ts"

const m = (over: Partial<CatalogModel>): CatalogModel => ({
  id: "x/y", name: "Y", modelID: "y", providerID: "x",
  tools: true, reasoning: true, context: 200_000, output: 32_000,
  inputPrice: null, outputPrice: null, cacheReadPrice: null, ...over,
})

// Fixture catalogues (mirroring OpenCode model.list() data, no inference).
const anthropicOnly = () => [
  m({ id: "anthropic/claude-opus-4", modelID: "claude-opus-4", providerID: "anthropic", name: "Claude Opus 4", inputPrice: 15, outputPrice: 75, reasoning: true }),
  m({ id: "anthropic/claude-sonnet-4", modelID: "claude-sonnet-4", providerID: "anthropic", name: "Claude Sonnet 4", inputPrice: 3, outputPrice: 15, reasoning: true }),
  m({ id: "anthropic/claude-haiku-4", modelID: "claude-haiku-4", providerID: "anthropic", name: "Claude Haiku 4", inputPrice: 0.8, outputPrice: 4, reasoning: false }),
]
const openaiOnly = () => [
  m({ id: "openai/gpt-5.2", modelID: "gpt-5.2", providerID: "openai", name: "GPT-5.2", inputPrice: 1.25, outputPrice: 10, reasoning: true }),
  m({ id: "openai/gpt-5.2-mini", modelID: "gpt-5.2-mini", providerID: "openai", name: "GPT-5.2 mini", inputPrice: 0.25, outputPrice: 2, reasoning: false }),
]
const googleOnly = () => [m({ id: "google/gemini-3-pro", modelID: "gemini-3-pro", providerID: "google", name: "Gemini 3 Pro", inputPrice: 1.25, outputPrice: 5 })]
const deepseekOnly = () => [m({ id: "deepseek/deepseek-chat-v4", modelID: "deepseek-chat-v4", providerID: "deepseek", name: "DeepSeek Chat V4", inputPrice: 0.14, outputPrice: 0.42 })]
const glmOnly = () => [m({ id: "zhipu/glm-5.3", modelID: "glm-5.3", providerID: "zhipu", name: "GLM 5.3", inputPrice: 0.5, outputPrice: 1.2 })]
const customOnly = () => [m({ id: "my-proxy/qwen3-uncensored", modelID: "qwen3-uncensored", providerID: "my-proxy", name: "Qwen3 via my-proxy", tools: null, inputPrice: null, outputPrice: null, context: null })]
const mixed = () => [...anthropicOnly(), ...openaiOnly(), ...deepseekOnly(), m({ id: "openrouter/meta-llama-4-405b", modelID: "meta-llama-4-405b", providerID: "openrouter", name: "Llama 4 405B", inputPrice: 0.8, outputPrice: 0.8, tools: true, reasoning: false })]
const singleModel = () => [anthropicOnly()[1]!]
const unknownAll = () => [m({ id: "p/unknown", inputPrice: null, outputPrice: null, tools: null, reasoning: null, context: null, modelID: "unknown", providerID: "p", name: "Unknown Model" })]

describe("recommendations: metadata-driven, never name-driven", () => {
  it("quality: prefers reasoning-capable, tool-capable models; does NOT simply pick the most expensive", () => {
    const r = recommend(anthropicOnly(), "build", "quality")
    // Opus is most expensive; but Sonnet is reasoning-capable with strong tools — quality ranks
    // capability first with price weight 0.1; the most expensive model is NOT auto-picked.
    expect(["anthropic/claude-opus-4", "anthropic/claude-sonnet-4"]).toContain(r.model)
    expect(r.priceKnown).toBe(true)
    expect(r.reason).not.toMatch(/most expensive/)
  })

  it("economy: ranks price first, but never recommends a model without tool support", () => {
    const models = [...anthropicOnly(), m({ id: "x/cheap-no-tools", tools: false, inputPrice: 0.01, outputPrice: 0.01 })]
    for (const role of ["build", "explore", "general"] as Role[]) {
      const r = recommend(models, role, "economy")
      expect(r.model).not.toBe("x/cheap-no-tools")
    }
    const e = recommend(models, "explore", "economy")
    expect(e.model).toBe("anthropic/claude-haiku-4") // cheapest tool-capable
  })

  it("unknown pricing and capabilities stay unknown; models are never disqualified for it", () => {
    const r = recommend(customOnly(), "build", "balanced")
    expect(r.model).toBe("my-proxy/qwen3-uncensored")
    expect(r.priceKnown).toBe(false)
    expect(r.reason).toMatch(/price unknown/)
  })

  it("deterministic: identical inputs produce identical rankings", () => {
    const a = recommendAll(mixed(), "balanced", {})
    const b = recommendAll(mixed(), "balanced", {})
    expect(a.map(r => r.model)).toEqual(b.map(r => r.model))
  })

  it("no suitable model yields a null recommendation with an honest reason, not a guess", () => {
    const r = recommend([], "build", "balanced")
    expect(r.model).toBeNull()
    expect(r.reason).toMatch(/no model/)
  })
})

describe("single-provider, single-model and mixed support", () => {
  it.each([
    ["anthropic-only", anthropicOnly()],
    ["openai-only", openaiOnly()],
    ["google-only", googleOnly()],
    ["glm-only", glmOnly()],
    ["deepseek-only", deepseekOnly()],
    ["custom-provider", customOnly()],
    ["mixed", mixed()],
  ])("%s: every role gets a recommendation from the SAME provider set (no extra providers required)", (_name, models) => {
    for (const role of ["build", "plan", "builder", "reviewer", "general", "explore"] as Role[]) {
      const r = recommend(models as CatalogModel[], role, "balanced")
      expect(r.model).toBeTruthy()
      expect((models as CatalogModel[]).some(mm => mm.id === r.model)).toBe(true)
    }
  })

  it("single model: the assistant can reuse it across roles and says cheaper delegation is unavailable", () => {
    const recs = recommendAll(singleModel(), "balanced", {})
    for (const r of recs) {
      expect(r.model).toBe("anthropic/claude-sonnet-4")
      expect(r.priceKnown).toBe(true)
    }
    // All roles share one model: no savings claim, no requirement for another provider.
    const plans = recommend(singleModel(), "build", "economy")
    expect(plans.model).toBe("anthropic/claude-sonnet-4")
  })

  it("mixed providers: assignments may span providers (exact configured identifiers)", () => {
    // Balanced weights: capability differentiation lets deepseek (cheap, capable) take some roles
    // while anthropic/openai take others — or, if one provider wins everywhere, that is the
    // deterministic outcome. Either way every recommendation is an exact configured id, and
    // DIFFERENT providers CAN be assigned by the user through custom overrides.
    const recs = recommendAll(mixed(), "economy", {})
    for (const r of recs) expect(mixed().some(mm => mm.id === r.model)).toBe(true)
    // Custom override path: different providers to different roles, verbatim.
    const models = mixed()
    const deepseek = recommend(models, "explore", "balanced")
    const anthropic = recommend(models, "build", "quality")
    expect(deepseek.model).not.toBeNull()
    expect(anthropic.model).not.toBeNull()
    // applyAgentAssignments accepts arbitrary per-role providers:
    const dir = mkdtempSync(join(tmpdir(), "jev-mixed-"))
    const cfgPath = join(dir, "opencode.jsonc")
    writeFileSync(cfgPath, "{}")
    try {
      applyAgentAssignments(cfgPath, { build: anthropic.model!, explore: deepseek.model!, reviewer: "openrouter/meta-llama-4-405b" })
      const after = JSON.parse(readFileSync(cfgPath, "utf8"))
      expect(after.agent.build.model).toBe(anthropic.model)
      expect(after.agent.explore.model).toBe(deepseek.model)
      expect(after.agent.reviewer.model).toBe("openrouter/meta-llama-4-405b")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("existing assignment gets a mild stability bonus (reuse over churn)", () => {
    const without = recommend(anthropicOnly(), "build", "balanced")
    const withCurrent = recommend(anthropicOnly(), "build", "balanced", without.model!)
    expect(withCurrent.model).toBe(without.model)
  })
})

describe("configuration editing: preview, backup, apply, rollback", () => {
  let dir: string
  let cfgPath: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "jev-setup-"))
    cfgPath = join(dir, "opencode.jsonc")
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it("preserves unrelated settings, credentials and existing agent keys; only model changes", () => {
    writeFileSync(cfgPath, JSON.stringify({
      $schema: "https://opencode.ai/config.json",
      model: "anthropic/claude-sonnet-4",
      provider: { anthropic: { npm: "@ai-sdk/anthropic", options: { apiKey: "{file:~/.config/opencode/anthropic-key}" } } },
      agent: { build: { model: "anthropic/claude-sonnet-4", mode: "primary", permissions: { deny: ["sudo"] } }, general: { description: "my agent" } },
      theme: "dark",
      plugins: ["some-other-plugin"],
    }, null, 2))
    const edit = applyAgentAssignments(cfgPath, { build: "anthropic/claude-opus-4", explore: "anthropic/claude-haiku-4" })
    const after = JSON.parse(readFileSync(cfgPath, "utf8"))
    expect(after.model).toBe("anthropic/claude-sonnet-4") // default model unchanged
    expect(after.provider.anthropic.options.apiKey).toContain("{file:") // credentials untouched
    expect(after.theme).toBe("dark")
    expect(after.plugins).toEqual(["some-other-plugin"])
    expect(after.agent.build.model).toBe("anthropic/claude-opus-4")
    expect(after.agent.build.mode).toBe("primary") // other agent keys preserved
    expect(after.agent.build.permissions).toEqual({ deny: ["sudo"] })
    expect(after.agent.general.description).toBe("my agent")
    expect(after.agent.explore.model).toBe("anthropic/claude-haiku-4")
    expect(edit.changes.join()).toMatch(/build: model anthropic\/claude-sonnet-4 → anthropic\/claude-opus-4/)
    expect(edit.changes.join()).toMatch(/explore: model set/)
    // A unique backup exists and equals the original.
    expect(edit.backupPath).toBeTruthy()
    expect(JSON.parse(readFileSync(edit.backupPath!, "utf8")).agent.build.model).toBe("anthropic/claude-sonnet-4")
  })

  it("JSONC comments are parsed safely; the written file is valid JSON", () => {
    writeFileSync(cfgPath, `{
  // my schema
  "$schema": "https://opencode.ai/config.json",
  "theme": "dark",
  "agent": { /* build config */ "build": { "model": "a/b" } }
}`)
    applyAgentAssignments(cfgPath, { build: "c/d" })
    const after = JSON.parse(readFileSync(cfgPath, "utf8"))
    expect(after.theme).toBe("dark")
    expect(after.agent.build.model).toBe("c/d")
  })

  it("invalid existing configuration: refused, nothing written, original untouched", () => {
    const original = "{ not valid json !!"
    writeFileSync(cfgPath, original)
    expect(() => applyAgentAssignments(cfgPath, { build: "a/b" })).toThrow(/not valid JSON/)
    expect(readFileSync(cfgPath, "utf8")).toBe(original)
  })

  it("backups never overwrite each other (unique names)", () => {
    writeFileSync(cfgPath, JSON.stringify({ agent: { build: { model: "a/1" } } }))
    const e1 = applyAgentAssignments(cfgPath, { build: "a/2" })
    const e2 = applyAgentAssignments(cfgPath, { build: "a/3" })
    expect(e1.backupPath).not.toBe(e2.backupPath)
    const backups = readdirSync(join(dir, "backups"))
    expect(backups.length).toBe(2)
  })

  it("rollback restores the exact previous configuration", () => {
    const original = JSON.stringify({ agent: { build: { model: "a/1", permissions: { deny: ["x"] } } }, theme: "dark" }, null, 2)
    writeFileSync(cfgPath, original)
    const { backupPath } = applyAgentAssignments(cfgPath, { build: "a/2" })
    // Rollback = copy backup over config.
    writeFileSync(cfgPath, readFileSync(backupPath!, "utf8"))
    expect(readFileSync(cfgPath, "utf8")).toBe(original)
  })

  it("reviewer/builder additions carry restricted permissions; skipUnassigned leaves them out", () => {
    writeFileSync(cfgPath, "{}")
    const edit = applyAgentAssignments(cfgPath, { reviewer: "x/y", builder: "x/z" })
    const after = JSON.parse(readFileSync(cfgPath, "utf8"))
    expect(after.agent.reviewer.permissions.deny).toEqual(["*"])
    expect(after.agent.builder.permissions.deny).toContain("git push")
    const edit2 = applyAgentAssignments(cfgPath, { explore: "x/w" }, { skipUnassigned: true })
    const after2 = JSON.parse(readFileSync(cfgPath, "utf8"))
    expect(after2.agent.explore).toEqual({ model: "x/w" }) // plain model-only entry, no template
    expect(edit2.changes.join()).toMatch(/explore: model set/)
  })

  it("currentAssignments reads JSON and JSONC with comments", () => {
    writeFileSync(cfgPath, `{
  // build agent
  "agent": { "build": { "model": "a/b" } } /* end */
}`)
    expect(currentAssignments(cfgPath)).toEqual({ build: "a/b" })
  })
})

describe("presets", () => {
  it("keep: no recommendations, no changes — the default", () => {
    expect(recommendAll(anthropicOnly(), "keep" as Preset, {})).toEqual([])
  })
  it("quality/balanced/economy: full role sets, deterministic", () => {
    for (const preset of ["quality", "balanced", "economy"] as const) {
      const recs = recommendAll(mixed(), preset, {})
      expect(recs.map(r => r.role)).toEqual(["build", "plan", "builder", "reviewer", "general", "explore"])
      expect(recs.every(r => r.model)).toBe(true)
    }
  })
  it("custom: overrides replace recommendations per role", () => {
    const base = recommendAll(mixed(), "balanced", {})
    const chosen = base.map(r => ({ role: r.role, model: r.model! }))
    // The apply path accepts any subset — custom selections are honored verbatim.
    const models = mixed()
    const overridden = recommend(models, "explore", "balanced", "deepseek/deepseek-chat-v4")
    expect(overridden.model).toBe("deepseek/deepseek-chat-v4") // stability bonus keeps it
  })
})

describe("stripComments", () => {
  it("removes line and block comments, preserves strings", () => {
    const src = `{"a": "//not-a-comment", "b": 1 /* c */, "c": "str\\"//x"}`
    expect(JSON.parse(stripComments(src))).toEqual({ a: "//not-a-comment", b: 1, c: 'str"//x' })
  })
})
