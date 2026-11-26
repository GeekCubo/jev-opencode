#!/usr/bin/env bash
# Activate a staged Jev plugin package (fixed version: resolves the staged directory
# independently of the CWD, validates versions and runtime files, installs atomically,
# verifies the INSTALLED package (not the staged one), and rolls back on any failure.
#
# Usage: jev-activate.sh <staged-plugin-dir>   (a directory containing the plugin package.json)
set -euo pipefail

die() { echo "ACTIVATION FAILED: $*" >&2; exit 1; }

STAGED="${1:-}"
[ -n "$STAGED" ] || die "usage: $0 <staged-plugin-dir>"
# Resolve to an absolute path regardless of the current working directory.
STAGED="$(cd "$STAGED" 2>/dev/null && pwd)" || die "staged directory not found: $1"
[ -f "$STAGED/package.json" ] || die "no package.json in $STAGED (pass the plugin directory itself)"

TARGET="$HOME/.local/share/opencode-plugins/jev"
OLD="${TARGET}.old"
STAGED_VERSION="$(jq -r .version "$STAGED/package.json")"
[ -n "$STAGED_VERSION" ] && [ "$STAGED_VERSION" != "null" ] || die "staged package has no version"

echo "Staged package: $STAGED (version $STAGED_VERSION)"

# --- Validate required runtime files in the staged artifact -------------------------------
for f in index.ts tui.tsx rpc.ts util.ts setup.ts health.ts jev.ts config.ts compaction.ts \
         ledger-file.ts statistics.ts ui-core.ts dist/gui-experimental.cjs \
         upstream/state.ts upstream/compact.ts upstream/request.ts upstream/types.ts; do
  [ -f "$STAGED/$f" ] || die "staged package is missing required runtime file: $f"
done
echo "Required runtime files: present"

# --- Refuse to clobber an unexpected state ------------------------------------------------
if [ -d "$TARGET.new" ]; then die "leftover $TARGET.new exists; remove it first"; fi

# --- Back up the current installation (unique, never overwritten) -------------------------
if [ -d "$TARGET" ]; then
  STAMP="$(date +%Y%m%d-%H%M%S)"
  BACKUP="$OLD-$STAMP"
  # Never overwrite an existing backup: extend the name until unique (same-second activations).
  for i in 1 2 3 4 5 6 7 8 9; do
    [ -e "$BACKUP" ] || break
    BACKUP="$OLD-$STAMP-$i"
  done
  [ -e "$BACKUP" ] && die "could not find a unique backup name near $OLD-$STAMP"
  cp -a "$TARGET" "$BACKUP"
  echo "Backup created: $BACKUP"
else
  BACKUP=""
  echo "No existing installation at $TARGET (fresh install)."
fi

restore() {
  echo "Rolling back..." >&2
  rm -rf "$TARGET.new"
  if [ -n "$BACKUP" ] && [ -d "$BACKUP" ]; then
    rm -rf "$TARGET"
    cp -a "$BACKUP" "$TARGET"
    echo "Restored the previous installation from $BACKUP" >&2
  fi
}
trap restore ERR

# --- Install: copy to a fresh directory, then SWAP (mv onto a moved-away target) -----------
# The previous defective script ran `mv "$TARGET.new" "$TARGET"` while $TARGET still
# existed, which moved .new INSIDE the old directory. We move the old tree away first.
rm -rf "$TARGET.new"
cp -a "$STAGED" "$TARGET.new"
if [ -d "$TARGET" ]; then
  rm -rf "$TARGET.old-swap"
  mv "$TARGET" "$TARGET.old-swap"
fi
mv "$TARGET.new" "$TARGET"
trap - ERR

# --- Verify the INSTALLED package (not the staged one) -------------------------------------
INSTALLED_VERSION="$(jq -r .version "$TARGET/package.json")"
[ "$INSTALLED_VERSION" = "$STAGED_VERSION" ] || { restore; die "installed version $INSTALLED_VERSION != staged $STAGED_VERSION"; }
for f in dist/gui-experimental.cjs upstream/state.ts index.ts tui.tsx; do
  [ -f "$TARGET/$f" ] || { restore; die "installed package missing $f"; }
done
cmp -s "$STAGED/package.json" "$TARGET/package.json" || { restore; die "installed package.json differs from staged artifact"; }
echo "Verified installed version: $INSTALLED_VERSION"
rm -rf "$TARGET.old-swap"

echo ""
echo "Activated Jev $INSTALLED_VERSION at $TARGET"
[ -n "$BACKUP" ] && echo "Previous installation backed up at: $BACKUP"
echo "OpenCode reloads plugins automatically; run /jev-status in a session to confirm the version."
