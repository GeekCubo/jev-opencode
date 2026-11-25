# Compatibility

## Versions

| OpenCode | Status |
|---|---|
| 2.2.7 (server, TUI, Desktop) | **Tested**: unit tests, isolated TUI under tmux, isolated Desktop app driven through DevTools |
| 2.3.x – 2.4.x | **Untested.** Expected to work if the documented `context` hook, plugin RPC and client slot/command APIs are unchanged. Desktop GUI plugin API is marked experimental. |
| 1.x (`@opencode-ai/plugin`) | **Unsupported.** V2 plugin API only. |

Minimum tested: 2.2.7. Earlier 2.x releases are untested. Do not assume newer versions work until the check below passes.

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

## 2.4.1

Not installed, not tested, and its changelog has not been reviewed. Status: **unverified**. Run the check above in isolation before upgrading.
