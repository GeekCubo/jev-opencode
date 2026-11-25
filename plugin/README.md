# plugin/

The OpenCode plugin package. Point the `package` of your `plugins` entry at this directory.

- `index.ts`: the server part. Uses the `context`, `compaction` and `generate` hooks; RPC; events; an optional agent transform.
- `tui.tsx`, `dist/gui-experimental.cjs` (built from `gui.tsx`): the TUI and Desktop parts, which provide the seven `/jev-*` commands and the status indicators.
- `rpc.ts`: the typed contract shared by the parts.
- `upstream/`: code adapted from fast-jev-compaction (MIT); see `upstream/NOTICE.md`.

The `serverCommands: true` option additionally registers server-side commands for clients without the TUI or Desktop part. Their output is delivered through OpenCode's error path, so those clients show it as an error notice. It is off by default and not recommended.

Usage, configuration, privacy and troubleshooting are covered in the repository [README](../README.md). Architecture is in [docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md).
