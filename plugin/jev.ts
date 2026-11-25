import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { buildJevRequest, parseJevResponse } from "./upstream/request.ts"
import type { JevAsker, JevQuestions, JevResponse, JevState } from "./upstream/types.ts"
import type { Endpoint } from "./config.ts"
import { configDir, redactValue, sleep } from "./util.ts"

export class JevHttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
  }
}

export interface JevUsage {
  requests: number
  inputTokens: number
  /** Measured from response `usage.input_tokens`; falls back to the estimate when absent. */
  measuredInputTokens: number
  estimatedInputTokens: number
  retries: number
  rateLimited: number
}

export interface JevClientOptions {
  url: string
  model: string
  apiKey: string
  timeoutMs: number
  maxRetries: number
  fetch?: typeof fetch
  /** Called before each attempt with the estimated request tokens; throw to refuse (budget). */
  beforeRequest?: (estimatedTokens: number) => void
  /** Called after every attempt that passed `beforeRequest`, whatever its outcome (releases reservations). */
  afterRequest?: (estimatedTokens: number) => void
  onUsage?: (u: { inputTokens: number; measured: boolean }) => void
  random?: () => number
}

const RETRYABLE = new Set([408, 429, 500, 502, 503, 504, 529])

/** Upstream request/response format, with redaction, timeouts, bounded retries and usage accounting. */
export function createJevClient(opts: JevClientOptions, estimate: (body: string) => number): JevAsker & { usage: JevUsage } {
  const fetcher = opts.fetch ?? fetch
  const usage: JevUsage = { requests: 0, inputTokens: 0, measuredInputTokens: 0, estimatedInputTokens: 0, retries: 0, rateLimited: 0 }
  return {
    usage,
    async ask(state: JevState, questions: JevQuestions): Promise<JevResponse> {
      const request = buildJevRequest({ apiKey: opts.apiKey, model: opts.model, baseUrl: opts.url }, redactValue(state), questions)
      const estimated = estimate(request.body)
      let lastError: unknown
      for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
        opts.beforeRequest?.(estimated)
        let released = false
        const release = () => {
          if (!released) (released = true), opts.afterRequest?.(estimated)
        }
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), opts.timeoutMs)
        let retryAfterMs: number | undefined
        try {
          usage.requests++
          const response = await fetcher(request.url, { method: "POST", headers: request.headers, body: request.body, signal: controller.signal })
          const text = await response.text()
          if (!response.ok) {
            if (response.status === 429) usage.rateLimited++
            const ra = Number(response.headers?.get?.("retry-after"))
            if (Number.isFinite(ra) && ra >= 0) retryAfterMs = Math.min(ra * 1000, 30_000)
            // Failed requests are not billed by TypeSafe for 4xx; count nothing.
            throw new JevHttpError(response.status, `Jev HTTP ${response.status}`)
          }
          const parsed = parseJevResponse(response.status, true, text)
          const measured = typeof parsed.usage?.input_tokens === "number"
          const tokens = measured ? parsed.usage!.input_tokens! : estimated
          release()
          usage.inputTokens += tokens
          if (measured) usage.measuredInputTokens += tokens
          else usage.estimatedInputTokens += tokens
          opts.onUsage?.({ inputTokens: tokens, measured })
          return parsed
        } catch (error) {
          lastError = controller.signal.aborted ? new Error(`Jev request timed out after ${opts.timeoutMs}ms`) : error
          const retryable = controller.signal.aborted || (error instanceof JevHttpError ? RETRYABLE.has(error.status) : error instanceof TypeError)
          if (!retryable || attempt === opts.maxRetries) break
          usage.retries++
          const backoff = retryAfterMs ?? Math.min(500 * 2 ** attempt, 8_000) * (0.5 + (opts.random ?? Math.random)())
          await sleep(backoff)
        } finally {
          clearTimeout(timer)
          release()
        }
      }
      throw lastError instanceof Error ? lastError : new Error(String(lastError))
    },
  }
}

export interface CredentialSources {
  env: NodeJS.ProcessEnv
  /** OpenCode's stored OpenCode Zen credential, when available. */
  opencodeCredential?: () => Promise<string | undefined>
  readFile?: (path: string) => Promise<string>
  configDir?: string
}

/**
 * Resolves the API key without ever putting it in config or logs:
 * TypeSafe: TYPESAFE_API_KEY, then ~/.config/opencode/typesafe-api-key (mode 600 recommended).
 * OpenCode Zen: OPENCODE_API_KEY, then the stored `opencode` integration credential, then ~/.config/opencode/opencode-zen-api-key.
 */
export async function resolveApiKey(endpoint: Endpoint, src: CredentialSources): Promise<string | undefined> {
  const dir = src.configDir ?? configDir(src.env)
  const read = src.readFile ?? ((p: string) => readFile(p, "utf8"))
  const fromFile = async (name: string) => {
    try {
      const v = (await read(join(dir, name))).trim()
      return v || undefined
    } catch {
      return undefined
    }
  }
  if (endpoint === "typesafe") return src.env.TYPESAFE_API_KEY?.trim() || (await fromFile("typesafe-api-key"))
  return (
    src.env.OPENCODE_API_KEY?.trim() ||
    (await src.opencodeCredential?.().catch(() => undefined)) ||
    (await fromFile("opencode-zen-api-key"))
  )
}
