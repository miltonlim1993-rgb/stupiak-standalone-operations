#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

PRODUCTION_ORIGIN="${OPS_PRODUCTION_ORIGIN:-https://stupiaks-ops.sporkburger19.workers.dev}"
OPS_DB_ID="${CLOUDFLARE_OPS_DB_ID:-080c13d7-e2f5-4c01-a1ca-aa00094d6fc0}"
APP_DATA_PACKS_ID="${CLOUDFLARE_APP_DATA_PACKS_ID:-f62696e1a2f14b8a9e0b84a540c7e997}"
MEDIA_BUCKET_NAME="${CLOUDFLARE_MEDIA_BUCKET_NAME:-stupiaks-ops-media}"
QUEUE_NAME="${CLOUDFLARE_SHEET_SYNC_QUEUE_NAME:-stupiaks-ops-sheet-sync}"
DLQ_NAME="${CLOUDFLARE_SHEET_SYNC_DLQ_NAME:-stupiaks-ops-sheet-sync-dlq}"
MASTER_SPREADSHEET_ID="${GOOGLE_MASTER_SPREADSHEET_ID:-1sy-4AIbZssCmP9HQaq-K4OicXjdvOs2EXVNmvh4bSzM}"
VERIFY_OUTLET_ID="${OPS_VERIFY_OUTLET_ID:-RR-KCH}"
VERIFY_TEMPLATE_ID="${OPS_VERIFY_TEMPLATE_ID:-tmpl-prod-task-photo-test-v1}"
STATVARA_BRIDGE_PORT="${STATVARA_OPS_BRIDGE_PORT:-8791}"
STATVARA_API_PATH="${STATVARA_OPS_API_PATH:-/api/ops/v1}"
MASTER_WATCH_RUN_SECRET="$(node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))")"
STAMP="$(date +%Y%m%d-%H%M%S)"
AUDIT_DIR="${OPS_RELEASE_AUDIT_DIR:-$ROOT_DIR/audit/autonomous-runtime-deploy-$STAMP}"

mkdir -p "$AUDIT_DIR"

cat <<INFO
============================================================
Stupiak's OPS autonomous production deployment
  Production:         $PRODUCTION_ORIGIN
  Master spreadsheet: $MASTER_SPREADSHEET_ID
  Master auth:        Google Service Account
  Media primary:      Cloudflare R2 / $MEDIA_BUCKET_NAME
  Legacy Drive read:  Service Account
  Drive backup:       disabled and non-blocking
  Statvara bridge:    $STATVARA_BRIDGE_PORT $STATVARA_API_PATH (reserved)
  Verify outlet:      $VERIFY_OUTLET_ID
  Verify template:    $VERIFY_TEMPLATE_ID
  D1 migration:       NO
  D1 backfill:        NO
  D1 direct writes:   NO
============================================================
INFO

if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "Tracked local changes are present. Deployment requires a clean worktree." >&2
  git status --short >&2
  exit 1
fi

npx wrangler whoami | tee "$AUDIT_DIR/00-wrangler-whoami.txt"

git fetch origin main
if ! git switch main 2>/dev/null; then git checkout main; fi
git pull --ff-only origin main
git rev-parse HEAD | tee "$AUDIT_DIR/01-main-commit.txt"

npm ci
npm run ops:audit:contract | tee "$AUDIT_DIR/02-architecture-contract.txt"
npm run build | tee "$AUDIT_DIR/03-build.txt"

export CLOUDFLARE_APP_DATA_PACKS_ID="$APP_DATA_PACKS_ID"
export CLOUDFLARE_OPS_DB_ID="$OPS_DB_ID"
export CLOUDFLARE_MEDIA_BUCKET_NAME="$MEDIA_BUCKET_NAME"
export CLOUDFLARE_SHEET_SYNC_QUEUE_NAME="$QUEUE_NAME"
export CLOUDFLARE_SHEET_SYNC_DLQ_NAME="$DLQ_NAME"
export GOOGLE_MASTER_SPREADSHEET_ID="$MASTER_SPREADSHEET_ID"
export STATVARA_OPS_BRIDGE_PORT="$STATVARA_BRIDGE_PORT"
export STATVARA_OPS_API_PATH="$STATVARA_API_PATH"

npm run cf:render | tee "$AUDIT_DIR/04-render.txt"

node <<'NODE'
const fs = require('node:fs')
const config = JSON.parse(fs.readFileSync('worker/wrangler.production.jsonc', 'utf8'))
if (config.main !== 'src/entry-master-watch.js') throw new Error(`Unexpected production entry: ${config.main}`)
const crons = new Set(config.triggers?.crons || [])
if (!crons.has('*/2 * * * *') || !crons.has('0 * * * *')) throw new Error('Required watcher crons are missing')
if (config.d1_databases?.[0]?.database_name !== 'stupiaks-ops-realtime') throw new Error('Unexpected production D1 binding')
if (config.r2_buckets?.[0]?.binding !== 'MEDIA_BUCKET') throw new Error('MEDIA_BUCKET R2 binding is missing')
if (config.vars?.GOOGLE_DATA_AUTH_MODE !== 'service_account') throw new Error('Master data must use service_account auth')
if (config.vars?.GOOGLE_DRIVE_AUTH_MODE !== 'service_account') throw new Error('Legacy Drive reads must use service_account auth')
if (config.vars?.GOOGLE_DRIVE_BACKUP_MODE !== 'disabled') throw new Error('Drive backup must remain disabled until intentionally activated')
if (config.vars?.MEDIA_PRIMARY_STORAGE !== 'cloudflare-r2') throw new Error('R2 must be canonical media storage')
if (String(config.vars?.STATVARA_OPS_BRIDGE_PORT) !== '8791') throw new Error('Statvara OPS bridge port 8791 was not preserved')
if (String(config.vars?.GOOGLE_MASTER_SPREADSHEET_ID || '') !== String(process.env.GOOGLE_MASTER_SPREADSHEET_ID || '')) throw new Error('Master spreadsheet binding is incorrect')
console.log('PRODUCTION_ENTRY_VERIFIED=src/entry-master-watch.js')
console.log('MASTER_SPREADSHEET_BINDING_VERIFIED=true')
console.log('GOOGLE_SERVICE_ACCOUNT_MODE_VERIFIED=true')
console.log('LEGACY_DRIVE_READ_AUTH_VERIFIED=service_account')
console.log('DRIVE_BACKUP_MODE_VERIFIED=disabled')
console.log('R2_MEDIA_BINDING_VERIFIED=true')
console.log('STATVARA_OPS_BRIDGE_PORT_VERIFIED=8791')
NODE

printf '%s' "$MASTER_WATCH_RUN_SECRET" | npx wrangler secret put MASTER_WATCH_RUN_SECRET --config worker/wrangler.production.jsonc \
  > "$AUDIT_DIR/05-master-watch-run-secret.txt"

npx wrangler deployments list --config worker/wrangler.production.jsonc \
  > "$AUDIT_DIR/06-deployments-before.txt" 2>&1 || true

npx wrangler deploy --config worker/wrangler.production.jsonc \
  | tee "$AUDIT_DIR/07-deploy.txt"

OPS_PRODUCTION_ORIGIN="$PRODUCTION_ORIGIN" node --input-type=module <<'NODE' \
  | tee "$AUDIT_DIR/08-runtime-propagation.txt"
const origin = String(process.env.OPS_PRODUCTION_ORIGIN || '').replace(/\/$/, '')
const deadline = Date.now() + 180_000
let last = null
while (Date.now() < deadline) {
  try {
    const response = await fetch(`${origin}/api/health?_=${Date.now()}`, {
      cache: 'no-store',
      headers: { Accept: 'application/json', 'Cache-Control': 'no-cache' },
    })
    const data = await response.json()
    last = { status: response.status, data }
    const runtime = data?.deployment?.runtime_dependencies
    if (
      response.ok
      && data?.deployment?.master_data_watch?.policy === 'sheets-task-template-fingerprint-v1'
      && runtime?.google_data_auth === 'service_account'
      && runtime?.media_primary_storage === 'cloudflare-r2'
      && runtime?.drive_legacy_read_auth === 'service_account'
      && runtime?.drive_backup_mode === 'disabled_non_blocking'
      && Number(runtime?.statvara_bridge?.port) === 8791
      && runtime?.statvara_bridge?.blocks_store_execution === false
    ) {
      console.log(JSON.stringify(data, null, 2))
      console.log('NEW_WORKER_VERSION_VISIBLE=true')
      console.log('AUTONOMOUS_RUNTIME_BINDINGS_VISIBLE=true')
      process.exit(0)
    }
  } catch (error) {
    last = { error: String(error?.message || error) }
  }
  await new Promise((resolve) => setTimeout(resolve, 5000))
}
console.error(JSON.stringify(last, null, 2))
throw new Error('The autonomous Worker version did not become visible within three minutes')
NODE

OPS_PRODUCTION_ORIGIN="$PRODUCTION_ORIGIN" \
MASTER_WATCH_RUN_SECRET="$MASTER_WATCH_RUN_SECRET" \
OPS_VERIFY_OUTLET_ID="$VERIFY_OUTLET_ID" \
OPS_VERIFY_TEMPLATE_ID="$VERIFY_TEMPLATE_ID" \
node --input-type=module <<'NODE' | tee "$AUDIT_DIR/09-master-watch-immediate-run.txt"
const origin = String(process.env.OPS_PRODUCTION_ORIGIN || '').replace(/\/$/, '')
const secret = String(process.env.MASTER_WATCH_RUN_SECRET || '')
const outletId = String(process.env.OPS_VERIFY_OUTLET_ID || '')
const templateId = String(process.env.OPS_VERIFY_TEMPLATE_ID || '')
const deadline = Date.now() + 240_000
let last = null
while (Date.now() < deadline) {
  try {
    const response = await fetch(`${origin}/api/internal/master-watch/run?_=${Date.now()}`, {
      method: 'POST',
      cache: 'no-store',
      signal: AbortSignal.timeout(220_000),
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache',
        'X-ChefOps-Master-Watch-Secret': secret,
      },
      body: JSON.stringify({ outlet_id: outletId, template_id: templateId }),
    })
    const data = await response.json().catch(() => ({}))
    last = { status: response.status, data }
    if (response.ok && data?.ok === true && data?.verification?.verified === true) {
      console.log(JSON.stringify(data, null, 2))
      console.log('MASTER_WATCH_IMMEDIATE_RUN_VERIFIED=true')
      console.log('TEST_TASK_IN_PUBLISHED_PACK=true')
      process.exit(0)
    }
    if (![403, 404, 429, 500, 502, 503, 504].includes(response.status)) break
  } catch (error) {
    last = { error: String(error?.message || error) }
  }
  await new Promise((resolve) => setTimeout(resolve, 5000))
}
console.error(JSON.stringify(last, null, 2))
throw new Error(last?.data?.error || 'Immediate Master publication did not verify the Test Task')
NODE

OPS_PRODUCTION_ORIGIN="$PRODUCTION_ORIGIN" node --input-type=module <<'NODE' \
  | tee "$AUDIT_DIR/10-master-watch-health.txt"
const origin = String(process.env.OPS_PRODUCTION_ORIGIN || '').replace(/\/$/, '')
const deadline = Date.now() + 90_000
let last = null
while (Date.now() < deadline) {
  try {
    const response = await fetch(`${origin}/api/health?_=${Date.now()}`, {
      cache: 'no-store',
      headers: { Accept: 'application/json', 'Cache-Control': 'no-cache' },
    })
    const data = await response.json()
    last = { status: response.status, data }
    const watch = data?.deployment?.master_data_watch
    const runtime = data?.deployment?.runtime_dependencies
    const packs = Array.isArray(watch?.packs) ? watch.packs : []
    if (
      response.ok
      && watch?.configured === true
      && watch?.auth_mode === 'service_account'
      && watch?.state_available === true
      && watch?.source_fingerprint
      && watch?.published_at
      && !watch?.last_error
      && packs.some((pack) => String(pack?.outlet_id || '') === 'RR-KCH')
      && runtime?.media_primary_storage === 'cloudflare-r2'
      && runtime?.drive_legacy_read_auth === 'service_account'
      && runtime?.drive_backup_mode === 'disabled_non_blocking'
    ) {
      console.log(JSON.stringify(data, null, 2))
      console.log('MASTER_WATCH_HEALTH_VERIFIED=true')
      console.log('MASTER_WATCH_FIRST_PUBLISH_CONFIRMED=true')
      process.exit(0)
    }
  } catch (error) {
    last = { error: String(error?.message || error) }
  }
  await new Promise((resolve) => setTimeout(resolve, 3000))
}
console.error(JSON.stringify(last, null, 2))
throw new Error('Autonomous runtime health did not settle')
NODE

npx wrangler deployments list --config worker/wrangler.production.jsonc \
  > "$AUDIT_DIR/11-deployments-after.txt" 2>&1 || true

cat <<RESULT
VERIFIED_PRODUCTION_DEPLOYMENT=true
AUTONOMOUS_RUNTIME_VERIFIED=true
MASTER_SPREADSHEET_BINDING_VERIFIED=true
GOOGLE_SERVICE_ACCOUNT_MODE_VERIFIED=true
LEGACY_DRIVE_READ_AUTH_VERIFIED=service_account
DRIVE_BACKUP_MODE_VERIFIED=disabled
R2_MEDIA_PRIMARY_VERIFIED=true
DRIVE_BACKUP_BLOCKS_TASKS=false
MASTER_WATCH_IMMEDIATE_RUN_VERIFIED=true
MASTER_WATCH_FIRST_PUBLISH_CONFIRMED=true
TEST_TASK_IN_PUBLISHED_PACK=true
STATVARA_OPS_BRIDGE_PORT=8791
D1_MIGRATION_RUN=false
D1_BACKFILL_RUN=false
D1_DIRECT_WRITE_RUN=false
FORMAL_TASK_TESTING_READY=true
AUDIT_DIR=$AUDIT_DIR
RESULT
