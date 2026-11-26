# Compatibility

## Versions

| OpenCode | Status |
|---|---|
| 2.2.7 (server, TUI, Desktop) | **Minimum supported.** Tested with the 0.2.x–0.3.0 release candidates: unit tests, isolated TUI under tmux, isolated Desktop app driven through DevTools. The development type definitions are `@opencode/plugin` 2.2.7. |
| 2.4.2 | **Owner-confirmed:** Jev 0.3.0 activated and working in the owner's live OpenCode installation. |
| 2.3.x – 2.4.1 | **Not individually tested.** Expected to work: the plugin interfaces Jev uses are the same in 2.2.7 and 2.4.2. Desktop GUI plugin API is marked experimental. |
| 1.x (`@opencode-ai/plugin`) | **Unsupported.** V2 plugin API only. |

Requirement: **OpenCode v2.2.7+**. Earlier 2.x releases are unsupported. Future releases are expected to work while OpenCode keeps the plugin interfaces Jev uses (the `context` hook, plugin RPC, client slots and commands, and the experimental GUI plugin API); this is not guaranteed.

## Layering

- `plugin/upstream/`: the upstream pruning algorithm (MIT). It has no OpenCode imports.
- `compaction.ts`, `config.ts`, `jev.ts`, `statistics.ts`, `util.ts`: OpenCode-agnostic protection, decisions, budgets, statistics and the Jev client. `jev.ts` implements the upstream `JevAsker` interface; replace it to use another context-evaluation backend.
- `index.ts`: the server adapter (hooks, RPC, events).
- `ui-core.ts`: client-neutral commands and indicator formatting.
- `tui.tsx`, `gui.tsx`: thin client adapters.

## Local state

- Accounting uses a lock file on the local filesystem (`$XDG_STATE_HOME/opencode-jev/`).
- Tested on Linux with Node's `fs` under OpenCode 2.2.7's runtime.
- Network filesystems are unsupported.

## Capability handling

- **Server:** if `session.hook("context")` is missing or throws, Jev logs one warning, reports `Unavailable` and leaves requests untouched. Native compaction is unaffected. Optional hooks (`compaction`, `generate`) and the agent transform are skipped individually.
- **TUI:** indicators are only registered when `ui.slot` exists. Commands use the documented keymap layer.
- **Desktop:** the GUI part is loaded only through the `gui-experimental` export. If the host rejects it, the server and TUI still work.

## Checking a new OpenCode release (do not upgrade the main install)

1. Install the new version in a scratch prefix, or use an isolated `HOME`/`XDG_*` with its binary.
2. `npm i -D @opencode/plugin@<version>` in this directory, then run `npm run typecheck` and `npm test`.
3. `npm run build:gui`.
4. Run an isolated TUI with the mock server (`e2e/mock-server.mjs`). Check that `/jev-status` opens a dialog without errors, that the footer and sidebar show Jev, and that one mock session gets pruned.
5. Run the isolated Desktop app with `--remote-debugging-port`, then use `e2e/cdp.mjs` to run the seven commands and capture screenshots.
6. Update the table above only with what was actually tested.

