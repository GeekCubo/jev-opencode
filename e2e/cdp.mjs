// Minimal Chrome DevTools Protocol driver for the isolated OpenCode Desktop test (Node 22, no dependencies).
// Usage: node cdp.mjs <port> <script.json>  — script is a list of steps:
//   {"eval": "js"} | {"type": "text"} | {"key": "Enter"|"Escape"} | {"wait": ms} | {"shot": "file.png"}
import { readFileSync, writeFileSync } from "node:fs"

const [port, scriptFile] = process.argv.slice(2)
const steps = JSON.parse(readFileSync(scriptFile, "utf8"))
const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
const page = targets.find((t) => t.type === "page")
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((r) => ws.addEventListener("open", r, { once: true }))
let id = 0
const pending = new Map()
ws.addEventListener("message", (m) => {
  const msg = JSON.parse(m.data)
  if (msg.id && pending.has(msg.id)) pending.get(msg.id)(msg), pending.delete(msg.id)
})
const send = (method, params = {}) => new Promise((r) => (pending.set(++id, r), ws.send(JSON.stringify({ id, method, params }))))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const KEYS = { Enter: { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" }, Escape: { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 } }

for (const s of steps) {
  if (s.eval) {
    const r = await send("Runtime.evaluate", { expression: s.eval, awaitPromise: true, returnByValue: true })
    console.log(JSON.stringify(r.result?.result?.value ?? r.result?.exceptionDetails?.text ?? null))
  } else if (s.type) {
    await send("Input.insertText", { text: s.type })
  } else if (s.key) {
    const k = KEYS[s.key]
    await send("Input.dispatchKeyEvent", { type: "keyDown", ...k })
    await send("Input.dispatchKeyEvent", { type: "keyUp", ...k, text: undefined })
  } else if (s.wait) {
    await sleep(s.wait)
  } else if (s.shot) {
    const r = await send("Page.captureScreenshot", { format: "png" })
    writeFileSync(s.shot, Buffer.from(r.result.data, "base64"))
    console.log(`shot ${s.shot}`)
  }
}
ws.close()
