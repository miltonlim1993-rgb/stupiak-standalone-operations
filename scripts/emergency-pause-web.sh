#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

ORIGIN="${OPS_PRODUCTION_ORIGIN:-https://stupiaks-ops.sporkburger19.workers.dev}"
CONFIG="worker/wrangler.production.jsonc"

printf '%s\n' '=== STUPIAK OPS WEB MAINTENANCE DEPLOY ==='
printf '%s\n' 'Scope: web/PWA browser access only'
printf '%s\n' 'D1 migration: NO'
printf '%s\n' 'D1 backfill: NO'
printf '%s\n' 'Business-row mutation: NO'
printf '%s\n' 'Android/Capacitor API path: preserved'
echo

if ! command -v node >/dev/null 2>&1; then
  echo 'Node.js is required.' >&2
  exit 1
fi
if ! command -v npm >/dev/null 2>&1; then
  echo 'npm is required.' >&2
  exit 1
fi

printf '%s\n' '=== CHECK WRANGLER LOGIN ==='
npx --yes wrangler whoami >/tmp/stupiaks-ops-wrangler-whoami.txt 2>&1 || {
  cat /tmp/stupiaks-ops-wrangler-whoami.txt >&2
  echo 'Wrangler is not authenticated on this Mac. No deployment was attempted.' >&2
  exit 1
}
cat /tmp/stupiaks-ops-wrangler-whoami.txt

echo
printf '%s\n' '=== INSTALL + BUILD ==='
npm ci
node --check worker/src/entry-web-maintenance.js
npm run build
npm run cf:render

echo
printf '%s\n' '=== PREPARE MAINTENANCE-ONLY CONFIG ==='
node <<'NODE'
const fs = require('fs')
const path = 'worker/wrangler.production.jsonc'
const config = JSON.parse(fs.readFileSync(path, 'utf8'))
if (config.name !== 'stupiaks-ops') throw new Error(`Unexpected Worker name: ${config.name}`)
if (config.d1_databases?.[0]?.database_name !== 'stupiaks-ops-realtime') throw new Error('Unexpected D1 database')
config.main = 'src/entry-web-maintenance.js'
config.assets = config.assets || {}
config.assets.run_worker_first = true
fs.writeFileSync(path, JSON.stringify(config, null, 2) + '\n')
NODE

grep -Fq '"name": "stupiaks-ops"' "$CONFIG"
grep -Fq '"main": "src/entry-web-maintenance.js"' "$CONFIG"
grep -Fq '"run_worker_first": true' "$CONFIG"
grep -Fq '"database_name": "stupiaks-ops-realtime"' "$CONFIG"
grep -Fq '"database_id": "080c13d7-e2f5-4c01-a1ca-aa00094d6fc0"' "$CONFIG"
grep -Fq '"queue": "stupiaks-ops-sheet-sync"' "$CONFIG"
grep -Fq '"bucket_name": "stupiaks-ops-media"' "$CONFIG"

echo 'D1_MIGRATION_RUN=false'
echo 'D1_BACKFILL_RUN=false'
echo 'D1_RESOURCE_CREATION_RUN=false'
echo 'PRODUCTION_BUSINESS_DATA_MUTATION=false'

echo
printf '%s\n' '=== DEPLOY WEB MAINTENANCE GATE ==='
npx wrangler deploy --config "$CONFIG"

echo
printf '%s\n' '=== VERIFY PRODUCTION ==='
root_code="$(curl -sS -o /tmp/stupiaks-ops-maintenance-root.html -w '%{http_code}' "$ORIGIN/")"
api_code="$(curl -sS -o /tmp/stupiaks-ops-maintenance-api.json -w '%{http_code}' "$ORIGIN/api/auth/me")"
health_code="$(curl -sS -o /tmp/stupiaks-ops-maintenance-health.json -w '%{http_code}' "$ORIGIN/api/health")"

if [[ "$root_code" != '503' ]]; then
  echo "Root verification failed: expected 503, got $root_code" >&2
  exit 1
fi
grep -Fq 'Stupiak OPS web access is paused' /tmp/stupiaks-ops-maintenance-root.html || {
  echo 'Maintenance page marker missing.' >&2
  exit 1
}

if [[ "$api_code" != '503' ]]; then
  echo "Browser API verification failed: expected 503, got $api_code" >&2
  exit 1
fi
grep -Fq 'web_maintenance' /tmp/stupiaks-ops-maintenance-api.json || {
  echo 'Maintenance API marker missing.' >&2
  exit 1
}

if [[ "$health_code" != '200' ]]; then
  echo "Health verification failed: expected 200, got $health_code" >&2
  exit 1
fi

headers="$(curl -sSI "$ORIGIN/api/health")"
printf '%s\n' "$headers" | grep -Fiq 'x-chefops-maintenance: web-maintenance-2026-08-21-v1' || {
  echo 'Maintenance health header missing.' >&2
  exit 1
}

cat <<'EOF'
WEB_MAINTENANCE_ACTIVE=true
WEB_ROOT_HTTP=503
WEB_API_HTTP=503
HEALTH_HTTP=200
PRODUCTION_URL_CHANGED=false
PRODUCTION_DATABASE_CHANGED=false
D1_MIGRATION_RUN=false
D1_BACKFILL_RUN=false
EOF
