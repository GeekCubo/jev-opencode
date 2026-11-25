# Upstream code

Files in this directory are copied from
https://github.com/tamaratran/fast-jev-compaction at commit
`e3f262a7f4d42bd8dd32ced30d26176f7cb545b0` (`src/types.ts`, `src/state.ts`,
`src/compact.ts`, `src/request.ts`), MIT licensed (see `LICENSE`).

Local modifications (OpenCode port):

- `types.ts`: added optional `CompactOptions.isProtected`.
- `compact.ts`: `compact()` pins calls for which `isProtected` returns true;
  `truncatedResultText` is exported.
- Relative import specifiers changed from `./x.js` to `./x.ts` so OpenCode loads the sources directly.

Everything else is verbatim.
