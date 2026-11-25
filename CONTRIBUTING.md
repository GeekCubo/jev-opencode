# Contributing

## Setup

```sh
npm ci
npm run typecheck && npm test
```

- Node.js 22.6+.
- The tests use a mocked Jev and never contact TypeSafe.
- `npm run test:live` runs the opt-in live tests. They need `TYPESAFE_API_KEY` and incur small charges.

## Guidelines

- Keep the OpenCode-specific code (`plugin/index.ts`, `tui.tsx`, `gui.tsx`) thin. Put logic in the OpenCode-agnostic modules; see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
- Use only documented OpenCode plugin APIs. No patches to OpenCode internals.
- Add a focused test for every behaviour change. Never commit API keys, transcripts, statistics or personal configuration.
- After changing `gui.tsx`, `ui-core.ts` or `rpc.ts`, run `npm run build:gui` and commit the regenerated bundle.
- Don't claim compatibility with an OpenCode version you haven't tested (see [COMPATIBILITY.md](COMPATIBILITY.md)).

## Upstream attribution

- `plugin/upstream/` is derived from fast-jev-compaction (MIT). Keep its `LICENSE` and record every modification in `plugin/upstream/NOTICE.md`.
- Keep the attribution in `NOTICE` and `README.md`.
