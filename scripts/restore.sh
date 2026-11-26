#!/bin/sh
# Restores an archive made by backup.sh. The current data is moved aside (data.before-restore-<time>), not deleted.
#   scripts/restore.sh /path/to/cosycms-20261126-031500.tar.gz
set -eu
[ $# -eq 1 ] && [ -f "$1" ] || { echo "usage: $0 <archive.tar.gz>" >&2; exit 2; }
ARCHIVE=$(cd "$(dirname "$1")" && pwd)/$(basename "$1")
APP=${APP:-$(cd "$(dirname "$0")/.." && pwd)}; cd "$APP"
tar -tzf "$ARCHIVE" | grep -q '^data/v3/' || { echo "that doesn't look like a cosycms backup" >&2; exit 1; }
docker compose stop -t 20 >/dev/null
[ -d data ] && mv data "data.before-restore-$(date +%Y%m%d-%H%M%S)"
tar -xzf "$ARCHIVE"
docker compose start >/dev/null
echo "restored $ARCHIVE"
