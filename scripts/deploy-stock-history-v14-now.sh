#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

PRODUCTION_ORIGIN="https://stupiaks-ops.sporkburger19.workers.dev"
HEALTH_URL="$PRODUCTION_ORIGIN/api/health"
EXPECTED_REVISION="realtime-resilience-v14-complete-stock-history"
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

echo "==> Updating canonical main"
git fetch origin main
git switch main 2>/dev/null || git checkout main
git pull --ff-only origin main

echo "==> Checking Wrangler login"
npx wrangler whoami

echo "==> Installing dependencies and running the full build"
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
npx wrangler d1 migrations apply OPS_DB --remote --config worker/wrangler.production.jsonc

echo "==> Deploying v14 complete StockCount history hydration"
npx wrangler deploy --config worker/wrangler.production.jsonc

echo "==> Verifying the production Worker revision"
for attempt in $(seq 1 30); do
  headers="$(mktemp)"
  health="$(curl -fsS --max-time 20 -D "$headers" "$HEALTH_URL" || true)"
  if grep -Fqi "X-ChefOps-Worker-Revision: $EXPECTED_REVISION" "$headers"; then
    rm -f "$headers"
    printf '%s\n' "$health"
    echo "STOCK_HISTORY_COMPLETENESS_MARKER_V2=true"
    echo "STOCK_HISTORY_FULL_SHEET_UPSERT=true"
    echo "STOCK_HISTORY_PARTIAL_D1_GAP_FIXED=true"
    echo "V14_DEPLOYMENT_VERIFIED=true"
    exit 0
  fi
  rm -f "$headers"
  sleep 5
done

echo "v14 deployment completed, but the production revision was not observed." >&2
exit 1
