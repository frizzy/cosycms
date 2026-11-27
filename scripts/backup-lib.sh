#!/bin/sh
# Shared by backup.sh and backup-test.sh (sourced, not run). Needs APP and URL set.
# The off-server destination is chosen in the admin (Settings > Backups). load_destination asks the app for it and sets what restic needs;
# `rc` is restic with the extra ssh options when the destination is an ssh server. Without a destination from the app, a .backup.env made by
# offsite-setup.sh is used if there is one.
PATH="$HOME/bin:$PATH"
SFTP_ARGS=""

ensure_restic() {
  PATH="$HOME/bin:$PATH" command -v restic >/dev/null && return 0
  RESTIC_VERSION=${RESTIC_VERSION:-0.20.0}
  case $(uname -m) in aarch64|arm64) ARCH=arm64;; x86_64) ARCH=amd64;; *) echo "no restic build chosen for $(uname -m); install restic yourself" >&2; return 1;; esac
  TMP=$(mktemp -d); BASE=https://github.com/restic/restic/releases/download/v$RESTIC_VERSION; FILE=restic_${RESTIC_VERSION}_linux_$ARCH.bz2
  curl -fsSL "$BASE/$FILE" -o "$TMP/$FILE" && curl -fsSL "$BASE/SHA256SUMS" -o "$TMP/SHA256SUMS" || { rm -rf "$TMP"; return 1; }
  (cd "$TMP" && grep " $FILE\$" SHA256SUMS | sha256sum -c - >/dev/null) || { echo "restic download failed its checksum" >&2; rm -rf "$TMP"; return 1; }
  mkdir -p "$HOME/bin"; bzip2 -dc "$TMP/$FILE" > "$HOME/bin/restic"; chmod 755 "$HOME/bin/restic"; rm -rf "$TMP"
}

# A key of its own for the backup server, made once. The app shows its public half so the owner can allow it on the destination.
ensure_ssh_key() {
  KEY="$HOME/.ssh/cosycms_backup"
  mkdir -p "$HOME/.ssh"; chmod 700 "$HOME/.ssh"
  [ -f "$KEY" ] || ssh-keygen -q -t ed25519 -N "" -C "cosycms-backup@$(hostname)" -f "$KEY" || return 1
  PUB=$(cut -d' ' -f1,2 "$KEY.pub")
  curl -fsSk -m 20 -o /dev/null -X POST -H "Authorization: Bearer $TOKEN" -H "content-type: application/json" -d "{\"key\":\"$PUB cosycms-backup\"}" "$URL/api/backup/pubkey" || true
}

# Sets COSY_DEST (none | r2 | ssh) and COSY_TEST from the app; returns 1 when the app can't be asked.
load_destination() {
  TOKEN=$(sed -n 's/^TICK_TOKEN=//p' "$APP/.dev.vars" 2>/dev/null || true)
  COSY_DEST=none; COSY_TEST=0
  if [ -n "$TOKEN" ]; then
    JOB=$(curl -fsSk -m 20 -H "Authorization: Bearer $TOKEN" "$URL/api/backup/job" 2>/dev/null) || JOB=""
    [ -z "$JOB" ] || eval "$JOB" # the app quotes every value
  fi
  # Remembered for restore.sh, which has to work when the app is down. Not in the backup itself: the copies can't be opened without it.
  CACHE="$APP/.backup.cache"
  if [ "$COSY_DEST" != none ]; then
    ( umask 077; printf '%s\n' "$JOB" | grep -v '^COSY_TEST=' > "$CACHE.tmp" && mv "$CACHE.tmp" "$CACHE" ) || true
    return 0
  fi
  if [ -z "${JOB:-}" ] && [ -f "$CACHE" ]; then set -a; . "$CACHE"; set +a; [ "$COSY_DEST" != none ] && return 0; fi
  if [ -f "$APP/.backup.env" ]; then set -a; . "$APP/.backup.env"; set +a; COSY_DEST=file; fi
  return 0
}

# Makes restic ready for the chosen destination (installing it, and the ssh key, when needed).
use_destination() {
  [ "$COSY_DEST" != none ] || return 1
  ensure_restic || return 1
  export RESTIC_REPOSITORY RESTIC_PASSWORD AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_DEFAULT_REGION
  SFTP_ARGS=""
  if [ "$COSY_DEST" = ssh ]; then
    ensure_ssh_key || return 1
    SFTP_ARGS="-p ${COSY_SSH_PORT:-22} -i $KEY -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=accept-new"
  fi
}
rc() { if [ -n "$SFTP_ARGS" ]; then restic -o "sftp.args=$SFTP_ARGS" "$@"; else restic "$@"; fi; }
