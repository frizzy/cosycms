#!/bin/sh
# Restores a backup. The current data is moved aside (data.before-restore-<time>), not deleted.
#   scripts/restore.sh /path/to/cosycms-20261127-031500.tar.gz     a local archive made by backup.sh
#   scripts/restore.sh --offsite [snapshot]                        the off-server copy (default: the latest snapshot; see `restic snapshots`)
#   scripts/restore.sh --check [snapshot]                          tries the off-server copy in a scratch folder and checks it; changes nothing
# Where the off-server copy is comes from the app's Settings > Backups. If the app is down, the last destination it gave is used; on a new
# machine with nothing set up, export what restic needs first (RESTIC_REPOSITORY, RESTIC_PASSWORD and the provider keys, for R2
# AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY and AWS_DEFAULT_REGION=auto) and the same commands work.
set -eu
APP=${APP:-$(cd "$(dirname "$0")/.." && pwd)}; cd "$APP"
URL=${APP_URL:-https://localhost:${PORT:-8787}}

case "${1:-}" in --offsite|--check)
  MODE=$1; SNAP=${2:-latest}
  . "$APP/scripts/backup-lib.sh"
  if [ -n "${RESTIC_REPOSITORY:-}" ]; then COSY_DEST=file; else load_destination; fi
  [ "$COSY_DEST" != none ] || { echo "no off-server destination: set one in Settings > Backups, or export RESTIC_REPOSITORY and the keys restic needs" >&2; exit 1; }
  if [ "$COSY_DEST" = file ]; then ensure_restic; else use_destination; fi
  TMP=$(mktemp -d "$APP/.restore.XXXXXX"); trap 'rm -rf "$TMP"' EXIT
  rc restore "$SNAP" --tag cosycms --host cosycms --target "$TMP" >/dev/null
  SRC=$(find "$TMP" -type d -name data -path '*/.snapshot/data' | head -1); SRC=${SRC%/data}
  [ -n "$SRC" ] && [ -d "$SRC/data/v3" ] || { echo "that snapshot doesn't look like a cosycms backup" >&2; exit 1; }
  if [ "$MODE" = --check ]; then
    FILES=$(find "$SRC/data" -type f | wc -l | tr -d ' '); SIZE=$(du -sh "$SRC/data" | cut -f1)
    [ -f "$SRC/.dev.vars" ] && grep -q '^SETTINGS_KEY=' "$SRC/.dev.vars" || { echo "the snapshot has no .dev.vars with SETTINGS_KEY, so the saved secrets couldn't be read" >&2; exit 1; }
    DB=$(find "$SRC/data/v3/d1" -name '*.sqlite' ! -name metadata.sqlite | head -1)
    [ -n "$DB" ] || { echo "the snapshot has no database" >&2; exit 1; }
    if command -v python3 >/dev/null; then
      python3 - "$DB" <<'PY' || { echo "the database in the snapshot failed its integrity check" >&2; exit 1; }
import sqlite3, sys
c = sqlite3.connect(sys.argv[1])
ok = c.execute("pragma integrity_check").fetchone()[0]
if ok != "ok": sys.exit(1)
n = lambda t: c.execute(f"select count(*) from {t}").fetchone()[0]
print(f"database: integrity ok, {n('entries')} entries, {n('users')} people")
PY
    else echo "database: not opened (python3 isn't installed here), files only"; fi
    rc snapshots --compact --tag cosycms --host cosycms | grep -E '^[0-9a-f]{8} ' | tail -1 | cut -c1-70
    echo "OK: $SNAP snapshot restored to a scratch folder: $FILES files, $SIZE. Nothing on this server was changed."
    exit 0
  fi
  docker compose stop -t 20 >/dev/null
  [ -d data ] && mv data "data.before-restore-$(date +%Y%m%d-%H%M%S)"
  mv "$SRC/data" data; cp -f "$SRC/.dev.vars" .dev.vars
  docker compose start >/dev/null
  echo "restored the off-server snapshot $SNAP"
  exit 0;;
esac
[ $# -eq 1 ] && [ -f "$1" ] || { echo "usage: $0 <archive.tar.gz> | --offsite [snapshot] | --check [snapshot]" >&2; exit 2; }
ARCHIVE=$(cd "$(dirname "$1")" && pwd)/$(basename "$1")
tar -tzf "$ARCHIVE" | grep -q '^data/v3/' || { echo "that doesn't look like a cosycms backup" >&2; exit 1; }
docker compose stop -t 20 >/dev/null
[ -d data ] && mv data "data.before-restore-$(date +%Y%m%d-%H%M%S)"
tar -xzf "$ARCHIVE"
docker compose start >/dev/null
echo "restored $ARCHIVE"
