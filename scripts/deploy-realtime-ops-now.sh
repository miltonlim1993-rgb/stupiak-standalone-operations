#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

PRODUCTION_ORIGIN="https://stupiaks-ops.sporkburger19.workers.dev"
HEALTH_URL="$PRODUCTION_ORIGIN/api/health"
PWA_WORKER_URL="$PRODUCTION_ORIGIN/sw-v27.js"
DB_NAME="${CLOUDFLARE_OPS_DB_NAME:-stupiaks-ops-realtime}"
QUEUE_NAME="${CLOUDFLARE_SHEET_SYNC_QUEUE_NAME:-stupiaks-ops-sheet-sync}"
DLQ_NAME="${CLOUDFLARE_SHEET_SYNC_DLQ_NAME:-stupiaks-ops-sheet-sync-dlq}"
APP_DATA_PACKS_ID="${CLOUDFLARE_APP_DATA_PACKS_ID:-f62696e1a2f14b8a9e0b84a540c7e997}"
EXPECTED_REVISION="realtime-resilience-v3-pwa-task-bootstrap"
EXPECTED_PWA_TOKEN="shared-task-claim-autosave-pwa-v27"

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
    const found = rows.find((row) =>
      String(row.name || row.database_name || "") === name
    );
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

echo "==> Auditing the no-Sheets submission closure"
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

echo "==> Verifying production revision, D1 schema, Queue, WebSocket and PWA v27"
headers=''
body=''
pwa_body=''
for attempt in $(seq 1 30); do
  headers="$(mktemp)"
  body="$(curl -fsS --max-time 20 -D "$headers" "$HEALTH_URL" || true)"
  pwa_body="$(curl -fsS --max-time 20 "$PWA_WORKER_URL?_=$RANDOM" || true)"
  if grep -Fqi "X-ChefOps-Worker-Revision: $EXPECTED_REVISION" "$headers" \
    && printf '%s' "$body" | health_realtime_ready \
    && printf '%s' "$pwa_body" | grep -Fq "$EXPECTED_PWA_TOKEN"; then
    rm -f "$headers"
    printf '%s\n' "$body"
    echo "REALTIME_DEPLOYMENT_VERIFIED=true"
    echo "D1_MIGRATIONS_APPLIED=true"
    echo "OUTLET_WEBSOCKET_CONFIGURED=true"
    echo "SHEET_SYNC_QUEUE_CONFIGURED=true"
    echo "SHEETS_FAILURE_ISOLATED_FROM_SUBMITS=true"
    echo "PWA_TASK_BOOTSTRAP_READY=true"
    echo "TASK_ALERT_CLAIM_READY=true"
    echo "TASK_DRAFT_AUTOSAVE_READY=true"
    echo "MULTI_DEVICE_TESTING_READY=true"
    exit 0
  fi
  rm -f "$headers"
  sleep 5
done

echo "Deployment command completed, but realtime/PWA readiness was not observed in production." >&2
echo "Expected Worker revision: $EXPECTED_REVISION" >&2
echo "Expected PWA token: $EXPECTED_PWA_TOKEN" >&2
echo "Last health response: $body" >&2
echo "Last PWA response: $pwa_body" >&2
exit 1