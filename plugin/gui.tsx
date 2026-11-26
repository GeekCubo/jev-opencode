// Desktop GUI part (experimental GUI plugin API, https://opencode.ai/docs/build/plugins/gui).
// Same commands and state as the TUI part, through the same server RPC; built into gui-experimental.cjs.
// Uses only documented registries: Command (palette + `/` menu), toast, dialogs.alert, ComposerPill, Slot.
import { createSignal, onCleanup } from "solid-js"
import { Command, ComposerPill, Plugin, Slot } from "@opencode/plugin/gui"
import { JevRpc, type JevSnapshot } from "./rpc.ts"
import { jevCommandList, shortLabel, sidebarRows, stateTone, healthTone, type UiHost } from "./ui-core.ts"

export default Plugin.define({
  setup(ctx) {
    // Plugin state lives in the server instance of the session's directory, so every call carries that location.
    const directory = () => ctx.sessions.current()?.directory
    const rpc = (dir = directory()) => {
      const client = (ctx.client as any).rpc(JevRpc)
      if (!dir) return client
      const at = { location: { directory: dir } }
      return new Proxy(client, { get: (t, k) => (k === "events" ? t.events : (input: unknown) => t[k](input, at)) })
    }
    const host: UiHost = {
      rpc: () => rpc(),
      sessionID: () => ctx.sessions.current()?.id,
      notify: (message, tone) =>
        void ctx.toast.show({ title: "Jev", description: message, variant: tone === "error" ? "error" : tone === "success" ? "success" : "default" }),
      show: (title, text) => void ctx.dialogs.alert({ title, description: text }),
    }
    for (const c of jevCommandList(host))
      ctx.add(Command, () => ({ id: c.name, title: c.title, group: "Jev", slash: { name: c.name }, run: c.run }))

    // Shared state: one in-memory snapshot per session key, refreshed on the server's `changed` events.
    const [snaps, setSnaps] = createSignal<Record<string, JevSnapshot | undefined>>({})
    const dirs: Record<string, string | undefined> = {}
    const load = (sessionID?: string, dir?: string) =>
      void rpc(dir ?? (sessionID ? dirs[sessionID] : undefined) ?? directory())
        .snapshot({ sessionID })
        .then((s: JevSnapshot) => setSnaps((m) => ({ ...m, [sessionID ?? ""]: s })))
        .catch(() => setSnaps((m) => ({ ...m, [sessionID ?? ""]: undefined })))
    // Refresh the welcome state and every session a pill has shown (keys already in the map).
    const refreshAll = () => {
      const keys = new Set(["", ...Object.keys(snaps())])
      const sid = ctx.sessions.current()?.id
      if (sid) keys.add(sid)
      for (const k of keys) load(k || undefined)
      // Drain a pending health notification for the current session (one toast per transition).
      if (sid)
        void rpc(dirs[sid] ?? directory())
          .drainNotification({ sessionID: sid })
          .then((r: { text: string }) => {
            if (r.text) ctx.toast.show({ title: "Jev", description: r.text, variant: r.text.includes("failed") || r.text.includes("fresh session") ? "error" : "default" })
          })
          .catch(() => {})
    }
    refreshAll()
    let off: (() => void) | undefined
    try {
      off = rpc().events.on("changed", refreshAll)
    } catch {}
    const timer = setInterval(refreshAll, 15_000)

    // Session indicator: a composer pill whose menu lists the sidebar metrics.
    ctx.add(ComposerPill, {
      id: "status",
      show: (input) => {
        dirs[input.session.id] = input.session.directory
        const known = input.session.id in snaps()
        if (!known) queueMicrotask(() => load(input.session.id, input.session.directory))
        const s = snaps()[input.session.id] ?? snaps()[""]
        return {
          label: shortLabel(s),
          tone: healthTone(s?.session?.health?.level) ?? stateTone(s?.state ?? "unreachable"),
          title: "Jev Compaction",
          rows: sidebarRows(s).map(([k, v]) => ({ id: k, label: k, detail: v })),
        }
      },
    })
    // Welcome / any screen: compact status strip at the bottom of the window.
    ctx.add(Slot, {
      at: "window.bottom",
      render: () => (
        <div style={{ "font-size": "11px", opacity: 0.7, padding: "2px 8px", display: "flex", gap: "12px" }}>
          <span>{shortLabel(snaps()[""])}</span>
        </div>
      ),
    })
    onCleanup(() => (clearInterval(timer), off?.()))
  },
})
