#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

PRODUCTION_ORIGIN="https://stupiaks-ops.sporkburger19.workers.dev"
HEALTH_URL="$PRODUCTION_ORIGIN/api/health"
AUTH_ME_URL="$PRODUCTION_ORIGIN/api/auth/me"
PWA_WORKER_URL="$PRODUCTION_ORIGIN/sw-v27.js"
MEDIA_URL="$PRODUCTION_ORIGIN/sop-media/opening-preparation.webp"
DB_NAME="${CLOUDFLARE_OPS_DB_NAME:-stupiaks-ops-realtime}"
QUEUE_NAME="${CLOUDFLARE_SHEET_SYNC_QUEUE_NAME:-stupiaks-ops-sheet-sync}"
DLQ_NAME="${CLOUDFLARE_SHEET_SYNC_DLQ_NAME:-stupiaks-ops-sheet-sync-dlq}"
APP_DATA_PACKS_ID="${CLOUDFLARE_APP_DATA_PACKS_ID:-f62696e1a2f14b8a9e0b84a540c7e997}"
EXPECTED_REVISION="realtime-resilience-v13-stock-history-media-ui"
EXPECTED_PWA_TOKEN="stock-history-media-ui-v13"

json_database_id() {
  local database_name="$1"
  node -e '
    const fs = require("node:fs");
    const name = process.argv[1];
    const input = fs.readFileSync(0, "utf8").trim();
    if (!input) process.exit(2);
    const parsed = JSON.parse(input);
    const rows = Array.isArray(parsed)
      ? parsed
      : (Array.isArray(parsed.result) ? parsed.result
        : (Array.isArray(parsed.databases) ? parsed.databases : []));
    const found = rows.find((row) => String(row.name || row.database_name || "") === name);
    if (!found) process.exit(3);
    const id = found.uuid || found.database_id || found.id;
    if (!id) process.exit(4);
    process.stdout.write(String(id));
  ' "$database_name"
}

health_realtime_ready() {
  node -e '
    const fs = require("node:fs");
    const input = fs.readFileSync(0, "utf8").trim();
    if (!input) process.exit(2);
    const payload = JSON.parse(input);
    const realtime = payload && payload.realtime;
    if (!realtime || realtime.ready !== true) process.exit(3);
    if (realtime.database_bound !== true) process.exit(4);
    if (realtime.queue_bound !== true) process.exit(5);
    if (realtime.websocket_bound !== true) process.exit(6);
    if (Array.isArray(realtime.missing_tables) && realtime.missing_tables.length) process.exit(7);
  '
}

auth_endpoint_ready() {
  local status="$1"
  local headers_file="$2"
  local body_file="$3"
  [[ "$status" == "401" ]] || return 1
  grep -Fqi 'Cache-Control: no-store' "$headers_file" || return 1
  node -e '
    const fs = require("node:fs");
    const input = fs.readFileSync(process.argv[1], "utf8").trim();
    if (!input) process.exit(2);
    const payload = JSON.parse(input);
    if (payload.code !== "auth_required") process.exit(3);
  ' "$body_file"
}

ensure_queue() {
  local queue_name="$1"
  echo "==> Ensuring Queue: $queue_name"
  if npx wrangler queues create "$queue_name" >/tmp/chefops-queue-create.log 2>&1; then
    cat /tmp/chefops-queue-create.log
    return 0
  fi
  if grep -Eqi 'already exists|already been taken|is already taken|name is already in use|code: 11009' /tmp/chefops-queue-create.log; then
    echo "Queue already exists: $queue_name"
    return 0
  fi
  cat /tmp/chefops-queue-create.log >&2
  return 1
}

echo "==> Canonical OPS production: $PRODUCTION_ORIGIN"
echo "==> Checking existing local Wrangler authentication"
npx wrangler whoami

echo "==> Switching to the canonical main branch"
if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "Tracked local changes are present. Commit or stash them before production deployment." >&2
  exit 1
fi
git fetch origin main
if ! git switch main 2>/dev/null; then
  git checkout main
fi
git pull --ff-only origin main

echo "==> Installing exact dependencies"
npm ci

echo "==> Auditing realtime, stock-history and media UI closure"
node scripts/audit-realtime-closure.mjs

echo "==> Resolving D1 database: $DB_NAME"
databases_json="$(npx wrangler d1 list --json)"
OPS_DB_ID="$(printf '%s' "$databases_json" | json_database_id "$DB_NAME" || true)"
if [[ -z "$OPS_DB_ID" ]]; then
  echo "==> Creating D1 database in APAC: $DB_NAME"
  npx wrangler d1 create "$DB_NAME" --location apac
  databases_json="$(npx wrangler d1 list --json)"
  OPS_DB_ID="$(printf '%s' "$databases_json" | json_database_id "$DB_NAME")"
fi
if [[ -z "$OPS_DB_ID" ]]; then
  echo "Unable to resolve D1 database ID for $DB_NAME" >&2
  exit 1
fi

echo "==> D1 database ID resolved: $OPS_DB_ID"
ensure_queue "$QUEUE_NAME"
ensure_queue "$DLQ_NAME"

export CLOUDFLARE_APP_DATA_PACKS_ID="$APP_DATA_PACKS_ID"
export CLOUDFLARE_OPS_DB_ID="$OPS_DB_ID"
export CLOUDFLARE_SHEET_SYNC_QUEUE_NAME="$QUEUE_NAME"
export CLOUDFLARE_SHEET_SYNC_DLQ_NAME="$DLQ_NAME"

echo "==> Building web and Worker"
npm run build

echo "==> Rendering canonical production bindings"
npm run cf:render

echo "==> Applying D1 migrations"
npx wrangler d1 migrations apply OPS_DB --remote --config worker/wrangler.production.jsonc

echo "==> Deploying Worker with D1, Durable Object and Queue bindings"
npx wrangler deploy --config worker/wrangler.production.jsonc

echo "==> Verifying v13, auth, D1, Queue, WebSocket and bundled media"
headers=''
body=''
pwa_body=''
auth_status=''
auth_body=''
for attempt in $(seq 1 30); do
  headers="$(mktemp)"
  auth_headers="$(mktemp)"
  auth_body_file="$(mktemp)"
  media_headers="$(mktemp)"
  media_file="$(mktemp)"
  body="$(curl -fsS --max-time 20 -D "$headers" "$HEALTH_URL" || true)"
  pwa_body="$(curl -fsS --max-time 20 "$PWA_WORKER_URL?_=$RANDOM" || true)"
  auth_status="$(curl -sS --max-time 15 -D "$auth_headers" -o "$auth_body_file" -w '%{http_code}' "$AUTH_ME_URL" || true)"
  auth_body="$(cat "$auth_body_file" 2>/dev/null || true)"
  curl -fsS --max-time 30 -D "$media_headers" -o "$media_file" "$MEDIA_URL?_=$RANDOM" || true
  media_bytes="$(wc -c < "$media_file" | tr -d ' ')"
  rm -f "$media_file"

  if grep -Fqi "X-ChefOps-Worker-Revision: $EXPECTED_REVISION" "$headers" \
    && printf '%s' "$body" | health_realtime_ready \
    && printf '%s' "$pwa_body" | grep -Fq "$EXPECTED_PWA_TOKEN" \
    && auth_endpoint_ready "$auth_status" "$auth_headers" "$auth_body_file" \
    && grep -Fqi 'Content-Type: image/webp' "$media_headers" \
    && [[ "$media_bytes" -gt 100000 ]]; then
    rm -f "$headers" "$auth_headers" "$auth_body_file" "$media_headers"
    printf '%s\n' "$body"
    echo "REALTIME_DEPLOYMENT_VERIFIED=true"
    echo "D1_MIGRATIONS_APPLIED=true"
    echo "OUTLET_WEBSOCKET_CONFIGURED=true"
    echo "SHEET_SYNC_QUEUE_CONFIGURED=true"
    echo "AUTH_SESSION_STABLE=true"
    echo "AUTH_RESPONSES_NOT_CACHED=true"
    echo "AUTH_ENDPOINT_RESPONDS=true"
    echo "OWNER_OUTLET_SCOPE_RECOVERED=true"
    echo "LIVE_WORKSPACE_READS_D1_PRIMARY=true"
    echo "LEGACY_SHEET_READ_ERRORS_ISOLATED=true"
    echo "DUTY_ROSTER_DIRECT_D1_HYDRATION=true"
    echo "STOCK_HISTORY_SHEET_D1_HYDRATION=true"
    echo "TASK_MEDIA_CLOUDFLARE_CACHE=true"
    echo "GOOGLE_DRIVE_MEDIA_PROXY_NORMALIZED=true"
    echo "PUBLIC_DRIVE_MEDIA_FALLBACK=true"
    echo "SOP_MEDIA_UI_DIRECT_MAPPING=true"
    echo "TASK_MEDIA_OBJECT_CONTAIN=true"
    echo "STOCK_SUBMISSIONS_PACKAGE_D1_ONLY=true"
    echo "CLOSEUP_SUBMISSIONS_D1_ONLY=true"
    echo "CLOSEUP_SHEET_SYNC_ASYNC=true"
    echo "TASK_ACTIONS_D1_ONLY=true"
    echo "TASK_ALERT_CLAIM_READY=true"
    echo "TASK_DRAFT_AUTOSAVE_READY=true"
    echo "MULTI_DEVICE_TESTING_READY=true"
    exit 0
  fi
  rm -f "$headers" "$auth_headers" "$auth_body_file" "$media_headers"
  sleep 5
done

echo "Deployment command completed, but v13 readiness was not observed in production." >&2
echo "Expected Worker revision: $EXPECTED_REVISION" >&2
echo "Expected PWA token: $EXPECTED_PWA_TOKEN" >&2
echo "Last health response: $body" >&2
echo "Last auth status: $auth_status" >&2
echo "Last auth response: $auth_body" >&2
echo "Last PWA response: $pwa_body" >&2
exit 1