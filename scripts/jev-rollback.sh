#!/usr/bin/env bash
# Roll back to a specific backed-up Jev plugin installation.
# Usage: jev-rollback.sh [backup-dir]
#   Without an argument, uses the newest ~/.local/share/opencode-plugins/jev.old-* backup.
set -euo pipefail

die() { echo "ROLLBACK FAILED: $*" >&2; exit 1; }

TARGET="$HOME/.local/share/opencode-plugins/jev"
BACKUP="${1:-}"

if [ -z "$BACKUP" ]; then
  BACKUP="$(ls -dt "$TARGET".old-* 2>/dev/null | head -1 || true)"
  [ -n "$BACKUP" ] && [ -d "$BACKUP" ] || die "no backup found ($TARGET.old-*); pass a backup directory explicitly"
fi
[ -d "$BACKUP" ] || die "backup directory not found: $BACKUP"
[ -f "$BACKUP/package.json" ] || die "backup has no package.json: $BACKUP"

BACKUP_VERSION="$(jq -r .version "$BACKUP/package.json")"
echo "Rolling back to: $BACKUP (version $BACKUP_VERSION)"

if [ -d "$TARGET" ]; then
  STAMP="$(date +%Y%m%d-%H%M%S)"
  SAFETY="$TARGET.pre-rollback-$STAMP"
  cp -a "$TARGET" "$SAFETY"
  echo "Current installation saved to: $SAFETY"
fi
rm -rf "$TARGET.new"
cp -a "$BACKUP" "$TARGET.new"
rm -rf "$TARGET"
mv "$TARGET.new" "$TARGET"

INSTALLED="$(jq -r .version "$TARGET/package.json")"
[ "$INSTALLED" = "$BACKUP_VERSION" ] || die "rollback verification failed: installed $INSTALLED != backup $BACKUP_VERSION"
echo "Rolled back to Jev $INSTALLED at $TARGET"
