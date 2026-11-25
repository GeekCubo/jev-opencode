/**
 * Jev compaction for OpenCode 2.x (server plugin). Port of fast-jev-compaction
 * (https://github.com/tamaratran/fast-jev-compaction, MIT). Compaction only: no model routing.
 *
 * Hooks used (all officially documented for @opencode/plugin 2.2.x):
 * - session.hook("context")    prunes stale tool calls/results in the OUTGOING request only.
 * - session.hook("compaction") applies already-made decisions to native summary input (active mode).
 * - agent.transform            optional, explicitly configured fallback model for the `compaction` agent only.
 * - rpc.register               JevRpc: commands + `snapshot` + `changed` event for the TUI and Desktop GUI parts.
 * - command.transform          only with option serverCommands=true (headless); interactive commands live in tui.tsx/gui.tsx.
 * - event.subscribe            measured token/cost/cache usage and native compaction observations.
 */
import type { Plugin } from "@opencode/plugin"
import { ConfigError, endpointUrl, wireModel, priceFor, resolveConfig, thresholdFor, type JevConfig, type Mode } from "./config.ts"
import { createJevClient, resolveApiKey } from "./jev.ts"
import { prune, type OcMessage, type OcPart } from "./compaction.ts"
import { add, emptyCounters, formatStats, Ledger, type Counters } from "./statistics.ts"
import { JevRpc, type JevSnapshot } from "./rpc.ts"
import { errorMessage, estimateTokens, hash, statsSnapshotPath } from "./util.ts"
import { mkdir, writeFile } from "node:fs/promises"
import { dirname } from "node:path"

export const STATUS_SOURCE = "jev-compaction"
export const STATUS_MARKER = "[jev-compaction status]"

interface Decisions {
  drop: Set<string>
  truncate: Map<string, string>
  /** Every tool_use id Jev has answered about (kept, truncated or dropped). */
  evaluated: Set<string>
}

interface SessionState {
  decisions?: Decisions
  /** Estimated context tokens when Jev last ran. */
  lastRunTokens: number
  lastRunAt: number
  /** Hash of the tool-call ids present at the last run; identical context is never re-evaluated. */
  lastFingerprint?: string
  inflight?: Promise<void>
  force: boolean
  spentUSD: number
  counters: Counters
  pruneChangedAt: number
  awaitingCacheObservation: boolean
  lastEvaluationAt?: number
  budgetBlocked?: boolean
}

export interface Deps {
  fetch?: typeof fetch
  env?: NodeJS.ProcessEnv
  now?: () => number
  readFile?: (path: string) => Promise<string>
  configDir?: string
  snapshotPath?: string
}

const charsOf = (messages: readonly OcMessage[]) => {
  let n = 0
  for (const m of messages)
    for (const p of m.content) {
      if (p.type === "text" || p.type === "reasoning") n += String(p.text ?? "").length
      else if (p.type === "tool-call") n += safeLen(p.input)
      else if (p.type === "tool-result") n += safeLen((p.result as any)?.value)
    }
  return n
}
const safeLen = (v: unknown) => {
  if (typeof v === "string") return v.length
  try {
    return JSON.stringify(v)?.length ?? 0
  } catch {
    return 0
  }
}
/** Fast context estimate (~3.6 chars/token); used for thresholds. Precise per-run figures use the upstream estimator. */
export const estimateContextTokens = (messages: readonly OcMessage[]) => Math.ceil(charsOf(messages) / 3.6)

const rebuildMessage = <M extends OcMessage>(original: M, content: OcPart[]): M => {
  const Ctor = (original as any).constructor
  const plain = { ...original, content }
  try {
    return Ctor && Ctor !== Object ? new Ctor(plain) : (plain as M)
  } catch {
    return plain as M
  }
}

/** Applies cached decisions; deterministic so the pruned prefix stays identical across requests (cache-friendly). */
export function applyCached<M extends OcMessage>(messages: readonly M[], d: Decisions): { messages: M[]; changed: boolean } {
  let changed = false
  const out: M[] = []
  for (const m of messages) {
    if (m.role === "system") {
      out.push(m)
      continue
    }
    let touched = false
    const content: OcPart[] = []
    for (const p of m.content) {
      if (p.type !== "tool-call" && p.type !== "tool-result") {
        content.push(p)
        continue
      }
      const id = String(p.id)
      if (d.drop.has(id)) {
        touched = true
        continue
      }
      const t = p.type === "tool-result" ? d.truncate.get(id) : undefined
      if (t !== undefined) {
        touched = true
        content.push({ ...p, result: { type: (p.result as any)?.type === "error" ? "error" : "text", value: t } })
        continue
      }
      content.push(p)
    }
    if (!touched) out.push(m)
    else if (content.length) out.push(rebuildMessage(m, content))
    changed ||= touched
  }
  // Integrity: never send a result whose call is missing (or a call whose result is missing).
  const calls = new Set<string>(), results = new Set<string>()
  for (const m of out) for (const p of m.content) {
    if (p.type === "tool-call" && p.providerExecuted !== true) calls.add(String(p.id))
    if (p.type === "tool-result") results.add(String(p.id))
  }
  for (const id of results) if (!calls.has(id)) return { messages: [...messages], changed: false }
  return { messages: out, changed }
}

const isStatusMessage = (m: OcMessage) =>
  m.role === "user" && m.content.length > 0 && m.content.every((p) => p.type === "text") &&
  ((m as any).metadata?.source === STATUS_SOURCE || String(m.content[0]!.text ?? "").startsWith(STATUS_MARKER))

/** Plugin APIs Jev needs. Optional ones (RPC, commands, events, agent transform) degrade individually. */
export function missingCapabilities(ctx: any): string[] {
  const missing: string[] = []
  if (typeof ctx?.session?.hook !== "function") missing.push("session.hook")
  if (typeof ctx?.storage?.get !== "function" || typeof ctx?.storage?.set !== "function") missing.push("storage")
  if (typeof ctx?.model?.list !== "function") missing.push("model.list")
  return missing
}

export function createPlugin(deps: Deps = {}): Plugin.Plugin {
  return {
    id: "jev-compaction",
    async setup(ctx) {
      const now = deps.now ?? Date.now
      const log = (level: "info" | "warn", msg: string) => (level === "warn" ? console.warn : console.info)(`[jev] ${msg}`)
      // Capability detection (not version checks): without the documented session `context` hook Jev cannot
      // prune safely, so it stays inert and OpenCode keeps its native behaviour.
      const missing = missingCapabilities(ctx)
      if (missing.length) {
        log("warn", `incompatible OpenCode ${(ctx as any).app?.version ?? "(unknown version)"}: missing ${missing.join(", ")}; Jev disabled, native behaviour unchanged`)
        return
      }
      let config: JevConfig
      try {
        config = resolveConfig(ctx.options as Record<string, unknown>)
      } catch (e) {
        log("warn", `disabled: ${errorMessage(e)}`)
        return
      }
      let priceError: string | undefined
      let price = 0
      try {
        price = priceFor(config)
      } catch (e) {
        priceError = errorMessage(e)
        log("warn", `Jev requests blocked: ${priceError}`)
      }

      const stored = (await ctx.storage.get("mode").catch(() => undefined)) as Mode | undefined
      // A mode chosen by command persists, except that an explicit "off" in config always wins (kill switch).
      let mode: Mode = config.mode === "off" ? "off" : stored && ["off", "dry-run", "active"].includes(stored) ? stored : config.mode
      let unavailableReason: string | undefined
      // Shared, read-modify-write accounting: several instances (one per project location) share this storage.
      const ledger = new Ledger(ctx.storage as any)
      const day = () => new Date(now()).toISOString().slice(0, 10)
      const dayKey = () => Ledger.dayKey(day())
      await ledger.total(dayKey())
      const sessions = new Map<string, SessionState>()
      let emitChanged: (sessionID?: string) => void = () => {}
      const session = (id: string): SessionState => {
        let s = sessions.get(id)
        if (!s) sessions.set(id, (s = { lastRunTokens: 0, lastRunAt: 0, force: false, spentUSD: 0, counters: emptyCounters(), pruneChangedAt: 0, awaitingCacheObservation: false }))
        return s
      }
      const bump = (s: SessionState, delta: Partial<Counters>) => (add(s.counters, delta), ledger.addCounters(delta))
      let persistTimer: ReturnType<typeof setTimeout> | undefined
      const persist = () => {
        persistTimer ??= setTimeout(() => {
          persistTimer = undefined
          void ledger.flush().then(writeSnapshot)
        }, 2_000)
      }
      // Status snapshot for `jev-stats` CLI (no transcript content, no credentials).
      const snapshotPath = deps.snapshotPath ?? statsSnapshotPath(deps.env ?? process.env)
      const writeSnapshot = async () => {
        try {
          await mkdir(dirname(snapshotPath), { recursive: true, mode: 0o700 })
          const data = {
            updatedAt: new Date(now()).toISOString(),
            mode,
            endpoint: config.endpoint,
            model: config.model,
            pricePerMTok: price,
            budget: config.budget,
            spentTodayUSD: ledger.cachedTotal(dayKey()),
            global: await ledger.counters(),
            sessions: Object.fromEntries([...sessions].map(([id, st]) => [id, { mode, spentUSD: st.spentUSD, pruned: st.decisions ? { dropped: st.decisions.drop.size, truncated: st.decisions.truncate.size } : null, counters: st.counters }])),
          }
          await writeFile(snapshotPath, JSON.stringify(data, null, 2), { mode: 0o600 })
        } catch {}
      }

      // Model metadata (context window + input price) for thresholds and savings estimates.
      let models: Map<string, { context?: number; input?: number }> | undefined
      let modelsAt = 0
      const modelInfo = async (ref: { providerID: string; id: string }) => {
        if (!models || now() - modelsAt > 300_000) {
          try {
            const list = await ctx.model.list()
            models = new Map(list.data.map((m: any) => [`${m.providerID}/${m.id}`, { context: m.limit?.context, input: m.cost?.[0]?.input }]))
            modelsAt = now()
          } catch {
            models ??= new Map()
          }
        }
        return models.get(`${ref.providerID}/${ref.id}`) ?? {}
      }

      let apiKey: string | undefined
      const getKey = async () =>
        (apiKey ??= await resolveApiKey(config.endpoint, {
          env: deps.env ?? process.env,
          readFile: deps.readFile,
          configDir: deps.configDir,
          opencodeCredential: async () => {
            const conn = await ctx.integration.connection.active("opencode")
            const cred: any = conn ? await ctx.integration.connection.resolve(conn) : undefined
            return cred?.type === "key" ? cred.key : undefined
          },
        }))

      // In-flight cost reservations (estimates), per instance.
      const reserved = { day: 0, session: new Map<SessionState, number>() }
      const sessionReserved = (s: SessionState) => reserved.session.get(s) ?? 0
      let globalInflight = 0
      const MAX_GLOBAL_CONCURRENCY = 2

      const runJev = async (sessionID: string, s: SessionState, messages: readonly OcMessage[], tokens: number, primaryInput?: number) => {
        if (priceError) throw new ConfigError(priceError)
        const key = await getKey()
        if (!key) throw new ConfigError(`no API key for ${config.endpoint}`)
        // Budget totals include spend by other instances and before any reload.
        let daySpent = await ledger.total(dayKey())
        s.spentUSD = Math.max(s.spentUSD, await ledger.total(Ledger.sessionKey(sessionID)))
        const started = now()
        const client = createJevClient(
          {
            url: endpointUrl(config),
            model: wireModel(config),
            apiKey: key,
            timeoutMs: config.timeoutMs,
            maxRetries: config.maxRetries,
            fetch: deps.fetch,
            // Parallel batches of one evaluation (and concurrent sessions) reserve their estimated cost up front,
            // so together they cannot overshoot the budget; the reservation is released when the attempt ends.
            beforeRequest: (est) => {
              const cost = (est * price) / 1e6
              if (s.spentUSD + sessionReserved(s) + cost > config.budget.perSessionUSD || daySpent + reserved.day + cost > config.budget.perDayUSD)
                throw new BudgetError("Jev budget exhausted")
              reserved.day += cost
              reserved.session.set(s, sessionReserved(s) + cost)
            },
            afterRequest: (est) => {
              const cost = (est * price) / 1e6
              reserved.day = Math.max(0, reserved.day - cost)
              reserved.session.set(s, Math.max(0, sessionReserved(s) - cost))
            },
            onUsage: ({ inputTokens, measured }) => {
              const cost = (inputTokens * price) / 1e6
              s.spentUSD += cost
              daySpent += cost
              ledger.addSpend([dayKey(), Ledger.sessionKey(sessionID)], cost)
              bump(s, { jevRequests: 1, jevCostUSD: cost, ...(measured ? { jevInputTokensMeasured: inputTokens } : { jevInputTokensEstimated: inputTokens }) })
            },
          },
          estimateTokens,
        )
        try {
          const out = await prune(messages, client, {
            keepThreshold: config.keepThreshold,
            preserveRecentMessages: config.preserveRecentMessages,
            truncateHeadChars: config.truncateHeadChars,
            maxStateTokens: config.maxStateTokens,
            maxRequestTokens: config.maxRequestTokens,
            protection: { protectTools: config.protectTools.map((p) => new RegExp(p, "i")), keepErrorsWithinMessages: 20, alreadyDecided: s.decisions?.evaluated },
          }, rebuildMessage)
          const st = out.result.stats
          const after = estimateContextTokens(out.messages)
          bump(s, {
            runs: 1,
            durationMsTotal: now() - started,
            callsKept: st.kept,
            callsPinned: st.pinned,
            resultsTruncated: st.resultsDropped,
            callsDropped: st.callsDropped,
            contextTokensBefore: tokens,
            contextTokensAfter: after,
            rateLimited: client.usage.rateLimited,
          })
          if (config.logDecisions)
            log("info", `session ${sessionID}: ${out.result.decisions.filter((d) => d.reason !== "pinned").map((d) => `${d.id}:${d.tool}:${d.action}`).join(" ")}`)
          const evaluated = new Set(s.decisions?.evaluated ?? [])
          const askedIds = new Set(out.result.decisions.filter((d) => d.reason !== "pinned").map((d) => d.id))
          for (const c of out.calls) if (askedIds.has(c.id)) evaluated.add(c.tool_use_id)
          const sufficient = out.ratio >= config.minReductionRatio
          if (mode === "dry-run") {
            // Record what was evaluated so dry-run never pays twice for the same calls; nothing is applied.
            s.decisions = { drop: new Set(), truncate: new Map(), evaluated }
            bump(s, { dryRuns: 1, ...(sufficient ? {} : { skippedInsufficient: 1 }) })
            log("info", `dry-run session ${sessionID}: ~${tokens} → ~${after} tokens (${(out.ratio * 100).toFixed(1)}% chars), ${st.requests} Jev request(s), not applied`)
            return
          }
          if (!sufficient) {
            // Remember what was asked so unchanged calls are not paid for again.
            s.decisions = { drop: new Set(s.decisions?.drop ?? []), truncate: new Map(s.decisions?.truncate ?? []), evaluated }
            bump(s, { skippedInsufficient: 1, ...(config.nativeFallback ? { nativeFallbacks: 1 } : {}) })
            log("info", `session ${sessionID}: reduction ${(out.ratio * 100).toFixed(1)}% below ${config.minReductionRatio * 100}%; native compaction remains in charge`)
            return
          }
          const originalParts = new Set(messages.flatMap((m) => m.content))
          const drop = new Set<string>()
          const truncate = new Map<string, string>()
          const byShort = new Map(out.calls.map((c) => [c.id, c]))
          for (const d of out.result.decisions) {
            const call = byShort.get(d.id)
            if (!call) continue
            if (d.action === "drop_call") drop.add(call.tool_use_id)
            if (d.action === "drop_result") {
              for (const m of out.messages)
                for (const p of m.content)
                  if (p.type === "tool-result" && String(p.id) === call.tool_use_id && !originalParts.has(p))
                    truncate.set(call.tool_use_id, String((p.result as any)?.value ?? ""))
            }
          }
          // Merge with earlier decisions: once pruned, stays pruned (stable prefix, fewer cache invalidations).
          for (const id of s.decisions?.drop ?? []) drop.add(id)
          for (const [id, v] of s.decisions?.truncate ?? []) if (!drop.has(id) && !truncate.has(id)) truncate.set(id, v)
          s.decisions = { drop, truncate, evaluated }
          s.pruneChangedAt = now()
          s.awaitingCacheObservation = true
          bump(s, { appliedRuns: 1 })
          void primaryInput
        } catch (e) {
          if (e instanceof BudgetError) (bump(s, { budgetBlocked: 1 }), (s.budgetBlocked = true))
          else bump(s, { failures: 1, rateLimited: client.usage.rateLimited, ...(config.nativeFallback ? { nativeFallbacks: 1 } : {}) })
          log("warn", `session ${sessionID}: Jev skipped (${errorMessage(e)}); request sent unpruned`)
        } finally {
          s.lastRunTokens = tokens
          s.lastRunAt = now()
          s.lastEvaluationAt = now()
          persist()
          emitChanged(sessionID)
        }
      }

      const onContext = async (event: { sessionID: string; model: { providerID: string; id: string }; messages: OcMessage[] }) => {
        // Plugin status messages are shown to the user but never sent to any model.
        if (event.messages.some(isStatusMessage)) event.messages = event.messages.filter((m) => !isStatusMessage(m))
        if (mode === "off") return
        const s = session(event.sessionID)
        // Thresholds and Jev state are based on what is actually sent (cached decisions applied).
        const current = mode === "active" && s.decisions ? applyCached(event.messages, s.decisions).messages : event.messages
        const tokens = estimateContextTokens(current)
        const info = await modelInfo(event.model)
        const threshold = thresholdFor(config, info.context)
        const fingerprint = hash(current.flatMap((m) => m.content.filter((p) => p.type === "tool-call").map((p) => String(p.id))).join(","))
        const due =
          s.force ||
          (fingerprint !== s.lastFingerprint &&
          (tokens >= threshold &&
            tokens - s.lastRunTokens >= config.minGrowthTokens &&
            now() - s.lastRunAt >= config.cooldownMs))
        if (due && !s.inflight && globalInflight < MAX_GLOBAL_CONCURRENCY && !priceError) {
          s.force = false
          s.lastFingerprint = fingerprint
          globalInflight++
          emitChanged(event.sessionID)
          s.inflight = runJev(event.sessionID, s, current, tokens, info.input).finally(() => {
            globalInflight--
            s.inflight = undefined
          })
          await s.inflight
        }
        if (mode !== "active" || !s.decisions) return
        const before = estimateContextTokens(event.messages)
        const applied = applyCached(event.messages, s.decisions)
        if (!applied.changed) return
        event.messages = applied.messages
        const removed = Math.max(0, before - estimateContextTokens(applied.messages))
        bump(s, { requestsPruned: 1, tokensRemovedFromRequests: removed, estimatedSavingsUSD: info.input ? (removed * info.input) / 1e6 : 0 })
        persist()
      }

      // Required hook: if registration fails, Jev stays inert and OpenCode keeps its native behaviour.
      try {
        await ctx.session.hook("context", onContext as any)
      } catch (e) {
        log("warn", `context hook unavailable (${errorMessage(e)}); Jev disabled, native behaviour unchanged`)
        mode = "off"
        unavailableReason = "context hook unavailable"
      }
      // Optional hooks degrade individually.
      const optional = async (name: string, register: () => Promise<unknown>) => {
        try {
          await register()
        } catch (e) {
          log("warn", `optional ${name} unavailable (${errorMessage(e)}); continuing without it`)
        }
      }
      await optional("compaction hook", () => ctx.session.hook("compaction", (async (event: { sessionID: string; messages: OcMessage[] }) => {
        if (event.messages.some(isStatusMessage)) event.messages = event.messages.filter((m) => !isStatusMessage(m))
        const s = sessions.get(event.sessionID)
        if (mode !== "active" || !s?.decisions) return
        event.messages = applyCached(event.messages, s.decisions).messages
      }) as any))
      await optional("generate hook", () => ctx.session.hook("generate", ((event: { messages: OcMessage[] }) => {
        if (event.messages.some(isStatusMessage)) event.messages = event.messages.filter((m) => !isStatusMessage(m))
      }) as any))

      // Optional fallback model for native summary compaction ONLY. Applied via the documented agent
      // transform, which OpenCode replays on every agent registry rebuild, so it cannot be "lost".
      const fallback = typeof (ctx.options as any).fallbackCompactionModel === "string" ? String((ctx.options as any).fallbackCompactionModel) : undefined
      let fallbackRef: { providerID: string; id: string } | undefined
      if (fallback) {
        const [providerID, ...rest] = fallback.split("/")
        const id = rest.join("/")
        if (!providerID || !id) log("warn", `fallbackCompactionModel must be provider/model; ignoring`)
        else {
          fallbackRef = { providerID, id }
          // Documented agent transform: replayed on every agent-registry rebuild, so it persists.
          // Only the hidden `compaction` agent is touched.
          await optional("agent transform", () => ctx.agent.transform((editor) => {
            editor.update("compaction", (agent: any) => {
              agent.model = { providerID, id }
            })
          }))
          // OpenCode falls back to the session model if this model cannot be resolved (documented);
          // we additionally warn once providers have loaded.
          setTimeout(() => {
            void ctx.model.list().then((l: any) => {
              if (!l.data.some((m: any) => m.providerID === providerID && m.id === id))
                log("warn", `fallbackCompactionModel ${fallback} is not available; OpenCode will use the session model for summaries`)
            }).catch(() => {})
          }, 5_000).unref?.()
        }
      }

      // Measured usage from OpenCode events.
      const controller = new AbortController()
      void (async () => {
        try {
          for await (const ev of ctx.event.subscribe({ types: ["session.step.ended", "session.compaction.ended"], signal: controller.signal }) as AsyncIterable<any>) {
            const s = sessions.get(ev.data?.sessionID)
            if (ev.type === "session.compaction.ended") {
              if (s) (bump(s, { nativeCompactions: 1 }), (s.lastRunTokens = 0), (s.decisions = undefined))
              else ledger.addCounters({ nativeCompactions: 1 })
              continue
            }
            const t = ev.data?.tokens
            if (!s || !t) continue
            bump(s, { primarySteps: 1, primaryCostUSD: Number(ev.data.cost) || 0, primaryInputTokens: t.input ?? 0, cacheReadTokens: t.cache?.read ?? 0, cacheWriteTokens: t.cache?.write ?? 0 })
            if (s.awaitingCacheObservation) (bump(s, { cacheWriteAfterPruneChange: t.cache?.write ?? 0 }), (s.awaitingCacheObservation = false))
            persist()
          }
        } catch {
          // stream closed on unload
        }
      })()

      const setMode = async (next: Mode) => {
        mode = next
        await ctx.storage.set("mode", next)
        persist()
        emitChanged()
      }
      const noSession = "No session yet: open or start a session first (this command acts on the current session)."
      const statusText = async (sessionID?: string) => {
        const s = sessionID ? sessions.get(sessionID) : undefined
        const daySpent = await ledger.total(dayKey())
        const sessionSpent = sessionID ? Math.max(s?.spentUSD ?? 0, await ledger.total(Ledger.sessionKey(sessionID))) : 0
        return [
          `mode=${mode} (applies to all sessions on this OpenCode server; persisted)`,
          `endpoint=${config.endpoint}, model=${config.model} ($${price}/Mtok input)${priceError ? `; BLOCKED: ${priceError}` : ""}`,
          `threshold=min(${config.compactAtTokens}, ${config.compactAtContextFraction}×window) tokens, keepThreshold=${config.keepThreshold}, minReduction=${config.minReductionRatio}`,
          `budget: ${sessionID ? `session $${sessionSpent.toFixed(5)}/${config.budget.perSessionUSD}, ` : ""}today $${daySpent.toFixed(5)}/${config.budget.perDayUSD}`,
          sessionID
            ? `this session: ${s?.decisions && (s.decisions.drop.size || s.decisions.truncate.size) ? `${s.decisions.drop.size} dropped, ${s.decisions.truncate.size} truncated` : "no active pruning"}; last run at ~${s?.lastRunTokens ?? 0} tokens`
            : "no session selected",
          `native compaction: ${fallbackRef ? `summaries use ${fallback} (compaction agent only)` : "unchanged (OpenCode default)"}`,
        ].join("\n")
      }

      /** Structured state for status indicators (TUI sidebar/footer, Desktop pill). In-memory only. */
      const snapshot = async (sessionID?: string): Promise<JevSnapshot> => {
        const s = sessionID ? sessions.get(sessionID) : undefined
        const daySpent = await ledger.total(dayKey())
        const overDay = daySpent >= config.budget.perDayUSD
        const overSession = !!s && s.spentUSD >= config.budget.perSessionUSD
        const state: JevSnapshot["state"] =
          unavailableReason ? "unavailable" : mode === "off" ? "off" : priceError ? "unavailable" : s?.inflight ? "evaluating" : overDay || overSession ? "budget" : mode
        const c = s?.counters
        return {
          state,
          mode,
          reason: unavailableReason ?? priceError ?? (config.mode === "off" ? "disabled in config" : null) ?? (overDay ? "daily budget reached" : overSession ? "session budget reached" : null),
          endpoint: config.endpoint,
          model: config.model,
          todayUSDEstimated: daySpent,
          perDayUSD: config.budget.perDayUSD,
          perSessionUSD: config.budget.perSessionUSD,
          session: s && c
            ? {
                evaluations: c.runs,
                tokensRemovedEstimated: Math.max(0, c.contextTokensBefore - c.contextTokensAfter),
                reductionPctEstimated: c.contextTokensBefore > 0 ? Math.round((1 - c.contextTokensAfter / c.contextTokensBefore) * 1000) / 10 : 0,
                jevTokensMeasured: c.jevInputTokensMeasured,
                costUSDEstimated: s.spentUSD,
                pruned: { dropped: s.decisions?.drop.size ?? 0, truncated: s.decisions?.truncate.size ?? 0 },
                lastEvaluationAt: s.lastEvaluationAt ? new Date(s.lastEvaluationAt).toISOString() : null,
                evaluating: !!s.inflight,
              }
            : null,
        }
      }

      /** Command actions: pure state changes returning user-facing text. Shared by RPC and slash commands. */
      const actions = {
        status: (sessionID?: string) => statusText(sessionID),
        stats: async (sessionID?: string) =>
          (sessionID ? `${formatStats("This session", sessions.get(sessionID)?.counters ?? emptyCounters())}\n` : "") + formatStats("All sessions (persisted)", await ledger.counters()),
        setMode: async (next: Mode) => {
          if (next !== "off" && unavailableReason) return `Not changed: Jev is unavailable (${unavailableReason}).`
          if (next !== "off" && config.mode === "off")
            return 'Not changed: Jev is disabled in opencode.jsonc ("mode": "off" or "enabled": false). Change the config to enable it.'
          await setMode(next)
          return next === "active" ? "Active: pruning outgoing requests in all sessions on this server." : next === "dry-run" ? "Dry-run: evaluating only; requests are not modified." : "Off: no Jev requests, no pruning."
        },
        reset: (sessionID?: string) => {
          if (!sessionID) return noSession
          const st = sessions.get(sessionID)
          const restored = st?.decisions ? st.decisions.drop.size + st.decisions.truncate.size : 0
          if (st) {
            // Keep `evaluated` so the restored calls are not immediately re-pruned or re-billed.
            st.decisions = st.decisions ? { drop: new Set(), truncate: new Map(), evaluated: st.decisions.evaluated } : undefined
            st.lastFingerprint = undefined
            st.force = false
            bump(st, { resets: 1 })
            persist()
            emitChanged(sessionID)
          }
          return `Restored ${restored} pruned tool call(s) for this session; they will not be re-pruned. Stored history is unchanged.`
        },
        compact: (sessionID?: string) => {
          if (!sessionID) return noSession
          if (mode === "off") return "Jev is off; enable it with /jev-enable or /jev-dry-run first."
          session(sessionID).force = true
          emitChanged(sessionID)
          return `Jev will evaluate this session on its next model request (mode=${mode}). No request is sent now.`
        },
      }

      // RPC powers the TUI/GUI commands and indicators; without it pruning still works and the CLI reader remains.
      const registration = typeof (ctx as any).rpc?.register !== "function"
        ? (log("warn", "plugin RPC unavailable in this OpenCode version; TUI/GUI commands disabled, pruning unaffected"), undefined)
        : await ctx.rpc.register(JevRpc, {
        snapshot: async (input: any) => (await snapshot(input?.sessionID)) as any,
        status: async (input: any) => ({ text: await actions.status(input?.sessionID) }),
        stats: async (input: any) => ({ text: await actions.stats(input?.sessionID) }),
        setMode: async (input: any) => ({ text: await actions.setMode(input.mode as Mode) }),
        reset: async (input: any) => ({ text: actions.reset(input.sessionID) }),
        compact: async (input: any) => ({ text: actions.compact(input.sessionID) }),
      })
      emitChanged = (sessionID?: string) =>
        void (registration as any)?.events?.emit?.("changed", sessionID ? { sessionID } : {})?.catch?.(() => {})

      // Server slash commands are registered only when the TUI part is not handling them
      // (option `serverCommands: true`, e.g. for API/headless use). Server command executors
      // cannot return output: OpenCode 2.2.7 shows any thrown message as a red failure, so they
      // succeed silently and the text is only available via RPC / the stats CLI.
      if ((ctx.options as any).serverCommands === true) {
        await ctx.command.transform((editor) => {
          const silent = (fn: () => unknown) => async () => void (await fn())
          editor.add({ name: "jev-status", description: "Jev compaction: status (headless; output via RPC)", execute: silent(() => persist()) })
          editor.add({ name: "jev-stats", description: "Jev compaction: stats (headless; output via RPC)", execute: silent(() => persist()) })
          editor.add({ name: "jev-compact", description: "Jev compaction: evaluate on next request", execute: async ({ sessionID }) => void actions.compact(sessionID) })
          editor.add({ name: "jev-reset", description: "Jev compaction: restore full context for this session", execute: async ({ sessionID }) => void actions.reset(sessionID) })
          editor.add({ name: "jev-dry-run", description: "Jev compaction: dry-run", execute: silent(() => actions.setMode("dry-run")) })
          editor.add({ name: "jev-enable", description: "Jev compaction: active", execute: silent(() => actions.setMode("active")) })
          editor.add({ name: "jev-disable", description: "Jev compaction: off", execute: silent(() => actions.setMode("off")) })
        })
      }

      return async () => {
        controller.abort()
        if (persistTimer) clearTimeout(persistTimer)
        await ledger.flush()
      }
    },
  }
}

class BudgetError extends Error {}

export default createPlugin()
