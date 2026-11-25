# Installation

Requires OpenCode 2.2.7, Git, and a TypeSafe API key (or an OpenCode Zen account; see the README). Node.js 22.6+ is needed only for development and the CLI statistics reader.

## Install

1. Clone the repository outside `~/.config/opencode/plugins/` (that directory auto-loads plugins):

   ```sh
   git clone https://github.com/GeekCubo/jev-opencode.git ~/.local/share/opencode-plugins/jev-opencode
   ```

2. Store the key with owner-only permissions:

   ```sh
   umask 077
   printf '%s' 'YOUR_TYPESAFE_KEY' > ~/.config/opencode/typesafe-api-key
   ```

   Alternatively, set `TYPESAFE_API_KEY` in the environment of the OpenCode service.

3. Back up `~/.config/opencode/opencode.jsonc`, then add one entry to `plugins` (create the array if it doesn't exist; keep all other settings):

   ```jsonc
   "plugins": [
     { "package": "/home/YOUR_USER/.local/share/opencode-plugins/jev-opencode/plugin",
       "options": { "mode": "dry-run" } }
   ]
   ```

   Use the **global** config, since OpenCode Desktop loads GUI parts from the global config only. Use an absolute path.

4. Config changes apply automatically. Run `/reload` in open TUIs, or reopen the Desktop window. Then run `/jev-status`; it should show `mode=dry-run`.

No `npm install` is needed to run the plugin. The server and TUI parts are TypeScript loaded by OpenCode, which supplies `@opencode/plugin`, `solid-js` and `@opentui/*` at runtime. The Desktop part is the prebuilt `plugin/dist/gui-experimental.cjs`. This was verified with a fresh clone that had no `node_modules`, on OpenCode 2.2.7.

## Build from source (optional)

```sh
npm ci                 # dev dependencies (legacy peer deps, see .npmrc)
npm run typecheck
npm test
npm run build:gui      # regenerates plugin/dist/gui-experimental.cjs
```

## Upgrade

```sh
cd ~/.local/share/opencode-plugins/jev-opencode && git pull
```

Then run `/reload` in TUIs and reopen Desktop windows. The mode, statistics and spend are kept. In-memory pruning decisions are cleared, so full context returns until the next evaluation.

## Disable, rollback and remove

- **Pause:** `/jev-disable`. This is persistent and applies to all sessions.
- **Unload:** remove the plugin entry from `opencode.jsonc`, or restore your backup of that file.
- **Remove files:**
  ```sh
  rm -rf ~/.local/share/opencode-plugins/jev-opencode ~/.local/state/opencode-jev ~/.config/opencode/typesafe-api-key
  ```

None of this touches conversations, projects, provider credentials or other plugins.
