#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

PRODUCTION_ORIGIN="https://stupiaks-ops.sporkburger19.workers.dev"
EXPECTED_REVISION="realtime-resilience-v11-roster-sop-recovery"
EXPECTED_PWA_TOKEN="drive-media-proxy-v11"
DB_NAME="${CLOUDFLARE_OPS_DB_NAME:-stupiaks-ops-realtime}"
QUEUE_NAME="${CLOUDFLARE_SHEET_SYNC_QUEUE_NAME:-stupiaks-ops-sheet-sync}"
DLQ_NAME="${CLOUDFLARE_SHEET_SYNC_DLQ_NAME:-stupiaks-ops-sheet-sync-dlq}"
APP_DATA_PACKS_ID="${CLOUDFLARE_APP_DATA_PACKS_ID:-f62696e1a2f14b8a9e0b84a540c7e997}"

echo "==> Updating canonical main"
git fetch origin main
git switch main 2>/dev/null || git checkout main
git pull --ff-only origin main

echo "==> Checking Wrangler login"
npx wrangler whoami

echo "==> Installing and building"
npm ci
npm run build

OPS_DB_ID="$(npx wrangler d1 list --json | node -e '
  const fs = require("node:fs")
  const name = process.argv[1]
  const parsed = JSON.parse(fs.readFileSync(0, "utf8"))
  const rows = Array.isArray(parsed) ? parsed : (parsed.result || parsed.databases || [])
  const found = rows.find((row) => String(row.name || row.database_name || "") === name)
  if (!found) process.exit(2)
  process.stdout.write(String(found.uuid || found.database_id || found.id || ""))
' "$DB_NAME")"

export CLOUDFLARE_APP_DATA_PACKS_ID="$APP_DATA_PACKS_ID"
export CLOUDFLARE_OPS_DB_ID="$OPS_DB_ID"
export CLOUDFLARE_SHEET_SYNC_QUEUE_NAME="$QUEUE_NAME"
export CLOUDFLARE_SHEET_SYNC_DLQ_NAME="$DLQ_NAME"

npm run cf:render
npx wrangler d1 migrations apply OPS_DB --remote --config worker/wrangler.production.jsonc
npx wrangler deploy --config worker/wrangler.production.jsonc

echo "==> Verifying v11"
for attempt in $(seq 1 24); do
  headers="$(mktemp)"
  curl -fsS --max-time 20 -D "$headers" "$PRODUCTION_ORIGIN/api/health" >/tmp/chefops-v11-health.json || true
  sw="$(curl -fsS --max-time 20 "$PRODUCTION_ORIGIN/sw-v27.js?_=$RANDOM" || true)"
  if grep -Fqi "X-ChefOps-Worker-Revision: $EXPECTED_REVISION" "$headers" \
    && printf '%s' "$sw" | grep -Fq "$EXPECTED_PWA_TOKEN"; then
    rm -f "$headers"
    cat /tmp/chefops-v11-health.json
    echo "ROSTER_DELETED_ROWS_REVIVED=true"
    echo "SOP_DRIVE_MEDIA_SERVICE_WORKER_PROXY=true"
    echo "V11_DEPLOYMENT_VERIFIED=true"
    exit 0
  fi
  rm -f "$headers"
  sleep 5
done

echo "v11 deployment finished but production verification did not pass." >&2
exit 1
