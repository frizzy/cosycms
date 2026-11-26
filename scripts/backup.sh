#!/bin/sh
# Backs up a Docker install (see compose.yaml): the database, uploaded images and .dev.vars (it holds SETTINGS_KEY, without which the saved GitHub token can't be read).
# The app is stopped for a few seconds so the database files are consistent. Keeps the newest KEEP archives.
#   scripts/backup.sh                 BACKUP_DIR (default ../cosycms-backups next to the app) and KEEP (default 14) can be set
#   crontab: 15 3 * * * /path/to/cosycms/scripts/backup.sh >> /path/to/cosycms-backups/backup.log 2>&1
set -eu
APP=${APP:-$(cd "$(dirname "$0")/.." && pwd)}
DEST=${BACKUP_DIR:-$APP/../cosycms-backups}; KEEP=${KEEP:-14}
umask 077 # the archive contains secrets
mkdir -p "$DEST"; cd "$APP"
FILE="$DEST/cosycms-$(date +%Y%m%d-%H%M%S).tar.gz"
docker compose stop -t 20 >/dev/null
trap 'docker compose start >/dev/null' EXIT
tar -czf "$FILE.part" data .dev.vars && mv "$FILE.part" "$FILE"
ls -1t "$DEST"/cosycms-*.tar.gz | tail -n +$((KEEP + 1)) | xargs -r rm -f --
echo "$(date -Iseconds) $FILE $(du -h "$FILE" | cut -f1)"
