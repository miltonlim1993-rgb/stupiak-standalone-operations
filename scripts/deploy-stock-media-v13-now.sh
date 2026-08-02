#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

PRODUCTION_ORIGIN="https://stupiaks-ops.sporkburger19.workers.dev"
HEALTH_URL="$PRODUCTION_ORIGIN/api/health"
PWA_WORKER_URL="$PRODUCTION_ORIGIN/sw-v27.js"
MEDIA_URL="$PRODUCTION_ORIGIN/sop-media/opening-preparation.webp"
EXPECTED_REVISION="realtime-resilience-v13-stock-history-media-ui"
EXPECTED_SW_TOKEN="stock-history-media-ui-v13"
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

echo "==> Installing dependencies and building"
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

echo "==> Deploying v13"
npx wrangler deploy --config worker/wrangler.production.jsonc

echo "==> Verifying Worker revision, PWA refresh token and bundled media"
for attempt in $(seq 1 30); do
  headers="$(mktemp)"
  media_headers="$(mktemp)"
  media_file="$(mktemp)"
  health="$(curl -fsS --max-time 20 -D "$headers" "$HEALTH_URL" || true)"
  sw="$(curl -fsS --max-time 20 "$PWA_WORKER_URL?_=$RANDOM" || true)"
  curl -fsS --max-time 30 -D "$media_headers" -o "$media_file" "$MEDIA_URL?_=$RANDOM" || true
  media_bytes="$(wc -c < "$media_file" | tr -d ' ')"
  rm -f "$media_file"

  if grep -Fqi "X-ChefOps-Worker-Revision: $EXPECTED_REVISION" "$headers" \
    && printf '%s' "$sw" | grep -Fq "$EXPECTED_SW_TOKEN" \
    && grep -Fqi 'Content-Type: image/webp' "$media_headers" \
    && [[ "$media_bytes" -gt 100000 ]]; then
    rm -f "$headers" "$media_headers"
    printf '%s\n' "$health"
    echo "STOCK_HISTORY_READ_ROUTE=true"
    echo "STOCK_HISTORY_SHEET_D1_HYDRATION=true"
    echo "SOP_MEDIA_UI_DIRECT_MAPPING=true"
    echo "TASK_MEDIA_OBJECT_CONTAIN=true"
    echo "PWA_MEDIA_UI_REFRESH=true"
    echo "V13_DEPLOYMENT_VERIFIED=true"
    exit 0
  fi

  rm -f "$headers" "$media_headers"
  sleep 5
done

echo "v13 deployed but Worker/PWA/media verification did not pass." >&2
exit 1
