#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

ORIGIN="${OPS_PRODUCTION_ORIGIN:-https://stupiaks-ops.sporkburger19.workers.dev}"
CONFIG="worker/wrangler.production.jsonc"

printf '%s\n' '=== STUPIAK OPS WEB MAINTENANCE RESTORE ==='
printf '%s\n' 'Restore canonical entry/assets routing only'
printf '%s\n' 'D1 migration: NO'
printf '%s\n' 'D1 backfill: NO'
printf '%s\n' 'Business-row mutation: NO'
echo

npx --yes wrangler whoami >/tmp/stupiaks-ops-wrangler-whoami.txt 2>&1 || {
  cat /tmp/stupiaks-ops-wrangler-whoami.txt >&2
  echo 'Wrangler is not authenticated on this Mac. No deployment was attempted.' >&2
  exit 1
}
cat /tmp/stupiaks-ops-wrangler-whoami.txt

npm ci
npm run build
npm run cf:render

grep -Fq '"name": "stupiaks-ops"' "$CONFIG"
grep -Fq '"main": "src/entry-master-watch.js"' "$CONFIG"
grep -Fq '"database_name": "stupiaks-ops-realtime"' "$CONFIG"
grep -Fq '"database_id": "080c13d7-e2f5-4c01-a1ca-aa00094d6fc0"' "$CONFIG"
grep -Fq '"queue": "stupiaks-ops-sheet-sync"' "$CONFIG"
grep -Fq '"bucket_name": "stupiaks-ops-media"' "$CONFIG"

echo 'D1_MIGRATION_RUN=false'
echo 'D1_BACKFILL_RUN=false'
echo 'D1_RESOURCE_CREATION_RUN=false'
echo 'PRODUCTION_BUSINESS_DATA_MUTATION=false'

npx wrangler deploy --config "$CONFIG"

root_code="$(curl -sS -o /tmp/stupiaks-ops-restored-root.html -w '%{http_code}' "$ORIGIN/")"
if [[ "$root_code" != '200' ]]; then
  echo "Root restore verification failed: expected 200, got $root_code" >&2
  exit 1
fi
if grep -Fq 'Stupiak OPS web access is paused' /tmp/stupiaks-ops-restored-root.html; then
  echo 'Maintenance page is still active after restore deploy.' >&2
  exit 1
fi

health_code="$(curl -sS -o /tmp/stupiaks-ops-restored-health.json -w '%{http_code}' "$ORIGIN/api/health")"
if [[ "$health_code" != '200' ]]; then
  echo "Health verification failed: expected 200, got $health_code" >&2
  exit 1
fi

cat <<'EOF'
WEB_MAINTENANCE_ACTIVE=false
WEB_ROOT_HTTP=200
HEALTH_HTTP=200
PRODUCTION_URL_CHANGED=false
PRODUCTION_DATABASE_CHANGED=false
D1_MIGRATION_RUN=false
D1_BACKFILL_RUN=false
EOF
