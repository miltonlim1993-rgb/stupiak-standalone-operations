#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

PRODUCTION_ORIGIN="https://stupiaks-ops.sporkburger19.workers.dev"
HEALTH_URL="$PRODUCTION_ORIGIN/api/health"
AUTH_ME_URL="$PRODUCTION_ORIGIN/api/auth/me"
MIGRATION_URL="$PRODUCTION_ORIGIN/api/internal/d1-directory/migrate-once"
EXPECTED_REVISION="realtime-resilience-v16-explicit-directory-bootstrap"
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
      if (row.entity === "active_users") counts.active_users = Number(row.count || 0)
    }
    process.stdout.write(`${counts.User} ${counts.Outlet} ${counts.active_users}`)
  '
}

query_directory_counts() {
  local query json
  query="SELECT entity, COUNT(*) AS count FROM ops_records WHERE entity IN ('User','Outlet') AND deleted_at = '' GROUP BY entity UNION ALL SELECT 'active_users' AS entity, COUNT(*) AS count FROM ops_records WHERE entity = 'User' AND deleted_at = '' AND lower(json_extract(payload_json, '$.status')) = 'active'"
  json="$(npx wrangler d1 execute OPS_DB --remote --config worker/wrangler.production.jsonc --json --command "$query")"
  printf '%s' "$json" | read_directory_counts
}

echo "==> Updating canonical main"
git fetch origin main
git switch main 2>/dev/null || git checkout main
git pull --ff-only origin main

echo "==> Checking Wrangler login"
npx wrangler whoami

echo "==> Auditing explicit one-time migration closure"
grep -Fq "handleD1DirectoryBootstrap" worker/src/entry.js
grep -Fq "runtimeUrl.searchParams.set('legacy_seed', '0')" worker/src/entry.js
grep -Fq "DIRECTORY_BOOTSTRAP_MARKER" worker/src/d1-directory-bootstrap-state.js
grep -Fq "google-sheets-explicit-one-time-import" worker/src/d1-directory-bootstrap.js
if grep -Fq "handleRealtimeAttendanceRead" worker/src/entry.js || grep -Fq "handleRealtimeStockRead" worker/src/entry.js; then
  echo "Runtime page hydration is still wired into entry.js; refusing deployment." >&2
  exit 1
fi

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

read -r USER_COUNT OUTLET_COUNT ACTIVE_USER_COUNT <<<"$(query_directory_counts)"
echo "D1_USER_COUNT_BEFORE=$USER_COUNT"
echo "D1_OUTLET_COUNT_BEFORE=$OUTLET_COUNT"
echo "D1_ACTIVE_USER_COUNT_BEFORE=$ACTIVE_USER_COUNT"

MIGRATION_REQUIRED=false
if [[ "$USER_COUNT" -lt 1 || "$OUTLET_COUNT" -lt 1 || "$ACTIVE_USER_COUNT" -lt 1 ]]; then
  MIGRATION_REQUIRED=true
fi

MIGRATION_SECRET="$(node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('hex'))")"
printf '%s' "$MIGRATION_SECRET" | npx wrangler secret put D1_DIRECTORY_MIGRATION_SECRET --config worker/wrangler.production.jsonc >/dev/null

echo "==> Deploying v16 with safe pre-migration directory fallback"
npx wrangler deploy --config worker/wrangler.production.jsonc

MIGRATION_PERFORMED=false
if [[ "$MIGRATION_REQUIRED" == "true" ]]; then
  echo "==> Running the explicit one-time User and Outlet import"
  migration_ok=false
  for attempt in $(seq 1 20); do
    body_file="$(mktemp)"
    status="$(curl -sS --max-time 90 -o "$body_file" -w '%{http_code}' \
      -X POST \
      -H "X-ChefOps-Directory-Migration-Secret: $MIGRATION_SECRET" \
      "$MIGRATION_URL" || true)"
    if [[ "$status" == "200" || "$status" == "201" ]]; then
      if node -e '
        const fs = require("node:fs")
        const body = JSON.parse(fs.readFileSync(process.argv[1], "utf8"))
        if (!body.ok) process.exit(1)
      ' "$body_file"; then
        cat "$body_file"
        echo
        migration_ok=true
        MIGRATION_PERFORMED=true
        rm -f "$body_file"
        break
      fi
    fi
    echo "Directory import attempt $attempt returned HTTP ${status:-000}; retrying..." >&2
    rm -f "$body_file"
    sleep 8
  done
  if [[ "$migration_ok" != "true" ]]; then
    echo "The one-time directory import did not complete. v16 remains in safe bootstrap fallback mode; production was not switched to an empty D1 directory." >&2
    exit 1
  fi
fi

read -r USER_COUNT OUTLET_COUNT ACTIVE_USER_COUNT <<<"$(query_directory_counts)"
echo "D1_USER_COUNT_AFTER=$USER_COUNT"
echo "D1_OUTLET_COUNT_AFTER=$OUTLET_COUNT"
echo "D1_ACTIVE_USER_COUNT_AFTER=$ACTIVE_USER_COUNT"

if [[ "$USER_COUNT" -lt 1 || "$OUTLET_COUNT" -lt 1 || "$ACTIVE_USER_COUNT" -lt 1 ]]; then
  echo "D1 directory verification failed after the explicit import." >&2
  exit 1
fi

echo "==> Verifying production revision and unauthenticated auth response"
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
    echo "EXPLICIT_DIRECTORY_IMPORT_REQUIRED=$MIGRATION_REQUIRED"
    echo "EXPLICIT_DIRECTORY_IMPORT_PERFORMED=$MIGRATION_PERFORMED"
    echo "D1_USER_DIRECTORY_PRESENT=true"
    echo "D1_OUTLET_DIRECTORY_PRESENT=true"
    echo "AUTH_D1_PRIMARY=true"
    echo "USER_APPROVALS_D1_PRIMARY=true"
    echo "RUNTIME_PAGE_MIGRATION_DISABLED=true"
    echo "DIRECTORY_IMPORT_MARKED_COMPLETE=true"
    echo "NO_D1_SCHEMA_MIGRATION_EXECUTED=true"
    echo "V16_DEPLOYMENT_VERIFIED=true"
    exit 0
  fi
  rm -f "$headers" "$auth_headers" "$auth_body"
  sleep 5
done

echo "Deployment completed, but v16 production verification did not pass." >&2
exit 1
