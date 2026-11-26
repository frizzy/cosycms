#!/bin/sh
# Runs the scheduler once (scheduled publishing and deploys). Call it every minute from cron; scripts/deploy.mjs sets that up.
# Needs TICK_TOKEN in .dev.vars. On Cloudflare Workers a cron trigger does this instead (see wrangler.jsonc).
APP=$(cd "$(dirname "$0")/.." && pwd)
TOKEN=$(sed -n 's/^TICK_TOKEN=//p' "$APP/.dev.vars" 2>/dev/null)
[ -n "$TOKEN" ] || exit 0
curl -fsSk -m 55 -X POST -H "Authorization: Bearer $TOKEN" "https://localhost:${PORT:-8787}/api/tick"
