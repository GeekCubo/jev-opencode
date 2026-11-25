import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

export { estimateTokens } from "./upstream/state.ts"

const SECRET_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\b(authorization|proxy-authorization)\s*[:=]\s*("[^"]*"|'[^']*'|[^\s,;]+(\s+[^\s,;]+)?)/gi,
  /\bbearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\b(sk|pk|rk)-(live|test|proj|ant)?-?[A-Za-z0-9_-]{16,}/g,
  /\b(ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}/g,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{30,}/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:[^\s@/]+@/gi,
  /\b([A-Z0-9_]*(KEY|TOKEN|SECRET|PASSWORD|PASSWD|PWD|CREDENTIAL|PRIVATE)[A-Z0-9_]*)\s*[:=]\s*("[^"]*"|'[^']*'|[^\s,;]+)/gi,
  /("?(api_?key|apikey|token|secret|password|passwd|access_token|refresh_token|client_secret)"?\s*:\s*)"[^"]*"/gi,
]

/** Best-effort secret redaction for text leaving the machine. Never mutates session data. */
export function redact(text: string): string {
  let out = text
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, (match, ...groups) => {
      const first = groups[0]
      if (typeof first === "string" && /^"?(api_?key|apikey|token|secret|password|passwd|access_token|refresh_token|client_secret)"?\s*:\s*$/i.test(first))
        return `${first}"[REDACTED]"`
      if (typeof first === "string" && match.startsWith(first) && /[:=]/.test(match.slice(first.length, first.length + 3)))
        return `${first}=[REDACTED]`
      return "[REDACTED]"
    })
  }
  return out
}

/** Deep-redacts every string inside a JSON value. */
export function redactValue<T>(value: T): T {
  if (typeof value === "string") return redact(value) as T
  if (Array.isArray(value)) return value.map(redactValue) as T
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) out[k] = redactValue(v)
    return out as T
  }
  return value
}

export function hash(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16)
}

export function errorMessage(error: unknown): string {
  return redact(error instanceof Error ? error.message : String(error)).slice(0, 300)
}

export const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms)
    signal?.addEventListener("abort", () => (clearTimeout(t), reject(new Error("aborted"))), { once: true })
  })

/** OpenCode config directory (honours XDG_CONFIG_HOME like OpenCode itself). */
export function configDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "opencode")
}

/** Default location of the counters-only statistics snapshot (honours XDG_STATE_HOME). */
export function statsSnapshotPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.JEV_STATS_FILE || join(env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "opencode-jev", "stats.json")
}

/** This plugin's version, from its own package.json ("unknown" if unreadable). */
export const PLUGIN_VERSION: string = (() => {
  try {
    return String(JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")).version ?? "unknown")
  } catch {
    return "unknown"
  }
})()

/** Shared accounting file (honours XDG_STATE_HOME); override with JEV_LEDGER_FILE. */
export function ledgerPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.JEV_LEDGER_FILE || join(env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "opencode-jev", "ledger.json")
}
