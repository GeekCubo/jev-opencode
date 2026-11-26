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
import { ConfigError, endpointUrl, exceeds, formatLimit, reached, wireModel, priceFor, resolveConfig, thresholdFor, type JevConfig, type Mode } from "./config.ts"
import { createJevClient, resolveApiKey } from "./jev.ts"
import { countCandidates, prune, type OcMessage, type OcPart } from "./compaction.ts"
import { add, emptyCounters, formatStats, type Counters } from "./statistics.ts"
import { FileLedger, reservedFor, session as session$ } from "./ledger-file.ts"
import { JevRpc, TRIGGER_LABEL, type JevSnapshot, type TriggerDiagnostics, type TriggerReason, type SessionHealthSnapshot } from "./rpc.ts"
import { assessHealth, healthThresholdsFromConfig, healthNotifyMessage, healthShouldNotify, newNotifyState, recordNotify, resetNotifyState, HEALTH_LABEL, type HealthInput, type HealthLevel, type HealthResult, type NotifyState } from "./health.ts"
import { catalog, currentAssignments, applyAgentAssignments, recommendAll, ROLE_LABEL, type Role } from "./setup.ts"
import { configDir } from "./util.ts"
import { errorMessage, estimateTokens, hash, ledgerPath, PLUGIN_VERSION, statsSnapshotPath } from "./util.ts"
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
  id: string
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
  /** Estimated tokens of the messages actually sent with the latest request. */
  sentEstimate?: number
  /** Provider-reported context of the latest step (input + cache read + cache write) and the estimate it corresponds to. */
  providerContext?: number
  providerBaseline?: number
  trigger?: TriggerDiagnostics
  /** Session health notification bookkeeping (in memory, per session). */
  notify?: NotifyState
  /** Consecutive evaluation failures / insufficient reductions (health signals). */
  consecutiveFailures: number
  consecutiveInsufficient: number
  /** The session's current model (provider + id), recorded on each context hook. */
  model?: { providerID: string; id: string }
  /** Jev evaluation-state tokens of the latest evaluation (bounded window included). */
  lastStateTokens?: number
}

export interface Deps {
  fetch?: typeof fetch
  env?: NodeJS.ProcessEnv
  now?: () => number
  readFile?: (path: string) => Promise<string>
  configDir?: string
  snapshotPath?: string
  /** Shared accounting file (default: $XDG_STATE_HOME/opencode-jev/ledger.json). */
  ledgerPath?: string
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
      // Shared accounting: one locked file for every plugin instance of this user (all projects, all processes).
      // Numbers only. Spend, reservations, per-session statistics and per-session mode overrides.
      const ledger = new FileLedger({ path: deps.ledgerPath ?? ledgerPath({ ...process.env, ...(deps.env ?? {}) }), now })
      const day = () => new Date(now()).toISOString().slice(0, 10)
      // One-time migration of the previous storage-based totals (never overwrites existing file values).
      try {
        const oldDay = Number(await ctx.storage.get(`spend/${day()}`).catch(() => 0)) || 0
        const oldStats = (await ctx.storage.get("stats").catch(() => undefined)) as Record<string, number> | undefined
        ledger.update((d) => {
          if (d.days[day()] === undefined && oldDay > 0) d.days[day()] = oldDay
          if (!Object.keys(d.counters).length && oldStats) d.counters = { ...oldStats }
        })
      } catch (e) {
        log("warn", `accounting file unavailable (${errorMessage(e)})`)
      }
      const sessions = new Map<string, SessionState>()
      // Per-session overrides (persisted in the accounting file). Config "off" is a kill switch above everything.
      const overrides = new Map<string, Mode>()
      /** Sessions whose requests this instance has handled (one instance per project location). */
      const ownedHere = new Set<string>()
      const loadOverrides = () => {
        try {
          const d = ledger.read()
          overrides.clear()
          for (const [id, r] of Object.entries(d.sessions)) if (r.override) overrides.set(id, r.override)
        } catch {}
      }
      loadOverrides()
      const effectiveMode = (override?: Mode): Mode => (config.mode === "off" || unavailableReason ? "off" : override ?? mode)
      const modeFor = (sessionID: string): Mode => effectiveMode(overrides.get(sessionID))
      let emitChanged: (sessionID?: string) => void = () => {}
      const session = (id: string): SessionState => {
        let s = sessions.get(id)
        if (!s) {
          sessions.set(id, (s = { id, lastRunTokens: 0, lastRunAt: 0, force: false, spentUSD: 0, counters: emptyCounters(), pruneChangedAt: 0, awaitingCacheObservation: false, consecutiveFailures: 0, consecutiveInsufficient: 0, notify: newNotifyState() }))
          // After a reload, resume from the last provider-reported context instead of the message-only estimate.
          try {
            const t = ledger.read().sessions[id]?.trigger as TriggerDiagnostics | undefined
            if (t && typeof t.providerContextTokens === "number") (s.providerContext = t.providerContextTokens), (s.providerBaseline = t.estimatedContextTokens)
          } catch {}
        }
        return s
      }
      const pending = new Map<string, Partial<Counters>>()
      /** Sessions whose trigger diagnostics changed since the last flush. */
      const triggerDirty = new Set<string>()
      const bump = (s: SessionState, delta: Partial<Counters>) => {
        add(s.counters, delta)
        const p = pending.get(s.id) ?? {}
        for (const [k, v] of Object.entries(delta)) (p as any)[k] = ((p as any)[k] ?? 0) + (v as number)
        pending.set(s.id, p)
      }
      const flushCounters = () => {
        if (!pending.size && !triggerDirty.size) return
        const batch = [...pending]
        pending.clear()
        for (const id of triggerDirty) if (!pending.has(id) && !batch.some(([b]) => b === id)) batch.push([id, {}])
        triggerDirty.clear()
        try {
          ledger.update((d) => {
            for (const [id, delta] of batch) {
              const rec = session$(d, id, now())
              for (const [k, v] of Object.entries(delta)) {
                rec.counters[k] = (rec.counters[k] ?? 0) + (v as number)
                d.counters[k] = (d.counters[k] ?? 0) + (v as number)
              }
              const st = sessions.get(id)
              if (st?.trigger) rec.trigger = { ...st.trigger }
              if (st?.lastEvaluationAt) rec.lastEvaluationAt = Math.max(rec.lastEvaluationAt ?? 0, st.lastEvaluationAt)
              rec.updatedAt = now()
            }
          })
        } catch (e) {
          for (const [id, delta] of batch) {
            const p = pending.get(id) ?? {}
            for (const [k, v] of Object.entries(delta)) (p as any)[k] = ((p as any)[k] ?? 0) + (v as number)
            pending.set(id, p)
          }
          log("warn", `accounting write failed (${errorMessage(e)}); will retry`)
        }
      }
      let persistTimer: ReturnType<typeof setTimeout> | undefined
      const persist = () => {
        persistTimer ??= setTimeout(() => {
          persistTimer = undefined
          flushCounters()
          void writeSnapshot()
        }, 1_000)
      }
      // Status snapshot for `jev-stats` CLI (no transcript content, no credentials).
      const snapshotPath = deps.snapshotPath ?? statsSnapshotPath(deps.env ?? process.env)
      const writeSnapshot = async () => {
        try {
          await mkdir(dirname(snapshotPath), { recursive: true, mode: 0o700 })
          const data = {
            updatedAt: new Date(now()).toISOString(),
            version: PLUGIN_VERSION,
            mode,
            endpoint: config.endpoint,
            model: config.model,
            pricePerMTok: price,
            budget: config.budget,
            ...(() => {
              // Same source as the TUI/Desktop indicators and /jev-stats: the shared accounting file.
              const d = ledger.read()
              return {
                spentTodayUSD: d.days[day()] ?? 0,
                global: d.counters,
                sessions: Object.fromEntries(
                  Object.entries(d.sessions).map(([id, r]) => {
                    const st = sessions.get(id)
                    return [id, {
                      mode: effectiveMode(r.override), override: r.override ?? null, spentUSD: r.spentUSD,
                      lastEvaluationAt: r.lastEvaluationAt ? new Date(r.lastEvaluationAt).toISOString() : null,
                      resets: r.resets ?? 0,
                      pruned: st?.decisions ? { dropped: st.decisions.drop.size, truncated: st.decisions.truncate.size } : null,
                      trigger: triggerView(id, r.trigger),
                      counters: r.counters,
                    }]
                  }),
                ),
              }
            })(),
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
            contextWindows = new Map(list.data.filter((m: any) => m.limit?.context > 0).map((m: any) => [`${m.providerID}/${m.id}`, m.limit.context as number]))
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

      let globalInflight = 0
      let reservationSeq = 0
      const MAX_GLOBAL_CONCURRENCY = 2
      const KEEP_ERRORS_WITHIN = 20
      const protectTools = config.protectTools.map((p) => new RegExp(p, "i"))
      /** Advisory health thresholds: defaults, or `health` overrides via the existing plugin options. */
      const healthThresholds = healthThresholdsFromConfig(config)
      /** Pending health notification messages per session (rendered by clients on the `changed` event). */
      const healthNotifyQueue = new Map<string, string>()
      /** Session context windows per provider/model, refreshed with the model metadata. */
      let contextWindows = new Map<string, number>()

      const runJev = async (sessionID: string, s: SessionState, messages: readonly OcMessage[], tokens: number, sessionMode: Mode, triggerTokens = tokens) => {
        const outcome = (reason: TriggerReason, error?: string) => {
          if (!s.trigger) return
          s.trigger.reason = reason
          if (error) (s.trigger.lastError = error), (s.trigger.lastErrorAt = new Date(now()).toISOString())
        }
        const healthInput = (): HealthInput => {
          const t = s.trigger
          const contextTokens = t?.triggerContextTokens ?? s.lastRunTokens
          return {
            contextTokens,
            contextIsProviderReported: t?.providerContextTokens !== null && t?.providerContextTokens !== undefined,
            contextWindow: s.model ? contextWindows.get(`${s.model.providerID}/${s.model.id}`) : undefined,
            stateTokens: s.lastStateTokens,
            maxStateTokens: config.maxStateTokens,
            eligibleResults: t?.eligibleResults,
            protectedResults: t?.protectedResults,
            reductionPctEstimated: s.counters.contextTokensBefore > 0
              ? Math.max(0, Math.round((1 - s.counters.contextTokensAfter / s.counters.contextTokensBefore) * 100))
              : undefined,
            insufficientReductions: s.consecutiveInsufficient,
            evaluationFailures: s.consecutiveFailures,
            nativeCompactions: s.counters.nativeCompactions,
            now: now(),
          }
        }
        const notifyHealth = () => {
          const input = healthInput()
          const result = assessHealth(input, healthThresholds)
          if (!s.notify) s.notify = newNotifyState()
          if (healthShouldNotify(s.notify, result.level, now())) {
            recordNotify(s.notify, result.level, now())
            emitChanged(sessionID)
            // Clients (TUI toast / Desktop) render the message from the snapshot on the `changed` event.
            healthNotifyQueue.set(sessionID, healthNotifyMessage(result.level, input))
          } else if (s.notify.lastLevel !== result.level) {
            recordNotify(s.notify, result.level, now())
            emitChanged(sessionID)
          }
        }
        if (priceError) throw new ConfigError(priceError)
        const key = await getKey()
        if (!key) throw new AuthError(`no API key for ${config.endpoint}`)
        bump(s, { attempts: 1 })
        const started = now()
        const reservations: string[] = []
        const client = createJevClient(
          {
            url: endpointUrl(config),
            model: wireModel(config),
            apiKey: key,
            timeoutMs: config.timeoutMs,
            maxRetries: config.maxRetries,
            fetch: deps.fetch,
            // Every request atomically reserves its estimated cost in the shared accounting file before it starts,
            // so parallel batches, concurrent sessions and other projects cannot overshoot a limit together.
            // The reservation is released when the attempt ends; abandoned ones expire (crash recovery).
            beforeRequest: (est) => {
              const cost = (est * price) / 1e6
              const id = `${process.pid}-${started}-${++reservationSeq}`
              ledger.update((d) => {
                const today = day()
                const daySpent = (d.days[today] ?? 0) + reservedFor(d, (r) => r.day === today)
                const rec = session$(d, sessionID, now())
                const sessionSpent = rec.spentUSD + reservedFor(d, (r) => r.sessionID === sessionID)
                if (exceeds(config.budget.perDayUSD, daySpent, cost) || exceeds(config.budget.perSessionUSD, sessionSpent, cost))
                  throw new BudgetError("Jev budget exhausted")
                d.reservations[id] = { usd: cost, day: today, sessionID, pid: process.pid, at: now() }
              })
              reservations.push(id)
            },
            afterRequest: () => {
              const id = reservations.shift()
              if (id) ledger.update((d) => void delete d.reservations[id])
            },
            onUsage: ({ inputTokens, measured }) => {
              const cost = (inputTokens * price) / 1e6
              // Spend is recorded atomically, once per successful response (never duplicated by retries).
              ledger.update((d) => {
                d.days[day()] = (d.days[day()] ?? 0) + cost
                const rec = session$(d, sessionID, now())
                rec.spentUSD += cost
                rec.updatedAt = now()
                s.spentUSD = rec.spentUSD
              })
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
            protection: { protectTools, keepErrorsWithinMessages: KEEP_ERRORS_WITHIN, alreadyDecided: s.decisions?.evaluated },
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
          s.lastEvaluationAt = now()
          if (config.logDecisions)
            log("info", `session ${sessionID}: ${out.result.decisions.filter((d) => d.reason !== "pinned" && d.reason !== "windowed_out").map((d) => `${d.id}:${d.tool}:${d.action}`).join(" ")}`)
          const evaluated = new Set(s.decisions?.evaluated ?? [])
          // 'windowed_out' decisions were never asked (bounded state window): they stay candidates.
          const askedIds = new Set(out.result.decisions.filter((d) => d.reason !== "pinned" && d.reason !== "windowed_out").map((d) => d.id))
          for (const c of out.calls) if (askedIds.has(c.id)) evaluated.add(c.tool_use_id)
          s.lastStateTokens = st.stateTokens
          const sufficient = out.ratio >= config.minReductionRatio
          if (sessionMode === "dry-run") {
            // Record what was evaluated so dry-run never pays twice for the same calls; nothing is applied.
            s.decisions = { drop: new Set(), truncate: new Map(), evaluated }
            bump(s, { dryRuns: 1, ...(sufficient ? {} : { skippedInsufficient: 1 }) })
            s.consecutiveInsufficient = sufficient ? 0 : s.consecutiveInsufficient + 1
            s.consecutiveFailures = 0
            outcome("evaluated_dry_run")
            log("info", `dry-run session ${sessionID}: ~${tokens} → ~${after} tokens (${(out.ratio * 100).toFixed(1)}% chars), ${st.requests} Jev request(s), not applied`)
            notifyHealth()
            return
          }
          if (!sufficient) {
            // Remember what was asked so unchanged calls are not paid for again.
            s.decisions = { drop: new Set(s.decisions?.drop ?? []), truncate: new Map(s.decisions?.truncate ?? []), evaluated }
            bump(s, { skippedInsufficient: 1, ...(config.nativeFallback ? { nativeFallbacks: 1 } : {}) })
            s.consecutiveInsufficient++
            s.consecutiveFailures = 0
            outcome("insufficient_reduction")
            log("info", `session ${sessionID}: reduction ${(out.ratio * 100).toFixed(1)}% below ${config.minReductionRatio * 100}%; native compaction remains in charge`)
            notifyHealth()
            return
          }
          s.consecutiveInsufficient = 0
          s.consecutiveFailures = 0
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
          outcome("pruning_active")
        } catch (e) {
          if (e instanceof BudgetError) (bump(s, { budgetBlocked: 1 }), (s.budgetBlocked = true), outcome("budget_exhausted"))
          else {
            bump(s, { failures: 1, rateLimited: client.usage.rateLimited, ...(config.nativeFallback ? { nativeFallbacks: 1 } : {}) })
            s.consecutiveFailures++
            outcome("evaluation_failed", errorMessage(e))
          }
          log("warn", `session ${sessionID}: Jev skipped (${errorMessage(e)}); request sent unpruned`)
        } finally {
          s.lastRunTokens = triggerTokens
          s.lastRunAt = now()
          persist()
          emitChanged(sessionID)
          notifyHealth()
        }
      }

      const onContext = async (event: { sessionID: string; model: { providerID: string; id: string }; messages: OcMessage[] }) => {
        // Plugin status messages are shown to the user but never sent to any model.
        if (event.messages.some(isStatusMessage)) event.messages = event.messages.filter((m) => !isStatusMessage(m))
        ownedHere.add(event.sessionID)
        const sessionMode = modeFor(event.sessionID)
        if (sessionMode === "off") {
          const st = sessions.get(event.sessionID)
          if (st?.trigger) (st.trigger.reason = "disabled"), (st.trigger.eligible = false)
          return
        }
        const s = session(event.sessionID)
        s.model = { providerID: event.model.providerID, id: event.model.id }
        // Record the project directory once per session (for /jev-handover); process CWD is the location root.
        if (s.counters.runs + s.counters.attempts === 0)
          try {
            const cwd = process.cwd()
            ledger.update((d) => {
              const rec = session$(d, event.sessionID, now())
              if (!rec.projectDirectory) rec.projectDirectory = cwd
            })
          } catch {}
        // Thresholds and Jev state are based on what is actually sent (cached decisions applied).
        const current = sessionMode === "active" && s.decisions ? applyCached(event.messages, s.decisions).messages : event.messages
        const tokens = estimateContextTokens(current)
        s.sentEstimate = tokens
        const info = await modelInfo(event.model)
        const threshold = thresholdFor(config, info.context)
        // The message-only estimate excludes the system prompt and tool definitions and undercounts dense content
        // (code, shell output), so on its own it can stay far below what the provider actually receives.
        // When the provider has reported this session's context, compare that figure plus estimated growth since.
        const triggerTokens = s.providerContext !== undefined && s.providerBaseline !== undefined
          ? s.providerContext + Math.max(0, tokens - s.providerBaseline)
          : tokens
        const fingerprint = hash(current.flatMap((m) => m.content.filter((p) => p.type === "tool-call").map((p) => String(p.id))).join(","))
        const growth = triggerTokens - s.lastRunTokens
        const cooldownRemainingMs = Math.max(0, config.cooldownMs - (now() - s.lastRunAt))
        const candidates = countCandidates(current, config.preserveRecentMessages, {
          protectTools: protectTools,
          keepErrorsWithinMessages: KEEP_ERRORS_WITHIN,
          alreadyDecided: s.decisions?.evaluated,
        })
        const previous = s.trigger
        const t: TriggerDiagnostics = (s.trigger = {
          reason: "waiting_threshold",
          providerContextTokens: s.providerContext ?? null,
          estimatedContextTokens: tokens,
          triggerContextTokens: triggerTokens,
          thresholdTokens: threshold,
          growthTokens: growth,
          minGrowthTokens: config.minGrowthTokens,
          cooldownRemainingMs,
          eligibleResults: candidates.eligible,
          protectedResults: candidates.protected,
          eligible: false,
          checkedAt: new Date(now()).toISOString(),
          lastError: previous?.lastError ?? null,
          lastErrorAt: previous?.lastErrorAt ?? null,
        })
        const forced = s.force
        const blocked = (): TriggerReason | undefined => {
          if (priceError) return "disabled"
          if (!forced) {
            if (triggerTokens < threshold) return "waiting_threshold"
            if (growth < config.minGrowthTokens) return "waiting_growth"
            if (cooldownRemainingMs > 0) return "cooldown"
            if (fingerprint === s.lastFingerprint) return "no_new_tool_calls"
          }
          if (candidates.eligible === 0) return "no_eligible_results"
          if (s.inflight) return "evaluating"
          if (globalInflight >= MAX_GLOBAL_CONCURRENCY) return "concurrency_limit"
          return undefined
        }
        let reason = blocked()
        if (!reason) {
          // Local, synchronous check (no request, no await, so the in-flight guard below stays race-free).
          try {
            const d = ledger.read()
            if (reached(config.budget.perDayUSD, d.days[day()] ?? 0) || reached(config.budget.perSessionUSD, d.sessions[event.sessionID]?.spentUSD ?? 0)) reason = "budget_exhausted"
          } catch {}
        }
        if (reason) {
          // Between evaluations, a session with applied decisions reports that pruning is active.
          const waiting = reason === "waiting_threshold" || reason === "waiting_growth" || reason === "cooldown" || reason === "no_new_tool_calls" || reason === "no_eligible_results"
          const pruning = sessionMode === "active" && !!s.decisions && s.decisions.drop.size + s.decisions.truncate.size > 0
          t.reason = waiting && pruning ? "pruning_active" : reason
          if (reason === "budget_exhausted") s.budgetBlocked = true
          if (reason === "auth_unavailable") (t.lastError = `no API key for ${config.endpoint}`), (t.lastErrorAt = t.checkedAt)
          if (forced && reason !== "evaluating" && reason !== "concurrency_limit") s.force = false
          // Refresh indicators when the outcome changes (not on every request).
          if (previous?.reason !== t.reason) emitChanged(event.sessionID)
        } else {
          t.eligible = true
          t.reason = "evaluating"
          s.force = false
          s.lastFingerprint = fingerprint
          globalInflight++
          emitChanged(event.sessionID)
          s.inflight = runJev(event.sessionID, s, current, tokens, sessionMode, triggerTokens).finally(() => {
            globalInflight--
            s.inflight = undefined
          })
          try {
            await s.inflight
          } catch (e) {
            // Fail open: never throw from the hook; the request goes out unpruned.
            const auth = e instanceof AuthError
            if (!auth) bump(s, { failures: 1 })
            ;(t.reason = auth ? "auth_unavailable" : "evaluation_failed"), (t.lastError = errorMessage(e)), (t.lastErrorAt = new Date(now()).toISOString())
            log("warn", `session ${event.sessionID}: Jev skipped (${t.lastError}); request sent unpruned`)
          }
        }
        triggerDirty.add(event.sessionID)
        persist()
        if (sessionMode !== "active" || !s.decisions) return
        const before = estimateContextTokens(event.messages)
        const applied = applyCached(event.messages, s.decisions)
        if (!applied.changed) return
        event.messages = applied.messages
        const sent = estimateContextTokens(applied.messages)
        // Pair the next provider-reported context with what was actually sent (after pruning).
        s.sentEstimate = sent
        const removed = Math.max(0, before - sent)
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
        ownedHere.add(event.sessionID)
        if (modeFor(event.sessionID) !== "active" || !s?.decisions) return
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
              // Counted by the instance serving this session; if this instance has not seen a request for it yet
              // (e.g. right after a reload), count it only when it is the session's known owner in the ledger.
              const id = ev.data?.sessionID
              if (s) {
                bump(s, { nativeCompactions: 1 })
                s.lastRunTokens = 0
                s.decisions = undefined
                s.providerContext = s.providerBaseline = undefined
                s.consecutiveInsufficient = 0
                s.consecutiveFailures = 0
                // Health relief: a successful compaction resets notification cadence (hysteresis).
                if (s.notify) resetNotifyState(s.notify)
                persist()
              } else if (id && ownedHere.has(id)) (bump(session(id), { nativeCompactions: 1 }), persist())
              continue
            }
            const t = ev.data?.tokens
            if (!s || !t) continue
            // Provider-reported context of this step (uncached + cached input), paired with the estimate of what was sent.
            if (s.sentEstimate !== undefined) {
              s.providerContext = (t.input ?? 0) + (t.cache?.read ?? 0) + (t.cache?.write ?? 0)
              s.providerBaseline = s.sentEstimate
              // Keep the persisted diagnostics paired (provider figure and the estimate of the same request).
              if (s.trigger) (s.trigger.providerContextTokens = s.providerContext ?? null), (s.trigger.estimatedContextTokens = s.sentEstimate), triggerDirty.add(s.id)
            }
            bump(s, { primarySteps: 1, primaryCostUSD: Number(ev.data.cost) || 0, primaryInputTokens: t.input ?? 0, cacheReadTokens: t.cache?.read ?? 0, cacheWriteTokens: t.cache?.write ?? 0 })
            if (s.awaitingCacheObservation) (bump(s, { cacheWriteAfterPruneChange: t.cache?.write ?? 0 }), (s.awaitingCacheObservation = false))
            persist()
            // Passive health check with the freshest provider-reported context; local only, no requests.
            const st = s.notify ?? (s.notify = newNotifyState())
            const input: HealthInput = {
              contextTokens: s.providerContext ?? s.trigger?.triggerContextTokens ?? s.lastRunTokens,
              contextIsProviderReported: s.providerContext !== undefined,
              contextWindow: s.model ? contextWindows.get(`${s.model.providerID}/${s.model.id}`) : undefined,
              stateTokens: s.lastStateTokens,
              maxStateTokens: config.maxStateTokens,
              eligibleResults: s.trigger?.eligibleResults,
              protectedResults: s.trigger?.protectedResults,
              reductionPctEstimated: s.counters.contextTokensBefore > 0
                ? Math.max(0, Math.round((1 - s.counters.contextTokensAfter / s.counters.contextTokensBefore) * 100))
                : undefined,
              insufficientReductions: s.consecutiveInsufficient,
              evaluationFailures: s.consecutiveFailures,
              nativeCompactions: s.counters.nativeCompactions,
              now: now(),
            }
            const result = assessHealth(input, healthThresholds)
            if (healthShouldNotify(st, result.level, now())) {
              recordNotify(st, result.level, now())
              healthNotifyQueue.set(s.id, healthNotifyMessage(result.level, input))
              emitChanged(s.id)
            } else if (st.lastLevel !== result.level) {
              recordNotify(st, result.level, now())
            }
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
      const unknown = (what: string) => `unavailable — ${what}`
      /** The user's global OpenCode configuration, edited only by the explicitly-approved setup flow. */
      const globalConfigPath = process.env.OPENCODE_CONFIG ?? configDir() + "/opencode.jsonc"

      /** Live trigger diagnostics; cooldown is recomputed so it counts down between requests. */
      const triggerView = (sessionID: string, stored?: Record<string, unknown>): TriggerDiagnostics | null => {
        const st = sessions.get(sessionID)
        const t = (st?.trigger ?? stored) as TriggerDiagnostics | undefined
        if (!t) return null
        const eff = modeFor(sessionID)
        const elapsed = now() - Date.parse(t.checkedAt)
        return {
          ...t,
          reason: eff === "off" ? "disabled" : st?.inflight ? "evaluating" : t.reason,
          cooldownRemainingMs: st ? Math.max(0, config.cooldownMs - (now() - st.lastRunAt)) : Math.max(0, t.cooldownRemainingMs - elapsed),
        }
      }
      const triggerLines = (sessionID: string, stored?: Record<string, unknown>): string[] => {
        const t = triggerView(sessionID, stored)
        if (!t) return ["trigger: not checked yet (checked on the session's next model request)"]
        const k = (n: number) => `${Math.round(n / 100) / 10}k`
        return [
          `trigger: ${TRIGGER_LABEL[t.reason]} [${t.reason}] (checked ${t.checkedAt})`,
          `  context: provider-reported ${t.providerContextTokens === null ? "n/a" : k(t.providerContextTokens)}, estimated messages ${k(t.estimatedContextTokens)}, used for trigger ${k(t.triggerContextTokens)} / threshold ${k(t.thresholdTokens)}`,
          `  growth since last evaluation ${k(t.growthTokens)} / ${k(t.minGrowthTokens)}; cooldown remaining ${Math.ceil(t.cooldownRemainingMs / 1000)}s`,
          `  tool results: ${t.eligibleResults} eligible, ${t.protectedResults} pinned (protected, recent or already evaluated); eligible now: ${t.eligible ? "yes" : "no"}`,
          ...(t.lastError ? [`  last error: ${t.lastError} (${t.lastErrorAt})`] : []),
        ]
      }

      /** Persisted per-session view: one consistent source for indicators, /jev-stats, /jev-status and the CLI. */
      const sessionView = (sessionID: string) => {
        flushCounters()
        const d = ledger.read()
        const today = d.days[day()] ?? 0
        const rec = d.sessions[sessionID]
        const st = sessions.get(sessionID)
        const counters: Counters = { ...emptyCounters(), ...(rec?.counters ?? {}) }
        return { d, today, rec, st, counters }
      }
      const modeSource = (sessionID?: string) =>
        config.mode === "off" ? "config kill switch" : unavailableReason ? "unavailable" : sessionID && overrides.has(sessionID) ? "session override" : "inherited from global"

      const statusText = async (sessionID?: string) => {
        const { d, today, rec, st } = sessionID ? sessionView(sessionID) : { d: ledger.read(), today: 0, rec: undefined, st: undefined }
        const day$ = sessionID ? today : d.days[day()] ?? 0
        const eff = sessionID ? modeFor(sessionID) : effectiveMode()
        return [
          `Jev Compaction for OpenCode ${PLUGIN_VERSION}`,
          `global mode=${mode} (default for all sessions on this OpenCode server; persisted)`,
          sessionID ? `this session (${sessionID}): ${eff} (${modeSource(sessionID)})` : "no session selected",
          `endpoint=${config.endpoint}, model=${config.model} ($${price}/Mtok input)${priceError ? `; BLOCKED: ${priceError}` : ""}`,
          `threshold=min(${config.compactAtTokens}, ${config.compactAtContextFraction}×window) tokens, keepThreshold=${config.keepThreshold}, minReduction=${config.minReductionRatio}`,
          `spend (est.): ${sessionID ? `session $${(rec?.spentUSD ?? 0).toFixed(5)} / ${formatLimit(config.budget.perSessionUSD)}, ` : ""}today $${day$.toFixed(5)} / ${formatLimit(config.budget.perDayUSD)}`,
          sessionID
            ? [
                `session health: ${healthText(sessionID)?.split("\n").slice(0, 2).join(" ") ?? "not assessed yet"}`,
                triggerLines(sessionID, rec?.trigger).join("\n"),
              ].join("\n")
            : "",
          sessionID
            ? `pruning applied now: ${st?.decisions && (st.decisions.drop.size || st.decisions.truncate.size) ? `${st.decisions.drop.size} dropped, ${st.decisions.truncate.size} truncated` : "none"} (decisions are in memory; history below is persisted)`
            : "",
          `native compaction: ${fallbackRef ? `summaries use ${fallback} (compaction agent only)` : "unchanged (OpenCode default)"}`,
        ].filter(Boolean).join("\n")
      }

      /** Structured state for status indicators (TUI sidebar/footer, Desktop pill). Local reads only. */
      const snapshot = async (sessionID?: string): Promise<JevSnapshot> => {
        const { d, today, rec, st, counters: c } = sessionID ? sessionView(sessionID) : { d: ledger.read(), today: 0, rec: undefined, st: undefined, counters: emptyCounters() }
        const daySpent = sessionID ? today : d.days[day()] ?? 0
        const eff = sessionID ? modeFor(sessionID) : effectiveMode()
        const overDay = reached(config.budget.perDayUSD, daySpent)
        const overSession = !!rec && reached(config.budget.perSessionUSD, rec.spentUSD)
        const state: JevSnapshot["state"] =
          unavailableReason ? "unavailable" : eff === "off" ? "off" : priceError ? "unavailable" : st?.inflight ? "evaluating" : overDay || overSession ? "budget" : eff
        const health: SessionHealthSnapshot | null = st
          ? (() => {
              const input: HealthInput = {
                contextTokens: st.trigger?.triggerContextTokens ?? st.lastRunTokens,
                contextIsProviderReported: st.trigger?.providerContextTokens !== null && st.trigger?.providerContextTokens !== undefined,
                contextWindow: st.model ? contextWindows.get(`${st.model.providerID}/${st.model.id}`) : undefined,
                stateTokens: st.lastStateTokens,
                maxStateTokens: config.maxStateTokens,
                eligibleResults: st.trigger?.eligibleResults,
                protectedResults: st.trigger?.protectedResults,
                reductionPctEstimated: st.counters.contextTokensBefore > 0
                  ? Math.max(0, Math.round((1 - st.counters.contextTokensAfter / st.counters.contextTokensBefore) * 100))
                  : undefined,
                insufficientReductions: st.consecutiveInsufficient,
                evaluationFailures: st.consecutiveFailures,
                nativeCompactions: st.counters.nativeCompactions,
                now: now(),
              }
              const r = assessHealth(input, healthThresholds)
              return {
                level: r.level,
                contextTokens: input.contextTokens,
                contextIsProviderReported: input.contextIsProviderReported,
                contextWindow: input.contextWindow ?? null,
                utilizationPct: r.utilizationPct,
                stateTokens: input.stateTokens ?? null,
                maxStateTokens: config.maxStateTokens,
                eligibleResults: input.eligibleResults ?? null,
                protectedResults: input.protectedResults ?? null,
                reductionPctEstimated: input.reductionPctEstimated ?? null,
                consecutiveFailures: st.consecutiveFailures,
                consecutiveInsufficient: st.consecutiveInsufficient,
                nativeCompactions: st.counters.nativeCompactions,
                reasons: r.reasons,
                recommendation: r.recommendation,
                nextAction: r.nextAction,
              }
            })()
          : null
        return {
          state,
          mode: eff,
          globalMode: mode,
          modeSource: modeSource(sessionID),
          version: PLUGIN_VERSION,
          reason: unavailableReason ?? priceError ?? (config.mode === "off" ? "disabled in config" : null) ?? (overDay ? "daily budget reached" : overSession ? "session budget reached" : null),
          endpoint: config.endpoint,
          model: config.model,
          todayUSDEstimated: daySpent,
          perDayUSD: config.budget.perDayUSD,
          perSessionUSD: config.budget.perSessionUSD,
          session: sessionID
            ? {
                evaluations: c.runs,
                applied: c.appliedRuns,
                dryRuns: c.dryRuns,
                failures: c.failures,
                tokensRemovedEstimated: Math.max(0, c.contextTokensBefore - c.contextTokensAfter),
                reductionPctEstimated: c.contextTokensBefore > 0 ? Math.round((1 - c.contextTokensAfter / c.contextTokensBefore) * 1000) / 10 : 0,
                requestsPruned: c.requestsPruned,
                tokensRemovedFromRequestsEstimated: c.tokensRemovedFromRequests,
                jevTokensMeasured: c.jevInputTokensMeasured,
                costUSDEstimated: rec?.spentUSD ?? 0,
                pruned: { dropped: st?.decisions?.drop.size ?? 0, truncated: st?.decisions?.truncate.size ?? 0 },
                lastEvaluationAt: rec?.lastEvaluationAt ? new Date(rec.lastEvaluationAt).toISOString() : null,
                nativeCompactions: c.nativeCompactions,
                resets: c.resets,
                evaluating: !!st?.inflight,
                attempts: c.attempts,
                trigger: triggerView(sessionID, rec?.trigger),
                health,
              }
            : null,
        }
      }

      /** /jev-health: concise local report; no requests. */
      const healthText = (sessionID?: string): string | null => {
        if (!sessionID) return null
        const { rec, st, counters: c } = sessionView(sessionID)
        const t = st?.trigger
        const window = st?.model ? contextWindows.get(`${st.model.providerID}/${st.model.id}`) : undefined
        const input: HealthInput = {
          contextTokens: t?.triggerContextTokens ?? st?.lastRunTokens ?? 0,
          contextIsProviderReported: t?.providerContextTokens !== null && t?.providerContextTokens !== undefined,
          contextWindow: window,
          stateTokens: st?.lastStateTokens,
          maxStateTokens: config.maxStateTokens,
          eligibleResults: t?.eligibleResults,
          protectedResults: t?.protectedResults,
          reductionPctEstimated: c.contextTokensBefore > 0 ? Math.max(0, Math.round((1 - c.contextTokensAfter / c.contextTokensBefore) * 100)) : undefined,
          insufficientReductions: st?.consecutiveInsufficient ?? 0,
          evaluationFailures: st?.consecutiveFailures ?? 0,
          nativeCompactions: c.nativeCompactions,
          now: now(),
        }
        const r = assessHealth(input, healthThresholds)
        const k = (n: number) => n.toLocaleString("en-US")
        return [
          `Session health: ${HEALTH_LABEL[r.level]}`,
          `  Primary context: ${k(input.contextTokens)} tokens (${input.contextIsProviderReported ? "provider-reported" : "estimated"})${window ? ` of ${k(window)} (model window, ${r.utilizationPct}% used)` : " (model window unknown)"}`,
          `  Jev evaluation state: ${input.stateTokens === undefined ? "not yet evaluated" : `${k(input.stateTokens)} / ${k(config.maxStateTokens)} tokens`}`,
          `  Tool results: ${input.eligibleResults ?? "?"} eligible, ${input.protectedResults ?? "?"} protected`,
          `  Optimization effectiveness: ${input.reductionPctEstimated === undefined ? "no evaluation yet" : `~${input.reductionPctEstimated}% (evaluation snapshot estimate, not provider billing)`}`,
          `  Consecutive outcomes: ${input.evaluationFailures} failure(s), ${input.insufficientReductions} insufficient-reduction(s)`,
          `  Native compactions this session: ${input.nativeCompactions}`,
          `  Reason: ${r.reasons.join("; ")}`,
          `  Recommendation: ${r.recommendation}`,
          `  Next action: ${r.nextAction}`,
          "Advisory only: Jev never compacts, resets or closes sessions automatically.",
        ].join("\n")
      }

      /**
       * /jev-handover: a continuation summary assembled from local Jev/session records.
       * Deliberately no inference request: where a model-generated narrative would be needed
       * (branch, commits, modified files, test results), the output states what is missing
       * instead of inventing it. Never includes credentials or message content.
       */
      const handoverText = async (sessionID?: string): Promise<string> => {
        if (!sessionID) return noSession
        const { rec, st, counters: c } = sessionView(sessionID)
        const project = rec?.projectDirectory ?? unknown("project directory (not recorded by Jev; check the session header)")
        const lines = [
          "Jev handover summary (local records only; no inference request was made)",
          `  Session: ${sessionID}`,
          `  Project directory: ${project}`,
          `  Health at handover: ${(healthText(sessionID) ?? "").split("\n")[0]}`,
          `  Objective / completed work / architectural decisions: ${unknown("not recorded by Jev; summarize from the conversation and reports explicitly")}`,
          `  Git branch / commits / modified files / test results: ${unknown("not visible to the plugin; run git status, git log and the test suite in the new session")}`,
          `  Jev state for this session: ${c.runs} evaluation(s), ${c.appliedRuns} applied, ${c.failures} failure(s), ${c.nativeCompactions} native compaction(s), ${c.resets} reset(s)`,
          `  Jev cost this session: $${(rec?.spentUSD ?? 0).toFixed(5)} (estimated)`,
          `  Pruning now applied: ${st?.decisions ? `${st.decisions.drop.size} dropped, ${st.decisions.truncate.size} truncated` : "none"} (a fresh session starts unpruned)`,
          `  Recommended next step: ${assessHealth({
            contextTokens: st?.trigger?.triggerContextTokens ?? st?.lastRunTokens ?? 0,
            contextIsProviderReported: false,
            maxStateTokens: config.maxStateTokens,
            insufficientReductions: st?.consecutiveInsufficient ?? 0,
            evaluationFailures: st?.consecutiveFailures ?? 0,
            nativeCompactions: c.nativeCompactions,
            now: now(),
          }, healthThresholds).nextAction}`,
          "Copy this block into the new session's first message and add the project-specific details above.",
        ]
        return lines.join("\n")
      }

      const setSessionOverride = async (sessionID: string, next: Mode | undefined) => {        ledger.update((d) => {
          const rec = session$(d, sessionID, now())
          if (next) rec.override = next
          else delete rec.override
          rec.updatedAt = now()
        })
        if (next) overrides.set(sessionID, next)
        else overrides.delete(sessionID)
        // Never reuse decisions across a mode change: a re-enabled session starts clean (calls may be re-evaluated).
        const st = sessions.get(sessionID)
        if (st) (st.decisions = undefined), (st.lastFingerprint = undefined), (st.lastRunTokens = 0), (st.force = false)
        emitChanged(sessionID)
      }

      /** Command actions: pure state changes returning user-facing text. Shared by RPC and slash commands. */
      const actions = {
        status: (sessionID?: string) => statusText(sessionID),
        stats: async (sessionID?: string) => {
          const v = sessionID ? sessionView(sessionID) : undefined
          const d = v?.d ?? ledger.read()
          const head = v
            ? `This session: mode ${modeFor(sessionID!)} (${modeSource(sessionID)}); last successful evaluation ${v.rec?.lastEvaluationAt ? new Date(v.rec.lastEvaluationAt).toISOString() : "never"}; resets ${v.counters.resets}\n${triggerLines(sessionID!, v.rec?.trigger).join("\n")}\n${formatStats("This session (persisted)", v.counters)}\n`
            : ""
          return `Jev Compaction for OpenCode ${PLUGIN_VERSION}\n` + head + formatStats("All sessions (persisted)", { ...emptyCounters(), ...d.counters }) + `\n  Today (UTC ${day()}): $${(d.days[day()] ?? 0).toFixed(5)} / ${formatLimit(config.budget.perDayUSD)} (est.)`
        },
        setMode: async (next: Mode) => {
          if (next !== "off" && unavailableReason) return `Not changed: Jev is unavailable (${unavailableReason}).`
          if (next !== "off" && config.mode === "off")
            return 'Not changed: Jev is disabled in opencode.jsonc ("mode": "off" or "enabled": false). Change the config to enable it.'
          await setMode(next)
          const note = overrides.size ? ` Sessions with an override keep it (${overrides.size}).` : ""
          return (next === "active" ? "Global: active (pruning outgoing requests)." : next === "dry-run" ? "Global: dry-run (evaluating only; requests are not modified)." : "Global: off (no Jev requests, no pruning).") + note
        },
        setSessionMode: async (sessionID: string | undefined, next: Mode | "inherit") => {
          if (!sessionID) return noSession
          if (next !== "inherit" && next !== "off" && config.mode === "off")
            return 'Not changed: Jev is disabled in opencode.jsonc ("mode": "off"); the config kill switch overrides session settings.'
          await setSessionOverride(sessionID, next === "inherit" ? undefined : next)
          return next === "inherit"
            ? `This session now inherits the global mode (${mode}).`
            : `This session only: ${next === "off" ? "off (requests sent unpruned, no Jev requests)" : next === "dry-run" ? "dry-run (evaluate only)" : "active (pruning)"}. Other sessions unchanged.`
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
          const eff = modeFor(sessionID)
          if (eff === "off") return `Jev is off for this session (${modeSource(sessionID)}); enable it first.`
          session(sessionID).force = true
          emitChanged(sessionID)
          return `Jev will evaluate this session on its next model request (mode=${eff}). No request is sent now.`
        },
        /** Concise health report; local computation only, no Jev or model request. */
        health: (sessionID?: string) => {
          const h = healthText(sessionID)
          return h ?? noSession
        },
        /**
         * Continuation summary for a fresh session. Local metadata only (session, project, Jev state);
         * no inference request is made. Where a model-generated narrative would be needed, the output
         * says so explicitly instead of inventing content.
         */
        handover: async (sessionID?: string) => handoverText(sessionID),
        /** Drains a pending health notification for the session (one message per transition). */
        drainNotification: (sessionID?: string): string | null => {
          if (!sessionID) return null
          const msg = healthNotifyQueue.get(sessionID)
          if (msg !== undefined) healthNotifyQueue.delete(sessionID)
          return msg ?? null
        },
        /**
         * /jev-setup step 1: local recommendation preview for a preset. Reads the model catalogue
         * and the user's current assignments; makes no changes and no requests. When overrides are
         * supplied, they replace the recommendation for those roles (custom preset).
         */
        setupPlan: async (preset: "quality" | "balanced" | "economy", overrides?: Record<string, string>) => {
          const models = await catalog(ctx)
          const current = currentAssignments(globalConfigPath)
          const recs = recommendAll(models, preset, current)
          const lines = [
            `Jev agent configuration preview (${preset}; NOTHING has been changed)`,
            `  Configuration file: ${globalConfigPath}`,
            `  Models available: ${models.length} (${models.filter(m => m.inputPrice !== null).length} with known pricing)`,
            "",
            "  Role | Current model | Recommended | Provider | Price | Reason",
          ]
          for (const r of recs) {
            const override = overrides?.[r.role]
            const chosen = override ?? r.model
            const price = r.priceKnown ? "known" : "unknown"
            lines.push(`  ${ROLE_LABEL[r.role]}: ${current[r.role] ?? "(unset)"} → ${chosen ?? "(no suitable model)"} ${r.priceKnown ? "" : "(price unknown)"} — ${override ? "your override" : r.reason}`)
            void price
          }
          lines.push(
            "",
            "  Existing instructions, permissions and every other agent key are preserved; only `model` changes.",
            "  Review the preview, override any role (custom), then apply with setupApply for the approved assignments.",
            "  Applying creates a timestamped backup first and shows the rollback path.",
          )
          return lines.join("\n")
        },
        /** /jev-setup step 2: apply EXPLICITLY approved assignments (backup first, atomic write). */
        setupApply: async (assignments: Record<string, string>, skipUnassigned?: boolean) => {
          try {
            const edit = applyAgentAssignments(globalConfigPath, assignments as Partial<Record<Role, string>>, { skipUnassigned })
            return [
              "Applied. OpenCode reloads configuration automatically (no restart needed).",
              ...edit.changes.map(c => `  ${c}`),
              `  Backup: ${edit.backupPath}`,
              `  Rollback: copy the backup over ${globalConfigPath}`,
              "  IMPORTANT: verify with /jev-status and your next session that agents work as expected.",
            ].join("\n")
          } catch (e) {
            return `Not applied: ${(e as Error).message}\n  Your configuration is unchanged; the backup was not needed.`
          }
        },
      }

      // RPC powers the TUI/GUI commands and indicators; without it pruning still works and the CLI reader remains.
      const registration = typeof (ctx as any).rpc?.register !== "function"
        ? (log("warn", "plugin RPC unavailable in this OpenCode version; TUI/GUI commands disabled, pruning unaffected"), undefined)
        : await ctx.rpc.register(JevRpc, {
        snapshot: async (input: any) => (await snapshot(input?.sessionID)) as any,
        status: async (input: any) => ({ text: await actions.status(input?.sessionID) }),
        stats: async (input: any) => ({ text: await actions.stats(input?.sessionID) }),
        health: async (input: any) => ({ text: actions.health(input?.sessionID) }),
        handover: async (input: any) => ({ text: await actions.handover(input?.sessionID) }),
        drainNotification: async (input: any) => ({ text: actions.drainNotification(input?.sessionID) ?? "" }),
        setMode: async (input: any) => ({ text: await actions.setMode(input.mode as Mode) }),
        setSessionMode: async (input: any) => ({ text: await actions.setSessionMode(input.sessionID, input.mode) }),
        reset: async (input: any) => ({ text: actions.reset(input.sessionID) }),
        compact: async (input: any) => ({ text: actions.compact(input.sessionID) }),
        setupPlan: async (input: any) => ({ text: await actions.setupPlan(input.preset, input.overrides) }),
        setupApply: async (input: any) => ({ text: await actions.setupApply(input.assignments, input.skipUnassigned) }),
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
        flushCounters()
        await writeSnapshot()
      }
    },
  }
}

class BudgetError extends Error {}
class AuthError extends Error {}

export default createPlugin()
