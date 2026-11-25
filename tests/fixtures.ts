import { AssistantMessage, ToolMessage, UserMessage, SystemMessage } from "@opencode/ai"
import type { OcMessage } from "../plugin/compaction.ts"

export const SECRET = "sk-proj-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"

let n = 0
/** Builds a representative coding transcript as real @opencode/ai message instances. */
export function transcript(opts: { rounds?: number; bigRead?: number; secret?: boolean } = {}): OcMessage[] {
  const rounds = opts.rounds ?? 12
  const big = "x".repeat(opts.bigRead ?? 6000)
  const msgs: any[] = [
    new SystemMessage({ role: "system", content: [{ type: "text", text: "You are OpenCode. AGENTS.md: never edit src/generated." }] }),
    new UserMessage({ role: "user", content: [{ type: "text", text: "Fix failing test in src/math.ts. Acceptance: all tests pass. Never edit src/generated." }] }),
  ]
  for (let i = 0; i < rounds; i++) {
    const id = `call_${++n}`
    const tool = i % 3 === 0 ? "grep" : i % 3 === 1 ? "read" : "bash"
    const input = tool === "read" ? { path: `src/file${i}.ts` } : tool === "grep" ? { pattern: `foo${i}` } : { command: `npm test -- ${i}` }
    msgs.push(new AssistantMessage({ role: "assistant", content: [{ type: "text", text: `Step ${i}: checking.` }, { type: "tool-call", id, name: tool, input }] }))
    const text = opts.secret && i === 0 ? `API_KEY=${SECRET}\n${big}` : `${tool} output ${i}\n${big}`
    msgs.push(new ToolMessage({ role: "tool", content: [{ type: "tool-result", id, name: tool, result: { type: "text", value: text } }] }))
  }
  msgs.push(new UserMessage({ role: "user", content: [{ type: "text", text: "Keep going, the plan is: fix add() then run tests." }] }))
  return msgs
}

export type FetchCall = { url: string; headers: Record<string, string>; body: any }

/** Mock Jev: drops every result whose tool is grep, truncates read, keeps bash. */
export function mockJev(behaviour: { status?: number[]; keepAll?: boolean; delayMs?: number } = {}) {
  const calls: FetchCall[] = []
  const statuses = [...(behaviour.status ?? [])]
  const fetchImpl = (async (url: string, init: any) => {
    const body = JSON.parse(init.body)
    calls.push({ url, headers: init.headers, body })
    if (behaviour.delayMs) await new Promise((r) => setTimeout(r, behaviour.delayMs))
    const status = statuses.shift()
    if (status && status !== 200)
      return new Response(JSON.stringify({ detail: "nope" }), { status, headers: status === 429 ? { "retry-after": "0" } : {} })
    const answers: Record<string, any> = {}
    for (const name of Object.keys(body.questions)) {
      const instr: string = body.questions[name].instructions
      const tool = /\((\w+)/.exec(instr)?.[1] ?? ""
      const isResult = name.startsWith("result_")
      let p = 0.9
      if (!behaviour.keepAll) {
        if (tool === "grep") p = 0.1
        if (tool === "read") p = isResult ? 0.2 : 0.9
      }
      answers[name] = { type: "noul", noul: p }
    }
    return new Response(JSON.stringify({ model: "jev-1.14.0", answers, usage: { input_tokens: 1000, output_tokens: 10 } }), { status: 200 })
  }) as unknown as typeof fetch
  return { fetch: fetchImpl, calls }
}

/** Minimal fake of the @opencode/plugin promise context: records hooks, commands, agent transforms. */
export function fakeContext(options: Record<string, unknown>, extra: { models?: any[]; agents?: any[] } = {}) {
  const hooks: Record<string, Function[]> = {}
  const serverCommands: Record<string, any> = {}
  const rpc: Record<string, Function> = {}
  const rpcEvents: Array<{ type: string; data: unknown }> = []
  const commands: Record<string, any> = {}
  const agentTransforms: Function[] = []
  const storage = new Map<string, unknown>()
  const synthetic: any[] = []
  const events: any[] = []
  let push: ((e: any) => void) | undefined
  const ctx: any = {
    options,
    app: { version: "2.2.7" },
    storage: {
      get: async (k: string) => storage.get(k),
      set: async (k: string, v: unknown) => void storage.set(k, v),
      remove: async (k: string) => void storage.delete(k),
    },
    model: {
      list: async () => ({ data: extra.models ?? [{ providerID: "provider-a", id: "model-large", limit: { context: 1_048_576 }, cost: [{ input: 1 }] }] }),
    },
    rpc: { register: async (_def: any, handlers: Record<string, Function>) => (Object.assign(rpc, handlers), { dispose: async () => {}, events: { emit: async (type: string, data: unknown) => void rpcEvents.push({ type, data }) } }) },
    integration: { connection: { active: async () => undefined, resolve: async () => undefined } },
    session: {
      hook: async (name: string, cb: Function) => ((hooks[name] ??= []).push(cb), { dispose: async () => {} }),
      synthetic: async (input: any) => (synthetic.push(input), {}),
    },
    agent: {
      transform: async (cb: Function) => (agentTransforms.push(cb), { dispose: async () => {} }),
    },
    command: {
      transform: async (cb: Function) => (cb({ add: (d: any) => (serverCommands[d.name] = d) }), { dispose: async () => {} }),
    },
    event: {
      subscribe: ({ signal }: any) => ({
        [Symbol.asyncIterator]() {
          return {
            next: () =>
              new Promise((resolve) => {
                if (events.length) return resolve({ value: events.shift(), done: false })
                push = (e) => resolve({ value: e, done: false })
                signal?.addEventListener("abort", () => resolve({ value: undefined, done: true }))
              }),
          }
        },
      }),
    },
  }
  // Test-facing `commands` mirror the TUI slash commands: each calls the RPC and records the text shown.
  for (const [name, method, arg] of [
    ["jev-status", "status", "session"], ["jev-stats", "stats", "session"], ["jev-reset", "reset", "session"], ["jev-compact", "compact", "session"],
    ["jev-enable", "setMode", "active"], ["jev-dry-run", "setMode", "dry-run"], ["jev-disable", "setMode", "off"],
  ] as const)
    commands[name] = {
      execute: async ({ sessionID }: { sessionID?: string }) => {
        const out = await rpc[method]!(arg === "session" ? { sessionID } : { mode: arg })
        synthetic.push({ text: out.text })
      },
    }
  return {
    ctx,
    hooks,
    commands,
    serverCommands,
    rpc,
    rpcEvents,
    agentTransforms,
    storage,
    synthetic,
    emit: (e: any) => (push ? (push(e), (push = undefined)) : events.push(e)),
    /** Replays agent transforms on a fresh registry, as OpenCode does on every rebuild. */
    rebuildAgents: () => {
      const registry = new Map((extra.agents ?? []).map((a) => [a.id, structuredClone(a)]))
      for (const t of agentTransforms)
        t({ list: () => [...registry.values()], get: (id: string) => registry.get(id), update: (id: string, f: Function) => registry.has(id) && f(registry.get(id)), remove: (id: string) => registry.delete(id), default: () => {} })
      return registry
    },
  }
}

export async function runContext(f: ReturnType<typeof fakeContext>, sessionID: string, messages: OcMessage[], model = { providerID: "provider-a", id: "model-large" }) {
  const event: any = { sessionID, model, agent: "build", system: [], messages, tools: {}, options: {} }
  for (const h of f.hooks.context ?? []) await h(event)
  return event
}
