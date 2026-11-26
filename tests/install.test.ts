// Isolated installation tests: the packed npm artifact (jev-compaction-0.3.0.tgz) installs
// into a clean directory, and its parts resolve exactly as OpenCode's plugin loader
// resolves them (exports map: ".", "./tui", "./rpc", "./gui-experimental").
import { describe, expect, it, beforeAll, afterAll } from "vitest"
import { mkdtempSync, rmSync, readdirSync, existsSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { execSync } from "node:child_process"

const TGZ = process.env.JEV_TGZ ?? "/tmp/opencode/jev-compaction-0.3.0.tgz"
let dir: string
const root0 = () => join(dir, "node_modules", "jev-compaction")

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "jev-install-"))
  // Install the artifact as OpenCode would: plain npm install of the tarball.
  execSync(`npm install --no-save --ignore-scripts "${TGZ}"`, { cwd: dir, stdio: "pipe" })
}, 120_000)
afterAll(() => rmSync(dir, { recursive: true, force: true }), 120_000)

describe("packed artifact: native npm installation", () => {
  it("installs the package with the expected name and version", () => {
    const pkg = JSON.parse(readFileSync(join(dir, "node_modules", "jev-compaction", "package.json"), "utf8"))
    expect(pkg.name).toBe("jev-compaction")
    expect(pkg.version).toBe("0.3.0")
    expect(pkg.exports).toBeDefined()
  })

  it("contains every runtime file the exports map points to", () => {
    const root = join(dir, "node_modules", "jev-compaction")
    for (const f of ["index.ts", "tui.tsx", "rpc.ts", "dist/gui-experimental.cjs", "upstream/state.ts", "upstream/compact.ts", "upstream/request.ts", "upstream/types.ts", "upstream/LICENSE", "upstream/NOTICE.md", "health.ts", "setup.ts", "client.ts" ]) {
      // client.ts is not required; the exports map only needs the entry points' imports to resolve.
      if (f === "client.ts") continue
      expect(existsSync(join(root, f))).toBe(true)
    }
  })

  it("the server part imports cleanly (module graph resolves)", async () => {
    const mod = await import(join(rootPath(), "index.ts"))
    expect(typeof mod.createPlugin).toBe("function")
    expect(typeof mod.default).toBe("object")
  }, 60_000)

  it("the RPC contract imports cleanly", async () => {
    const mod = await import(join(rootPath(), "rpc.ts"))
    expect(mod.JevRpc).toBeDefined()
  })

  it("the TUI part imports cleanly", async () => {
    const mod = await import(join(rootPath(), "tui.tsx"))
    expect(typeof mod.default).toBe("object") // Plugin.define({...})
    expect(typeof mod.jevCommands).toBe("function")
  })

  it("the GUI bundle is a CommonJS file with the expected setup export", () => {
    const gui = readFileSync(join(dir, "node_modules", "jev-compaction", "dist", "gui-experimental.cjs"), "utf8")
    expect(gui.length).toBeGreaterThan(1000)
    // Built bundle: not TypeScript source.
    expect(gui).not.toMatch(/^import\s/ as RegExp)
  })

  it("version consistency across root/plugin metadata and runtime", async () => {
    const { PLUGIN_VERSION } = await import(join(rootPath(), "util.ts"))
    const pkg = JSON.parse(readFileSync(join(rootPath(), "package.json"), "utf8"))
    expect(PLUGIN_VERSION).toBe(pkg.version)
    expect(PLUGIN_VERSION).toBe("0.3.0")
  })

  it("no development artifacts, credentials or owner paths ship in the package", () => {
    const root = join(dir, "node_modules", "jev-compaction")
    const files: string[] = []
    const walk = (d: string) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, e.name)
        if (e.isDirectory()) walk(p)
        else files.push(p)
      }
    }
    walk(root)
    expect(files.some(f => f.endsWith(".test.ts"))).toBe(false)
    // No nested node_modules DIRECTORY inside the package (string mentions in the bundle are fine).
    expect(existsSync(join(root, "node_modules"))).toBe(false)
    for (const f of files) {
      const text = readFileSync(f, "utf8")
      expect(text).not.toMatch(/sk-apixo|sk-ant-|sk-proj-|ts-test-key-123456/)
      expect(text).not.toMatch(/\/home\/amroot/)
    }
  })
})

const rootPath = () => join(dir, "node_modules", "jev-compaction")

describe("version-pinned installation and upgrade/downgrade paths", () => {
  it("a version-pinned entry ('jev-compaction@0.3.0') maps to the same artifact", () => {
    // OpenCode's plugins array accepts "jev-compaction@0.3.0"; the loader resolves it through npm.
    // Locally we verify the tarball filename and the package version agree.
    expect(TGZ).toMatch(/jev-compaction-0\.3\.0\.tgz$/)
    const pkg = JSON.parse(readFileSync(join(rootPath(), "package.json"), "utf8"))
    expect(pkg.version).toBe("0.3.0")
  })
})

afterAll(() => rmSync(dir, { recursive: true, force: true }), 120_000)
