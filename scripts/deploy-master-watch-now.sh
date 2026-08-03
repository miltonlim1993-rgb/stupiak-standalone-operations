#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

PRODUCTION_ORIGIN="${OPS_PRODUCTION_ORIGIN:-https://stupiaks-ops.sporkburger19.workers.dev}"
OPS_DB_ID="${CLOUDFLARE_OPS_DB_ID:-080c13d7-e2f5-4c01-a1ca-aa00094d6fc0}"
APP_DATA_PACKS_ID="${CLOUDFLARE_APP_DATA_PACKS_ID:-f62696e1a2f14b8a9e0b84a540c7e997}"
QUEUE_NAME="${CLOUDFLARE_SHEET_SYNC_QUEUE_NAME:-stupiaks-ops-sheet-sync}"
DLQ_NAME="${CLOUDFLARE_SHEET_SYNC_DLQ_NAME:-stupiaks-ops-sheet-sync-dlq}"
MASTER_SPREADSHEET_ID="${GOOGLE_MASTER_SPREADSHEET_ID:-1sy-4AIbZssCmP9HQaq-K4OicXjdvOs2EXVNmvh4bSzM}"
STAMP="$(date +%Y%m%d-%H%M%S)"
AUDIT_DIR="${OPS_RELEASE_AUDIT_DIR:-$ROOT_DIR/audit/master-watch-deploy-$STAMP}"

mkdir -p "$AUDIT_DIR"

echo "============================================================"
echo "Stupiak's OPS Master Data watcher deployment"
echo "  Production:        $PRODUCTION_ORIGIN"
echo "  Master spreadsheet: $MASTER_SPREADSHEET_ID"
echo "  D1 migration:      NO"
echo "  D1 backfill:       NO"
echo "  D1 direct writes:  NO"
echo "  Master watch cron: */2 * * * *"
echo "============================================================"

echo "==> Requiring a clean tracked worktree"
if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "Tracked local changes are present. Commit or stash them before production deployment." >&2
  git status --short >&2
  exit 1
fi

echo "==> Checking existing local Wrangler OAuth"
npx wrangler whoami | tee "$AUDIT_DIR/00-wrangler-whoami.txt"

echo "==> Fast-forwarding canonical main"
git fetch origin main
if ! git switch main 2>/dev/null; then git checkout main; fi
git pull --ff-only origin main
git rev-parse HEAD | tee "$AUDIT_DIR/01-main-commit.txt"

if [[ ! -f worker/src/entry-master-watch.js || ! -f worker/src/master-data-watch.js ]]; then
  echo "Master watcher source is missing from main." >&2
  exit 1
fi

echo "==> Installing exact dependencies"
npm ci

echo "==> Running architecture and watcher contract tests"
npm run ops:audit:contract | tee "$AUDIT_DIR/02-architecture-contract.txt"

echo "==> Building Web and Worker dry-run"
npm run build | tee "$AUDIT_DIR/03-build.txt"

export CLOUDFLARE_APP_DATA_PACKS_ID="$APP_DATA_PACKS_ID"
export CLOUDFLARE_OPS_DB_ID="$OPS_DB_ID"
export CLOUDFLARE_SHEET_SYNC_QUEUE_NAME="$QUEUE_NAME"
export CLOUDFLARE_SHEET_SYNC_DLQ_NAME="$DLQ_NAME"
export GOOGLE_MASTER_SPREADSHEET_ID="$MASTER_SPREADSHEET_ID"

echo "==> Rendering canonical production bindings"
npm run cf:render | tee "$AUDIT_DIR/04-render.txt"

node <<'NODE'
const fs = require('node:fs')
const config = JSON.parse(fs.readFileSync('worker/wrangler.production.jsonc', 'utf8'))
if (config.main !== 'src/entry-master-watch.js') {
  throw new Error(`Unexpected production entry: ${config.main}`)
}
const crons = new Set(config.triggers?.crons || [])
if (!crons.has('*/2 * * * *')) throw new Error('Missing two-minute Master watcher cron')
if (!crons.has('0 * * * *')) throw new Error('Missing hourly full-rebuild safety cron')
if (config.d1_databases?.[0]?.database_name !== 'stupiaks-ops-realtime') {
  throw new Error('Unexpected production D1 binding')
}
const expectedMasterId = String(process.env.GOOGLE_MASTER_SPREADSHEET_ID || '')
const renderedMasterId = String(config.vars?.GOOGLE_MASTER_SPREADSHEET_ID || '')
if (!expectedMasterId || renderedMasterId !== expectedMasterId) {
  throw new Error('Production Master spreadsheet binding is missing or incorrect')
}
console.log('PRODUCTION_ENTRY_VERIFIED=src/entry-master-watch.js')
console.log('MASTER_SPREADSHEET_BINDING_VERIFIED=true')
console.log('MASTER_WATCH_CRON_VERIFIED=true')
console.log('HOURLY_SAFETY_CRON_VERIFIED=true')
NODE

echo "==> Recording current Cloudflare deployments"
npx wrangler deployments list --config worker/wrangler.production.jsonc \
  > "$AUDIT_DIR/05-deployments-before.txt" 2>&1 || true

echo "==> Deploying Worker and existing Web/PWA assets"
echo "No D1 migration, backfill, import, database creation or historical rewrite will run."
npx wrangler deploy --config worker/wrangler.production.jsonc \
  | tee "$AUDIT_DIR/06-deploy.txt"

echo "==> Waiting for the first scheduled Master watcher publication"
OPS_PRODUCTION_ORIGIN="$PRODUCTION_ORIGIN" node --input-type=module <<'NODE' \
  | tee "$AUDIT_DIR/07-master-watch-health.txt"
const origin = String(process.env.OPS_PRODUCTION_ORIGIN || '').replace(/\/$/, '')
const deadline = Date.now() + 4 * 60_000
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
    const packs = Array.isArray(watch?.packs) ? watch.packs : []
    const hasOutlet = packs.some((pack) => String(pack?.outlet_id || '') === 'RR-KCH')
    if (
      response.ok
      && watch?.policy === 'drive-modified-time-v1'
      && watch?.cron === '*/2 * * * *'
      && watch?.enabled === true
      && watch?.configured === true
      && watch?.state_available === true
      && Boolean(watch?.spreadsheet_id)
      && Boolean(watch?.modified_time)
      && Boolean(watch?.published_at)
      && hasOutlet
    ) {
      console.log(JSON.stringify(data, null, 2))
      console.log('MASTER_WATCH_HEALTH_VERIFIED=true')
      console.log('MASTER_WATCH_FIRST_PUBLISH_CONFIRMED=true')
      process.exit(0)
    }
  } catch (error) {
    last = { error: String(error?.message || error) }
  }
  await new Promise((resolve) => setTimeout(resolve, 10_000))
}

console.error(JSON.stringify(last, null, 2))
throw new Error('Master watcher did not publish and report healthy state within four minutes')
NODE

npx wrangler deployments list --config worker/wrangler.production.jsonc \
  > "$AUDIT_DIR/08-deployments-after.txt" 2>&1 || true

cat <<RESULT

VERIFIED_PRODUCTION_DEPLOYMENT=true
MASTER_SPREADSHEET_BINDING_VERIFIED=true
MASTER_WATCH_DEPLOYED=true
MASTER_WATCH_FIRST_PUBLISH_CONFIRMED=true
D1_MIGRATION_RUN=false
D1_BACKFILL_RUN=false
D1_DIRECT_WRITE_RUN=false
FORMAL_TASK_TESTING_READY=true
AUDIT_DIR=$AUDIT_DIR
RESULT
