#!/bin/sh
# Backs up a Docker install (see compose.yaml): the database, uploaded images and .dev.vars (it holds SETTINGS_KEY, without which the saved GitHub token can't be read).
# The app is stopped for a few seconds so the database files are consistent. Keeps the newest KEEP local archives.
# If .backup.env exists (scripts/offsite-setup.sh creates it), an encrypted copy also goes off the machine with restic.
# The result is reported to the app (Settings > Backups; a failure, or no report for a day and a half, shows up in Notifications).
#   scripts/backup.sh                 BACKUP_DIR (default ../cosycms-backups next to the app) and KEEP (default 14) can be set
#   crontab: 15 3 * * * /path/to/cosycms/scripts/backup.sh >> /path/to/cosycms-backups/backup.log 2>&1
set -eu
APP=${APP:-$(cd "$(dirname "$0")/.." && pwd)}
DEST=${BACKUP_DIR:-$APP/../cosycms-backups}; KEEP=${KEEP:-14}
umask 077 # the archive contains secrets
mkdir -p "$DEST"; cd "$APP"
FILE="$DEST/cosycms-$(date +%Y%m%d-%H%M%S).tar.gz"
SNAP="$DEST/.snapshot" # the same path every night, so restic can tell what changed
URL=${APP_URL:-https://localhost:${PORT:-8787}} # where the app answers on this machine
STEP="stopping the app"; STOPPED=0; DETAIL=""

# However this ends: restart the app, tidy up, and tell the app how it went.
finish() {
  rc=$?
  [ $STOPPED = 1 ] && docker compose start >/dev/null 2>&1
  rm -rf "$SNAP"
  TOKEN=$(sed -n 's/^TICK_TOKEN=//p' .dev.vars 2>/dev/null || true)
  if [ -n "$TOKEN" ]; then
    for _ in $(seq 1 30); do curl -sk -o /dev/null -m 3 "$URL/api/auth" && break; sleep 2; done
    if [ $rc = 0 ]; then BODY="{\"ok\":true,\"detail\":\"$DETAIL\"}"; else BODY="{\"ok\":false,\"detail\":\"Failed while $STEP (exit code $rc).\"}"; fi
    curl -sk -m 20 -o /dev/null -X POST -H "Authorization: Bearer $TOKEN" -H "content-type: application/json" -d "$BODY" "$URL/api/backup/report" || true
  fi
  exit $rc
}
trap finish EXIT

docker compose stop -t 20 >/dev/null; STOPPED=1
STEP="writing the local archive"
tar -czf "$FILE.part" data .dev.vars && mv "$FILE.part" "$FILE"
OFFSITE=0; [ -f .backup.env ] && OFFSITE=1
if [ $OFFSITE = 1 ]; then STEP="copying the data for the off-box upload"; rm -rf "$SNAP"; mkdir "$SNAP"; cp -a data .dev.vars "$SNAP"/; fi
STEP="restarting the app"; docker compose start >/dev/null; STOPPED=0
ls -1t "$DEST"/cosycms-*.tar.gz | tail -n +$((KEEP + 1)) | xargs -r rm -f --
DETAIL="$(du -h "$FILE" | cut -f1) archive on this machine"

if [ $OFFSITE = 1 ]; then
  STEP="the off-box upload"
  PATH="$HOME/bin:$PATH"; set -a; . ./.backup.env; set +a
  restic backup --quiet --tag cosycms --host cosycms "$SNAP"
  STEP="thinning old off-box snapshots"
  restic forget --quiet --tag cosycms --host cosycms --keep-daily 14 --keep-weekly 8 --keep-monthly 12 --prune
  DETAIL="$DETAIL; off-box: $(restic snapshots --compact --tag cosycms --host cosycms 2>/dev/null | tail -1)"
fi
echo "$(date -Iseconds) $FILE $DETAIL"
