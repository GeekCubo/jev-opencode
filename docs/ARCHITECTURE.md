# Architecture

```
OpenCode server ── plugin/index.ts (server part) ──────────────┐
   context hook → compaction.ts (protection, decisions,          │ RPC (plugin/rpc.ts):
                  integrity) → upstream/ (pruning algorithm)     │ status, stats, snapshot,
                  → jev.ts (evaluation backend: TypeSafe/Zen)   │ setMode, reset, compact;
   statistics.ts (counters, shared spend ledger), config.ts      │ "changed" event
                                                                 │
TUI  ── plugin/tui.tsx ─┐                                        │
Desktop ── plugin/gui.tsx (→ dist/gui-experimental.cjs) ─┴─ ui-core.ts (commands, labels) ─┘
```

- **`upstream/`**: the fast-jev-compaction algorithm. It projects history, fits the state into a request budget, asks keep/drop questions, and applies decisions. No OpenCode imports.
- **`compaction.ts`**: maps OpenCode messages to the upstream model and back. Adds protection rules and the tool-call/result integrity check. No OpenCode imports beyond structural types.
- **`jev.ts`**: the evaluation backend. It implements the upstream `JevAsker` interface (`ask(state, questions)`), plus credential lookup, timeouts, retries, usage reporting and redaction of outgoing state. **To use a different context-evaluation model, implement `JevAsker` and construct it in `index.ts`.** Nothing else needs to change.
- **`statistics.ts`**: counters, and `Ledger`, which accumulates spend and counters in shared plugin storage with read-modify-write.
- **`config.ts`**: options, validation, prices and thresholds.
- **`index.ts`**: the only server code that touches OpenCode APIs. Hooks, RPC, events, capability detection, cooldown and growth gates, budgets.
- **`ui-core.ts`**: client-neutral commands and indicator text.
- **`tui.tsx` and `gui.tsx`**: thin adapters for each client's toast, dialog and slot APIs.

Pruning decisions are held in memory per session. Mode, counters and spend are persisted.
