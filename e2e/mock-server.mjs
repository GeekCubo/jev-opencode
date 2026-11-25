// Mock OpenAI-compatible provider + mock Jev System One endpoint, localhost only.
import http from "node:http"
import fs from "node:fs"

const port = Number(process.env.PORT ?? 18555)
const log = process.env.LOG ?? "/tmp/opencode/jev-e2e/requests.jsonl"
const STEPS = Number(process.env.STEPS ?? 10)

const sse = (res, chunks) => {
  res.writeHead(200, { "content-type": "text/event-stream" })
  for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\n\n`)
  res.end("data: [DONE]\n\n")
}
const chunk = (delta, finish = null, usage) => ({ id: "c", object: "chat.completion.chunk", created: 0, model: "mock", choices: [{ index: 0, delta, finish_reason: finish }], ...(usage ? { usage } : {}) })

http.createServer((req, res) => {
  let body = ""
  req.on("data", (d) => (body += d))
  req.on("end", () => {
    const json = body ? JSON.parse(body) : {}
    if (req.url.endsWith("/systemone")) {
      const answers = {}
      for (const [name, q] of Object.entries(json.questions)) {
        const tool = /\((\w+)/.exec(q.instructions)?.[1]
        answers[name] = { type: "noul", noul: tool === "read" ? (name.startsWith("call_") ? 0.2 : 0.1) : 0.9 }
      }
      fs.appendFileSync(log, JSON.stringify({ kind: "jev", auth: req.headers.authorization === "Bearer e2e-test-key", bytes: body.length, questions: Object.keys(json.questions).length, model: json.model }) + "\n")
      res.writeHead(200, { "content-type": "application/json" })
      return res.end(JSON.stringify({ model: "jev-1.14.0", answers, usage: { input_tokens: Math.ceil(body.length / 4), output_tokens: 1 } }))
    }
    if (req.url.endsWith("/chat/completions")) {
      const msgs = json.messages ?? []
      // Scripted tool calls for permission/delegation tests: prompt contains SCRIPT:{"name":..,"args":{..}}
      const allText = JSON.stringify(msgs)
      const sys = JSON.stringify(msgs.filter((m) => m.role === "system"))
      const script = /SCRIPT:(\{.*?\}\})/.exec(allText.replace(/\\"/g, '"'))
      const isBuilder = sys.includes("You are Builder"), isReviewer = sys.includes("You are Reviewer")
      const lastIsTool = msgs.at(-1)?.role === "tool"
      fs.appendFileSync(log, JSON.stringify({ kind: "llm", model: json.model, agent: isBuilder ? "builder" : isReviewer ? "reviewer" : "other", tools: (json.tools ?? []).map((t) => t.function?.name).sort(), lastTool: lastIsTool ? String(msgs.at(-1).content).slice(0, 300) : null }) + "\n")
      const usage0 = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
      if (process.env.SCRIPTED) {
        if (lastIsTool || !json.tools) return sse(res, [chunk({ role: "assistant", content: "Done." }), chunk({}, "stop", usage0)])
        const pick = isBuilder ? process.env.BUILDER_CALL : isReviewer ? process.env.REVIEWER_CALL : script?.[1]
        if (!pick) return sse(res, [chunk({ role: "assistant", content: "Done." }), chunk({}, "stop", usage0)])
        const call = JSON.parse(pick)
        return sse(res, [chunk({ role: "assistant", tool_calls: [{ index: 0, id: `call_${Date.now()}_${Math.random().toString(36).slice(2)}`, type: "function", function: { name: call.name, arguments: JSON.stringify(call.args) } }] }), chunk({}, "tool_calls", usage0)])
      }
      const toolMsgs = msgs.filter((m) => m.role === "assistant" && /Reading file/.test(JSON.stringify(m.content))).length
      const lastUser = [...msgs].reverse().find((m) => m.role === "user")
      const isSummary = JSON.stringify(lastUser ?? "").includes("summar")
      fs.appendFileSync(log, JSON.stringify({ kind: "llm", model: json.model, bytes: body.length, messages: msgs.length, toolMsgs, isSummary, sysChars: JSON.stringify(msgs.filter((m) => m.role === "system")).length }) + "\n")
      // OVERHEAD simulates provider-side tokens the plugin cannot see (system prompt, tool schemas), served from cache.
      const overhead = Number(process.env.OVERHEAD ?? 0)
      const prompt = Math.ceil(body.length / 4) + overhead
      const usage = { prompt_tokens: prompt, completion_tokens: 5, total_tokens: prompt + 5, ...(overhead ? { prompt_tokens_details: { cached_tokens: overhead } } : {}) }
      if (isSummary || toolMsgs >= STEPS || json.tools === undefined)
        return sse(res, [chunk({ role: "assistant", content: isSummary ? "## Objective\nmock summary" : "Done." }), chunk({}, "stop", usage)])
      const i = toolMsgs
      return sse(res, [
        chunk({ role: "assistant", content: `Reading file ${i}.`, tool_calls: [{ index: 0, id: `call_${i}_${Date.now()}`, type: "function", function: { name: "read", arguments: JSON.stringify({ path: `big${i % 5}.txt` }) } }] }),
        chunk({}, "tool_calls", usage),
      ])
    }
    res.writeHead(404).end()
  })
}).listen(port, "127.0.0.1", () => console.log(`mock on ${port}`))
