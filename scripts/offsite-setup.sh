#!/bin/sh
# One-time setup of off-box backups for a Docker install. Run it on the server.
# Uses restic: every backup is encrypted before it leaves the machine, only what changed is uploaded, and old snapshots are thinned out.
#   scripts/offsite-setup.sh <repository>
# <repository> is where the copies go, for example
#   s3:https://<account-id>.r2.cloudflarestorage.com/<bucket>   Cloudflare R2 (export AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY first)
#   sftp:user@host:/path/cosycms-backups                         another machine over ssh (this server needs a key that can log in there)
#   b2:<bucket>:cosycms                                          Backblaze B2 (export B2_ACCOUNT_ID and B2_ACCOUNT_KEY first)
#   /mnt/disk/cosycms-backups                                    a mounted disk (that is a second disk, not another machine: say so in your head)
# It installs restic into ~/bin if it is missing, creates a random repository password (kept in .backup.password: copy it somewhere safe,
# without it the copies can't be read), writes .backup.env, and creates the repository. backup.sh uses it from then on.
set -eu
[ $# -eq 1 ] || { sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//' >&2; exit 2; }
REPO=$1
APP=${APP:-$(cd "$(dirname "$0")/.." && pwd)}; ENVF="$APP/.backup.env"; PW="$APP/.backup.password"
RESTIC_VERSION=${RESTIC_VERSION:-0.20.0}
umask 077

if ! PATH="$HOME/bin:$PATH" command -v restic >/dev/null; then
  case $(uname -m) in aarch64|arm64) ARCH=arm64;; x86_64) ARCH=amd64;; *) echo "no restic build chosen for $(uname -m); install restic yourself" >&2; exit 1;; esac
  TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
  BASE=https://github.com/restic/restic/releases/download/v$RESTIC_VERSION; FILE=restic_${RESTIC_VERSION}_linux_$ARCH.bz2
  echo "installing restic $RESTIC_VERSION ($ARCH) into ~/bin"
  curl -fsSL "$BASE/$FILE" -o "$TMP/$FILE"; curl -fsSL "$BASE/SHA256SUMS" -o "$TMP/SHA256SUMS"
  (cd "$TMP" && grep " $FILE\$" SHA256SUMS | sha256sum -c - >/dev/null) || { echo "restic download failed its checksum" >&2; exit 1; }
  mkdir -p "$HOME/bin"; bzip2 -dc "$TMP/$FILE" > "$HOME/bin/restic"; chmod 755 "$HOME/bin/restic"
fi
export PATH="$HOME/bin:$PATH"

NEW=0; [ -f "$PW" ] || { openssl rand -base64 32 > "$PW"; NEW=1; }
{
  printf "RESTIC_REPOSITORY='%s'\nRESTIC_PASSWORD_FILE='%s'\n" "$REPO" "$PW"
  case $REPO in *r2.cloudflarestorage.com*) [ -n "${AWS_DEFAULT_REGION:-}" ] || AWS_DEFAULT_REGION=auto;; esac
  for v in AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_DEFAULT_REGION B2_ACCOUNT_ID B2_ACCOUNT_KEY; do eval "val=\${$v-}"; [ -z "$val" ] || printf "%s='%s'\n" "$v" "$val"; done
} > "$ENVF"
set -a; . "$ENVF"; set +a
if restic cat config >/dev/null 2>&1; then echo "using the existing repository"; else restic init; fi
echo
echo "Off-box backups are set up. The next scripts/backup.sh run (the nightly cron job) sends a copy."
[ $NEW = 1 ] && { echo; echo "Repository password (store it somewhere safe, off this machine):"; cat "$PW"; }
exit 0
