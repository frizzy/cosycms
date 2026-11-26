#!/bin/sh
# Restores a backup. The current data is moved aside (data.before-restore-<time>), not deleted.
#   scripts/restore.sh /path/to/cosycms-20261126-031500.tar.gz     a local archive made by backup.sh
#   scripts/restore.sh --offsite [snapshot]                        the off-box copy (default: the latest snapshot; see `restic snapshots`)
set -eu
APP=${APP:-$(cd "$(dirname "$0")/.." && pwd)}; cd "$APP"
if [ "${1:-}" = "--offsite" ]; then
  [ -f .backup.env ] || { echo "no .backup.env: off-box backups aren't set up here (scripts/offsite-setup.sh)" >&2; exit 1; }
  PATH="$HOME/bin:$PATH"; set -a; . ./.backup.env; set +a
  TMP=$(mktemp -d "$APP/.restore.XXXXXX"); trap 'rm -rf "$TMP"' EXIT
  restic restore "${2:-latest}" --tag cosycms --host cosycms --target "$TMP" >/dev/null
  SRC=$(find "$TMP" -type d -name data -path '*/.snapshot/data' | head -1); SRC=${SRC%/data}
  [ -n "$SRC" ] && [ -d "$SRC/data/v3" ] || { echo "that snapshot doesn't look like a cosycms backup" >&2; exit 1; }
  docker compose stop -t 20 >/dev/null
  [ -d data ] && mv data "data.before-restore-$(date +%Y%m%d-%H%M%S)"
  mv "$SRC/data" data; cp -f "$SRC/.dev.vars" .dev.vars
  docker compose start >/dev/null
  echo "restored the off-box snapshot ${2:-latest}"
  exit 0
fi
[ $# -eq 1 ] && [ -f "$1" ] || { echo "usage: $0 <archive.tar.gz> | --offsite [snapshot]" >&2; exit 2; }
ARCHIVE=$(cd "$(dirname "$1")" && pwd)/$(basename "$1")
tar -tzf "$ARCHIVE" | grep -q '^data/v3/' || { echo "that doesn't look like a cosycms backup" >&2; exit 1; }
docker compose stop -t 20 >/dev/null
[ -d data ] && mv data "data.before-restore-$(date +%Y%m%d-%H%M%S)"
tar -xzf "$ARCHIVE"
docker compose start >/dev/null
echo "restored $ARCHIVE"
