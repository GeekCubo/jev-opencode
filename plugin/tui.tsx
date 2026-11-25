/** @jsxImportSource @opentui/solid */
// TUI part: Jev slash commands with normal (non-error) feedback, plus status indicators.
// Documented APIs (https://opencode.ai/docs/build/plugins/cli, /rpc): keymap.layer slash commands, ui.toast,
// ui.dialog.alert, ui.slot (home.footer.status, sidebar.content), client.rpc + RPC events.
// Commands run in the TUI and call the server part over RPC, so they never create a session,
// never send a model request and never add messages to the conversation.
import { createSignal, For, onCleanup } from "solid-js"
import { Plugin } from "@opencode/plugin/tui"
import { JevRpc, type JevSnapshot } from "./rpc.ts"
import { jevCommandList, shortLabel, sidebarRows, type UiHost } from "./ui-core.ts"

type Ctx = Parameters<Parameters<typeof Plugin.define>[0]["setup"]>[0]

export function currentSessionID(ctx: Pick<Ctx, "ui">): string | undefined {
  const route = ctx.ui.router.current()
  return route.type === "session" ? route.sessionID : undefined
}

export function tuiHost(ctx: Pick<Ctx, "ui" | "client" | "location">): UiHost {
  return {
    rpc: () => (ctx.client as any).rpc(JevRpc, ctx.location ? { location: ctx.location } : undefined),
    sessionID: () => currentSessionID(ctx),
    notify: (message, tone) => ctx.ui.toast.show({ title: "Jev", message, variant: tone, duration: 6000 }),
    show: (title, text) => void ctx.ui.dialog.alert({ title, message: text }),
  }
}

export function jevCommands(ctx: Pick<Ctx, "ui" | "client" | "location">) {
  return jevCommandList(tuiHost(ctx)).map((c) => ({
    id: `jev.${c.name.slice(4)}`,
    title: c.title,
    group: "Jev",
    palette: true as const,
    slash: { name: c.name },
    run: c.run,
  }))
}

/** Reactive snapshot for one session ("" = welcome screen). Refreshed on Jev `changed` events and every 15 s. */
function useSnapshot(ctx: Ctx, sessionID: () => string) {
  const [snap, setSnap] = createSignal<JevSnapshot | undefined>()
  const host = tuiHost(ctx)
  const load = () =>
    void host
      .rpc()
      .snapshot({ sessionID: sessionID() || undefined })
      .then((s) => setSnap(s as JevSnapshot))
      .catch(() => setSnap(undefined))
  load()
  let off: (() => void) | undefined
  try {
    off = host.rpc() && (ctx.client as any).rpc(JevRpc).events.on("changed", load)
  } catch {
    off = undefined
  }
  const timer = setInterval(load, 15_000)
  onCleanup(() => (clearInterval(timer), off?.()))
  return snap
}

export default Plugin.define({
  id: "jev-compaction.tui",
  setup(ctx) {
    ctx.keymap.layer(() => ({ mode: "global", commands: jevCommands(ctx) }))

    // Optional indicators: skipped silently where the host lacks slots (capability detection).
    if (typeof ctx.ui.slot !== "function") return
    const theme = ctx.theme
    const toneColor = (state?: JevSnapshot["state"]) =>
      state === "active" || state === "evaluating" ? theme.text.feedback.success.base : state === "budget" ? theme.text.feedback.warning.base : state === "unavailable" || !state ? theme.text.feedback.error.base : theme.text.muted

    ctx.ui.slot({
      append: "home.footer.status",
      render: () => {
        const snap = useSnapshot(ctx, () => "")
        return <text fg={toneColor(snap()?.state)}>{shortLabel(snap())}</text>
      },
    })
    ctx.ui.slot({
      append: "sidebar.content",
      render: (input) => {
        const snap = useSnapshot(ctx, () => input.sessionID)
        return (
          <box flexDirection="column">
            <text fg={theme.text.base}>
              <b>Jev Compaction</b>
            </text>
            <For each={sidebarRows(snap())}>
              {([k, v], i) => (
                <text fg={i() === 0 ? toneColor(snap()?.state) : theme.text.muted}>
                  {k}: {v}
                </text>
              )}
            </For>
          </box>
        )
      },
    })
  },
})
