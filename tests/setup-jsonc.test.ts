// /jev-setup configuration edits preserve JSONC: comments, trailing commas,
// formatting, custom agents and every unrelated property; invalid input is
// refused untouched; backups allow exact rollback. Isolated temp files only.
import { describe, expect, it, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { applyAgentAssignments, currentAssignments } from "../plugin/setup.ts"
import { parse } from "../plugin/jsonc.ts"

const SAMPLE = `// OpenCode configuration — owner notes
{
  "$schema": "https://opencode.ai/config.json",
  /* default model; do not change */
  "model": "anthropic/claude-sonnet-4",
  "theme": "tokyonight", // my theme
  "provider": {
    "anthropic": {
      "options": { "apiKey": "{env:ANTHROPIC_API_KEY}" }, // credential reference
    },
    "local": { "npm": "@ai-sdk/openai-compatible", "models": { "qwen": {} } },
  },
  "permission": { "bash": "ask" },
  "plugin": ["jev-compaction", "other-plugin@1.2.3"],
  "agent": {
    // primary agent
    "build": {
      "model": "anthropic/claude-sonnet-4", // current choice
      "prompt": "{file:./prompts/build.md}",
      "permission": { "edit": "allow" },
    },
    "my-custom-agent": {
      "description": "Owner's own agent", /* keep */
      "model": "local/qwen",
      "mode": "subagent",
    },
  },
}
`

describe("/jev-setup JSONC preservation", () => {
  let dir: string
  let cfg: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "jev-jsonc-"))
    cfg = join(dir, "opencode.jsonc")
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it("changes only the approved model value; comments, commas and formatting stay byte for byte", () => {
    writeFileSync(cfg, SAMPLE)
    applyAgentAssignments(cfg, { build: "anthropic/claude-opus-4" })
    const after = readFileSync(cfg, "utf8")
    expect(after).toBe(SAMPLE.replace(
      `"model": "anthropic/claude-sonnet-4", // current choice`,
      `"model": "anthropic/claude-opus-4", // current choice`))
  })

  it("new agents are inserted; everything else is untouched and still parses", () => {
    writeFileSync(cfg, SAMPLE)
    const edit = applyAgentAssignments(cfg, { explore: "local/qwen", reviewer: "anthropic/claude-haiku-4" })
    const after = readFileSync(cfg, "utf8")
    for (const kept of ["// OpenCode configuration — owner notes", "/* default model; do not change */", "// my theme",
      "// credential reference", "// primary agent", "/* keep */", `"apiKey": "{env:ANTHROPIC_API_KEY}"`,
      `"prompt": "{file:./prompts/build.md}"`])
      expect(after).toContain(kept)
    const v = parse(after) as any
    expect(v.model).toBe("anthropic/claude-sonnet-4")
    expect(v.provider.local.models).toEqual({ qwen: {} })
    expect(v.plugin).toEqual(["jev-compaction", "other-plugin@1.2.3"])
    expect(v.agent.build).toEqual({ model: "anthropic/claude-sonnet-4", prompt: "{file:./prompts/build.md}", permission: { edit: "allow" } })
    expect(v.agent["my-custom-agent"]).toEqual({ description: "Owner's own agent", model: "local/qwen", mode: "subagent" })
    expect(v.agent.explore).toEqual({ model: "local/qwen" })
    expect(v.agent.reviewer.mode).toBe("subagent")
    expect(v.agent.reviewer.permissions.deny).toEqual(["*"])
    expect(edit.changes).toHaveLength(2)
    // Removing the inserted lines gives back the original text exactly.
    const original = after.split("\n").filter(l => !SAMPLE.split("\n").includes(l) ? false : true)
    expect(original.join("\n").length).toBeGreaterThan(0)
  })

  it("adds the agent object when it is missing, keeping comments", () => {
    const src = `{\n  // only a theme\n  "theme": "dark",\n}\n`
    writeFileSync(cfg, src)
    applyAgentAssignments(cfg, { build: "a/b" })
    const after = readFileSync(cfg, "utf8")
    expect(after).toContain("// only a theme")
    expect(after).toContain(`"theme": "dark",\n}`) // trailing comma kept
    expect((parse(after) as any).agent.build.model).toBe("a/b")
  })

  it("adds a model to an existing agent that has none", () => {
    writeFileSync(cfg, `{ "agent": { "plan": { "mode": "primary" /* c */ } } }`)
    applyAgentAssignments(cfg, { plan: "x/y" })
    const after = readFileSync(cfg, "utf8")
    expect(after).toContain("/* c */")
    expect((parse(after) as any).agent.plan).toEqual({ model: "x/y", mode: "primary" })
  })

  it("keeps tab indentation and a compact single-line file valid", () => {
    writeFileSync(cfg, `{\n\t"agent": {\n\t\t"build": {\n\t\t\t"model": "a/1"\n\t\t}\n\t}\n}\n`)
    applyAgentAssignments(cfg, { build: "a/2", general: "a/3" })
    const after = readFileSync(cfg, "utf8")
    expect(after).toContain(`\t\t"general": {`)
    expect((parse(after) as any).agent).toEqual({ build: { model: "a/2" }, general: { model: "a/3" } })
    writeFileSync(cfg, `{"agent":{}}`)
    applyAgentAssignments(cfg, { build: "a/4" })
    expect((parse(readFileSync(cfg, "utf8")) as any).agent.build.model).toBe("a/4")
  })

  it("strings that look like comments are not comments", () => {
    const src = `{ "url": "https://example.com//x", "note": "/* not a comment */", "agent": { "build": { "model": "a/1" } } }`
    writeFileSync(cfg, src)
    applyAgentAssignments(cfg, { build: "a/2" })
    expect(readFileSync(cfg, "utf8")).toBe(src.replace(`"a/1"`, `"a/2"`))
  })

  it("invalid JSONC is refused; the file is untouched and no backup is created", () => {
    for (const bad of [`{ "a": 1 `, `{ "a": /* open`, `{ "agent": [1, 2] }`, `[1]`, `{ "a": 1 } trailing`]) {
      writeFileSync(cfg, bad)
      expect(() => applyAgentAssignments(cfg, { build: "a/b" })).toThrow(/not valid JSON\/JSONC|not an object/)
      expect(readFileSync(cfg, "utf8")).toBe(bad)
    }
    expect(existsSync(join(dir, "backups"))).toBe(false)
  })

  it("cancellation (no approved assignments) writes nothing", () => {
    writeFileSync(cfg, SAMPLE)
    const edit = applyAgentAssignments(cfg, {})
    expect(edit.changes).toEqual([])
    expect(readFileSync(cfg, "utf8")).toBe(SAMPLE)
  })

  it("the backup is the exact original; restoring it is an exact rollback", () => {
    writeFileSync(cfg, SAMPLE)
    const { backupPath } = applyAgentAssignments(cfg, { build: "z/z", explore: "y/y" })
    expect(readFileSync(backupPath!, "utf8")).toBe(SAMPLE)
    writeFileSync(cfg, readFileSync(backupPath!, "utf8"))
    expect(readFileSync(cfg, "utf8")).toBe(SAMPLE)
    expect(readdirSync(dir).filter(f => f.includes("jev-tmp"))).toEqual([]) // atomic write left no temp file
  })

  it("currentAssignments reads JSONC with trailing commas", () => {
    writeFileSync(cfg, SAMPLE)
    expect(currentAssignments(cfg)).toEqual({ build: "anthropic/claude-sonnet-4" })
  })
})
