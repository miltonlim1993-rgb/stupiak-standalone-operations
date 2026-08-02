#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

PRODUCTION_ORIGIN="https://stupiaks-ops.sporkburger19.workers.dev"
HEALTH_URL="$PRODUCTION_ORIGIN/api/health"
AUTH_ME_URL="$PRODUCTION_ORIGIN/api/auth/me"
EXPECTED_REVISION="realtime-resilience-v15-d1-source-of-truth"
DB_NAME="${CLOUDFLARE_OPS_DB_NAME:-stupiaks-ops-realtime}"
QUEUE_NAME="${CLOUDFLARE_SHEET_SYNC_QUEUE_NAME:-stupiaks-ops-sheet-sync}"
DLQ_NAME="${CLOUDFLARE_SHEET_SYNC_DLQ_NAME:-stupiaks-ops-sheet-sync-dlq}"
APP_DATA_PACKS_ID="${CLOUDFLARE_APP_DATA_PACKS_ID:-f62696e1a2f14b8a9e0b84a540c7e997}"

json_database_id() {
  local database_name="$1"
  node -e '
    const fs = require("node:fs")
    const name = process.argv[1]
    const parsed = JSON.parse(fs.readFileSync(0, "utf8"))
    const rows = Array.isArray(parsed) ? parsed : (parsed.result || parsed.databases || [])
    const found = rows.find((row) => String(row.name || row.database_name || "") === name)
    if (!found) process.exit(2)
    process.stdout.write(String(found.uuid || found.database_id || found.id || ""))
  ' "$database_name"
}

read_directory_counts() {
  node -e '
    const fs = require("node:fs")
    const parsed = JSON.parse(fs.readFileSync(0, "utf8"))
    const groups = Array.isArray(parsed) ? parsed : [parsed]
    const rows = groups.flatMap((group) => group?.results || group?.result?.results || group?.result || [])
    const counts = { User: 0, Outlet: 0, active_users: 0 }
    for (const row of rows) {
      if (row.entity === "User") counts.User = Number(row.count || 0)
      if (row.entity === "Outlet") counts.Outlet = Number(row.count || 0)
      if (row.metric === "active_users") counts.active_users = Number(row.count || 0)
    }
    process.stdout.write(`${counts.User} ${counts.Outlet} ${counts.active_users}`)
  '
}

echo "==> Updating canonical main"
git fetch origin main
git switch main 2>/dev/null || git checkout main
git pull --ff-only origin main

echo "==> Checking Wrangler login"
npx wrangler whoami

echo "==> Auditing D1-only runtime rules"
if grep -Fq "from './sheets.js'" worker/src/auth.js; then
  echo "auth.js still imports Google Sheets; refusing deployment." >&2
  exit 1
fi
if grep -Fq "handleRealtimeAttendanceRead" worker/src/entry.js || grep -Fq "handleRealtimeStockRead" worker/src/entry.js; then
  echo "Runtime Sheet hydration is still wired into entry.js; refusing deployment." >&2
  exit 1
fi
grep -Fq "handleD1DirectoryApi" worker/src/entry.js
grep -Fq "runtimeUrl.searchParams.set('legacy_seed', '0')" worker/src/entry.js
grep -Fq "findDirectoryUser" worker/src/auth.js

echo "==> Installing dependencies and running full build"
npm ci
npm run build

OPS_DB_ID="$(npx wrangler d1 list --json | json_database_id "$DB_NAME")"
if [[ -z "$OPS_DB_ID" ]]; then
  echo "Unable to resolve D1 database ID for $DB_NAME" >&2
  exit 1
fi

export CLOUDFLARE_APP_DATA_PACKS_ID="$APP_DATA_PACKS_ID"
export CLOUDFLARE_OPS_DB_ID="$OPS_DB_ID"
export CLOUDFLARE_SHEET_SYNC_QUEUE_NAME="$QUEUE_NAME"
export CLOUDFLARE_SHEET_SYNC_DLQ_NAME="$DLQ_NAME"

npm run cf:render

echo "==> Verifying existing D1 directory data before deployment"
DIRECTORY_JSON="$(npx wrangler d1 execute OPS_DB --remote --config worker/wrangler.production.jsonc --json --command "SELECT entity, COUNT(*) AS count FROM ops_records WHERE entity IN ('User','Outlet') AND deleted_at = '' GROUP BY entity; SELECT 'active_users' AS metric, COUNT(*) AS count FROM ops_records WHERE entity = 'User' AND deleted_at = '' AND lower(json_extract(payload_json, '$.status')) = 'active';")"
read -r USER_COUNT OUTLET_COUNT ACTIVE_USER_COUNT <<<"$(printf '%s' "$DIRECTORY_JSON" | read_directory_counts)"
echo "D1_USER_COUNT=$USER_COUNT"
echo "D1_OUTLET_COUNT=$OUTLET_COUNT"
echo "D1_ACTIVE_USER_COUNT=$ACTIVE_USER_COUNT"

if [[ "$USER_COUNT" -lt 1 || "$ACTIVE_USER_COUNT" -lt 1 ]]; then
  echo "D1 does not contain an active User directory. Production was not changed." >&2
  exit 1
fi

echo "==> Deploying D1 source-of-truth recovery (no migrations, no Sheet import)"
npx wrangler deploy --config worker/wrangler.production.jsonc

echo "==> Verifying production revision and auth endpoint"
for attempt in $(seq 1 30); do
  headers="$(mktemp)"
  auth_headers="$(mktemp)"
  auth_body="$(mktemp)"
  health="$(curl -fsS --max-time 20 -D "$headers" "$HEALTH_URL" || true)"
  auth_status="$(curl -sS --max-time 15 -D "$auth_headers" -o "$auth_body" -w '%{http_code}' "$AUTH_ME_URL" || true)"
  if grep -Fqi "X-ChefOps-Worker-Revision: $EXPECTED_REVISION" "$headers" \
    && [[ "$auth_status" == "401" ]] \
    && grep -Fqi 'Cache-Control: no-store' "$auth_headers"; then
    rm -f "$headers" "$auth_headers" "$auth_body"
    printf '%s\n' "$health"
    echo "D1_USER_DIRECTORY_PRESENT=true"
    echo "AUTH_D1_ONLY=true"
    echo "USER_APPROVALS_D1_ONLY=true"
    echo "RUNTIME_SHEET_HYDRATION_DISABLED=true"
    echo "NO_D1_MIGRATION_EXECUTED=true"
    echo "V15_DEPLOYMENT_VERIFIED=true"
    exit 0
  fi
  rm -f "$headers" "$auth_headers" "$auth_body"
  sleep 5
done

echo "Deployment completed, but v15 production verification did not pass." >&2
exit 1
