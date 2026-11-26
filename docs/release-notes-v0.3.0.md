# Jev Compaction for OpenCode — v0.3.0

Context optimization, session health and optional agent configuration for [OpenCode](https://opencode.ai), using [TypeSafe](https://typesafe.ai)'s Jev evaluation model.

**Requires OpenCode v2.2.7+.** Owner-confirmed working on OpenCode v2.4.2.

## Install (npm)

**npm:** https://www.npmjs.com/package/jev-compaction

```jsonc
// ~/.config/opencode/opencode.jsonc
{
  "plugins": [
    { "package": "jev-compaction", "options": { "mode": "dry-run" } }
  ]
}
```

Or pinned: `"jev-compaction@0.3.0"`. On OpenCode v2.4.2+ you can also run `opencode plugin add jev-compaction`. No clone, no build, no separate service.

## What's in this release

- **Bounded-window relevance evaluation.** Long sessions whose evaluation history exceeds the Jev state limit are now evaluated incrementally through a bounded window — oldest candidates first, guaranteed forward progress, no starvation — instead of permanently failing to native compaction.
- **Improved context protection.** Protected tool calls, recent messages, first message and goal are always kept in the evaluation state and never pruned; windowed-out candidates are retained by default (never dropped without being asked).
- **Budget and retry accounting.** Per-attempt reservations (retries re-reserve), measured usage only from successful responses, conservative local spending limits clearly documented as estimates — not guaranteed provider-side billing ceilings.
- **Partial-failure recovery.** A failed evaluation (including partial batch failure) applies nothing; undecided candidates stay eligible and are re-evaluated once the endpoint heals. Fail-open everywhere.
- **Session health and handover.** Local, request-free health levels (Healthy / Growing / Compaction recommended / New session recommended) with adaptive thresholds, non-blocking deduplicated notifications, `/jev-health` and `/jev-handover`.
- **Optional provider-independent multi-agent configuration.** `/jev-setup`: deterministic local recommendations (capabilities and known pricing only), quality/balanced/economy presets, custom overrides, single- and mixed-provider support, preview → explicit approval → backup → atomic write. Default: keep your existing configuration.
- **JSONC-preserving configuration updates.** `/jev-setup` edits `opencode.jsonc` in place: comments, trailing commas, formatting, custom agents, credentials and unrelated settings stay byte for byte; every edit is verified before writing; invalid files are refused untouched.
- **Corrected activation and rollback.** `scripts/jev-activate.sh` installs by validated swap, verifies the installed version and file integrity, never overwrites backups, and rolls back on failure.

## Known limitations

- Real-world cost savings are unmeasured; estimated reductions are evaluation-snapshot figures, not billing evidence.
- Jev evaluation is a remote, separately billed service (TypeSafe Direct or OpenCode Zen) — the plugin is not entirely local.
- Compatibility with future OpenCode releases depends on the plugin interfaces Jev uses staying compatible.
- The local budget is an estimate; providers may bill failed requests they never report usage for.

## Attribution

OpenCode port of [fast-jev-compaction](https://github.com/tamaratran/fast-jev-compaction) (MIT, by `tamaratran`), maintained by [GeekCubo](https://geekcubo.com). Not affiliated with or endorsed by TypeSafe, the upstream author or the OpenCode project.
