#!/bin/sh
# Prepares one isolated OpenCode instance for an A/B group (no requests are sent).
# Usage: benchmarks/setup-instance.sh <A|B> <workdir> <owner opencode.jsonc> <port>
#   A = Jev off for this instance; B = Jev active. Everything else is copied unchanged from the owner config.
set -eu
GROUP=$1 WORK=$2 SRC=$3 PORT=$4
ROOT="$WORK/$GROUP"
mkdir -p -m 700 "$ROOT/config/opencode" "$ROOT/state" "$ROOT/data" "$ROOT/cache"
MODE=$([ "$GROUP" = A ] && echo off || echo active)
node -e '
const fs = require("fs"); const [src, out, mode] = process.argv.slice(1)
const c = JSON.parse(fs.readFileSync(src, "utf8").replace(/^\s*\/\/.*$/mg, ""))
c.plugins = (c.plugins ?? []).map((p) => typeof p === "object" && /opencode-plugins\/jev/.test(p.package) ? { ...p, options: { ...p.options, mode } } : p)
fs.writeFileSync(out, JSON.stringify(c, null, 2), { mode: 0o600 })' "$SRC" "$ROOT/config/opencode/opencode.jsonc" "$MODE"
for f in AGENTS.md typesafe-api-key; do [ -e "$HOME/.config/opencode/$f" ] && cp -p "$HOME/.config/opencode/$f" "$ROOT/config/opencode/"; done
[ -d "$HOME/.config/opencode/agents" ] && cp -rp "$HOME/.config/opencode/agents" "$ROOT/config/opencode/"
cat > "$ROOT/env.sh" <<ENV
export XDG_CONFIG_HOME="$ROOT/config" XDG_STATE_HOME="$ROOT/state" XDG_DATA_HOME="$ROOT/data" XDG_CACHE_HOME="$ROOT/cache"
ENV
. "$ROOT/env.sh"
[ "${JEV_AB_DRY:-}" = 1 ] || opencode service set port "$PORT" >/dev/null
echo "group $GROUP: config $ROOT/config/opencode/opencode.jsonc (Jev mode=$MODE), port $PORT"
echo "start:  . $ROOT/env.sh && opencode service start"
