#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

PRODUCTION_ORIGIN="https://stupiaks-ops.sporkburger19.workers.dev"
EXPECTED_REVISION="realtime-resilience-v12-bundled-sop-roster-repair"
EXPECTED_SW_TOKEN="bundled-sop-media-v12"
DB_NAME="${CLOUDFLARE_OPS_DB_NAME:-stupiaks-ops-realtime}"
QUEUE_NAME="${CLOUDFLARE_SHEET_SYNC_QUEUE_NAME:-stupiaks-ops-sheet-sync}"
DLQ_NAME="${CLOUDFLARE_SHEET_SYNC_DLQ_NAME:-stupiaks-ops-sheet-sync-dlq}"
APP_DATA_PACKS_ID="${CLOUDFLARE_APP_DATA_PACKS_ID:-f62696e1a2f14b8a9e0b84a540c7e997}"
DEFAULT_ZIP="$HOME/Downloads/stupiaks-sop-media-v12.zip"
DEFAULT_DIR="$HOME/Downloads/stupiaks-sop-media-v12"
MEDIA_INPUT="${1:-}"

install_media() {
  local input="$1"
  rm -rf web/public/sop-media
  mkdir -p web/public/sop-media

  if [[ -f "$input" ]]; then
    local temp_dir
    temp_dir="$(mktemp -d)"
    unzip -q -o "$input" -d "$temp_dir"
    if [[ -d "$temp_dir/web/public/sop-media" ]]; then
      cp -R "$temp_dir/web/public/sop-media/." web/public/sop-media/
    elif [[ -d "$temp_dir/stupiaks-sop-media-v12/web/public/sop-media" ]]; then
      cp -R "$temp_dir/stupiaks-sop-media-v12/web/public/sop-media/." web/public/sop-media/
    else
      echo "The downloaded archive does not contain web/public/sop-media." >&2
      exit 1
    fi
    rm -rf "$temp_dir"
  elif [[ -d "$input/web/public/sop-media" ]]; then
    cp -R "$input/web/public/sop-media/." web/public/sop-media/
  else
    echo "SOP media package was not found: $input" >&2
    exit 1
  fi

  local files=(
    opening-preparation.webp
    opening-area.webp
    non-busy-cleaning.webp
    closing-kitchen.webp
    closing-front.webp
    toilet-closing.webp
    garbage-bin-wash.webp
    freezer-deep-clean.webp
  )
  for file in "${files[@]}"; do
    local path="web/public/sop-media/$file"
    if [[ ! -f "$path" ]]; then
      echo "Missing bundled SOP file: $path" >&2
      exit 1
    fi
    local bytes
    bytes="$(wc -c < "$path" | tr -d ' ')"
    if [[ "$bytes" -lt 100000 ]]; then
      echo "Bundled SOP file is unexpectedly small: $path ($bytes bytes)" >&2
      exit 1
    fi
  done
}

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

roster_count() {
  node -e '
    const fs = require("node:fs")
    const parsed = JSON.parse(fs.readFileSync(0, "utf8"))
    const blocks = Array.isArray(parsed) ? parsed : [parsed]
    let count = 0
    for (const block of blocks) {
      const rows = block?.results || block?.result?.results || block?.result || []
      const list = Array.isArray(rows) ? rows : []
      for (const row of list) count = Math.max(count, Number(row.count || row.COUNT || 0))
    }
    process.stdout.write(String(count))
  '
}

echo "==> Updating canonical main"
git fetch origin main
git switch main 2>/dev/null || git checkout main
git pull --ff-only origin main

if [[ -z "$MEDIA_INPUT" ]]; then
  if [[ -f "$DEFAULT_ZIP" ]]; then
    MEDIA_INPUT="$DEFAULT_ZIP"
  elif [[ -d "$DEFAULT_DIR" ]]; then
    MEDIA_INPUT="$DEFAULT_DIR"
  else
    echo "Download stupiaks-sop-media-v12.zip first. Expected: $DEFAULT_ZIP" >&2
    exit 1
  fi
fi

echo "==> Installing eight SOP posters into Cloudflare static assets"
install_media "$MEDIA_INPUT"

echo "==> Persisting bundled SOP assets in main"
git add web/public/sop-media
if ! git diff --cached --quiet; then
  git commit -m "Bundle operational SOP posters in Cloudflare assets"
  git push origin main
fi

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

echo "==> Repairing the confirmed 02 Aug RR-KCH roster directly in D1"
npx wrangler d1 execute OPS_DB --remote \
  --config worker/wrangler.production.jsonc \
  --file scripts/repair-roster-2026-08-02.sql

echo "==> Deploying v12"
npx wrangler deploy --config worker/wrangler.production.jsonc

echo "==> Verifying actual D1 rows, static media bytes, Service Worker and Worker revision"
for attempt in $(seq 1 30); do
  headers="$(mktemp)"
  media_headers="$(mktemp)"
  curl -fsS --max-time 20 -D "$headers" "$PRODUCTION_ORIGIN/api/health" >/tmp/chefops-v12-health.json || true
  sw="$(curl -fsS --max-time 20 "$PRODUCTION_ORIGIN/sw-v27.js?_=$RANDOM" || true)"
  media="$(mktemp)"
  curl -fsS --max-time 30 -D "$media_headers" -o "$media" "$PRODUCTION_ORIGIN/sop-media/opening-preparation.webp?_=$RANDOM" || true
  media_bytes="$(wc -c < "$media" | tr -d ' ')"
  rm -f "$media"

  d1_json="$(npx wrangler d1 execute OPS_DB --remote --json \
    --config worker/wrangler.production.jsonc \
    --command "SELECT COUNT(*) AS count FROM ops_records WHERE entity='Attendance' AND outlet_id='RR-KCH' AND business_date='2026-08-02' AND deleted_at='';" 2>/dev/null || true)"
  count="$(printf '%s' "$d1_json" | roster_count 2>/dev/null || echo 0)"

  if grep -Fqi "X-ChefOps-Worker-Revision: $EXPECTED_REVISION" "$headers" \
    && printf '%s' "$sw" | grep -Fq "$EXPECTED_SW_TOKEN" \
    && grep -Fqi 'Content-Type: image/webp' "$media_headers" \
    && [[ "$media_bytes" -gt 100000 ]] \
    && [[ "$count" -ge 8 ]]; then
    rm -f "$headers" "$media_headers"
    cat /tmp/chefops-v12-health.json
    echo "D1_ROSTER_2026_08_02_COUNT=$count"
    echo "BUNDLED_SOP_MEDIA_BYTES=$media_bytes"
    echo "ROSTER_ACTUAL_DATA_VERIFIED=true"
    echo "SOP_ACTUAL_MEDIA_VERIFIED=true"
    echo "V12_DEPLOYMENT_VERIFIED=true"
    exit 0
  fi

  rm -f "$headers" "$media_headers"
  sleep 5
done

echo "v12 deployed but actual roster/media verification did not pass." >&2
exit 1
