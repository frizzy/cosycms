#!/bin/sh
# Runs a destination test the owner asked for in Settings > Backups: writes a small file to the off-server destination, reads it back,
# removes it, and reports. Called every minute from tick.sh; with nothing queued it costs one request and exits.
APP=${APP:-$(cd "$(dirname "$0")/.." && pwd)}
URL=${APP_URL:-https://localhost:${PORT:-8787}}
. "$APP/scripts/backup-lib.sh"
load_destination
[ "$COSY_TEST" = 1 ] || exit 0

report() { # ok detail
  DETAIL=$(printf %s "$2" | tr -d '\000-\037"\\' | cut -c1-300)
  curl -fsSk -m 20 -o /dev/null -X POST -H "Authorization: Bearer $TOKEN" -H "content-type: application/json" -d "{\"ok\":$1,\"detail\":\"$DETAIL\"}" "$URL/api/backup/test-result" || true
}
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
STEP="preparing"
fail() { report false "Failed while $STEP: $(tail -n 1 "$TMP/log" 2>/dev/null)"; exit 0; }
step() { STEP=$1; shift; "$@" >"$TMP/log" 2>&1 || fail; } # runs in this shell, so restic's settings carry over

opened() { rc cat config || rc init; }
wrote() { mkdir -p "$TMP/in"; echo "cosycms connection test $(date -Iseconds)" > "$TMP/in/test.txt"; rc backup --quiet --tag connection-test --host cosycms-test "$TMP/in"; }
readback() { rc restore latest --tag connection-test --host cosycms-test --target "$TMP/out" && cmp "$TMP/in/test.txt" "$TMP/out$TMP/in/test.txt"; }
removed() {
  IDS=$(rc snapshots --compact --tag connection-test --host cosycms-test | awk 'length($1)==8 && $1 ~ /^[0-9a-f]+$/ {print $1}')
  [ -z "$IDS" ] || rc forget --prune $IDS
}

step "setting up restic" use_destination
step "opening the destination" opened
step "writing a test file" wrote
step "reading it back" readback
step "removing the test file" removed
report true "Wrote, read back and removed a test file ($(restic version | cut -d' ' -f1-2))."
