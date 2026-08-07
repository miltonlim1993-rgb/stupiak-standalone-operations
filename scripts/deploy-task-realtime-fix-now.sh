#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

ORIGIN="${OPS_PRODUCTION_ORIGIN:-https://stupiaks-ops.sporkburger19.workers.dev}"
EXPECTED_MARKER="chefops-task-realtime"

cat <<'INFO'
============================================================
Stupiak's OPS — focused Task realtime no-remount deployment

Scope:
  - Fast-forward to current main
  - Install exact locked dependencies
  - Reuse the Mac's existing Wrangler login
  - Build current main
  - Render existing canonical production bindings
  - Deploy Worker + current Web/PWA assets
  - Verify the live Task lazy chunk contains the no-remount fix

Safety:
  D1 migration:       NO
  D1 backfill:        NO
  D1 direct writes:   NO
  Master pack rebuild:NO
  Master watch run:   NO
  Wrangler secret put:NO
============================================================
INFO

if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "Tracked local changes are present. Use a clean clone for this focused deployment." >&2
  git status --short >&2
  exit 1
fi

printf '\n==> Updating to canonical main\n'
git fetch origin main
git switch main 2>/dev/null || git checkout main
git pull --ff-only origin main
DEPLOY_SHA="$(git rev-parse HEAD)"
echo "DEPLOY_SHA=$DEPLOY_SHA"

printf '\n==> Installing exact dependencies\n'
npm ci

printf '\n==> Checking existing local Wrangler login\n'
npx wrangler whoami

printf '\n==> Running OPS contract checks\n'
npm run ops:audit:contract

printf '\n==> Building current Web/PWA + Worker dry-run\n'
npm run build

printf '\n==> Rendering canonical production bindings\n'
npm run cf:render

node <<'NODE'
const fs = require('node:fs')
const c = JSON.parse(fs.readFileSync('worker/wrangler.production.jsonc', 'utf8'))
if (c.main !== 'src/entry-master-watch.js') throw new Error(`Unexpected production entry: ${c.main}`)
if (c.d1_databases?.[0]?.database_id !== '080c13d7-e2f5-4c01-a1ca-aa00094d6fc0') throw new Error('Unexpected OPS D1 binding')
if (c.kv_namespaces?.[0]?.id !== 'f62696e1a2f14b8a9e0b84a540c7e997') throw new Error('Unexpected APP_DATA_PACKS binding')
if (c.queues?.producers?.[0]?.queue !== 'stupiaks-ops-sheet-sync') throw new Error('Unexpected Sheet sync Queue binding')
if (c.r2_buckets?.[0]?.bucket_name !== 'stupiaks-ops-media') throw new Error('Unexpected R2 media binding')
const crons = new Set(c.triggers?.crons || [])
if (!crons.has('*/2 * * * *') || !crons.has('0 * * * *')) throw new Error('Canonical watcher crons are missing')
console.log('CANONICAL_PRODUCTION_BINDINGS_VERIFIED=true')
NODE

printf '\n==> Deploying current main — no migration/backfill/data rewrite\n'
npx wrangler deploy --config worker/wrangler.production.jsonc

printf '\n==> Verifying the actual live Task lazy chunk\n'
export ORIGIN EXPECTED_MARKER
node --input-type=module <<'NODE'
const origin = String(process.env.ORIGIN || '').replace(/\/$/, '')
const marker = String(process.env.EXPECTED_MARKER || '')
const deadline = Date.now() + 180_000
let last = null

async function text(url) {
  const r = await fetch(url, {
    cache: 'no-store',
    headers: { 'Cache-Control': 'no-cache', Accept: '*/*' },
  })
  if (!r.ok) throw new Error(`${r.status} ${url}`)
  return await r.text()
}

while (Date.now() < deadline) {
  const stamp = Date.now()
  try {
    const html = await text(`${origin}/?task_fix_verify=${stamp}`)
    const mainAsset = html.match(/\/assets\/index-[A-Za-z0-9_-]+\.js/)?.[0] || ''
    if (!mainAsset) throw new Error('Main JS asset was not found in live HTML')

    const main = await text(`${origin}${mainAsset}?task_fix_verify=${stamp}`)
    const taskName = main.match(/OperationalTasksLive-[A-Za-z0-9_-]+\.js/)?.[0] || ''
    if (!taskName) throw new Error('OperationalTasksLive lazy chunk was not found in live main bundle')

    const taskAsset = `/assets/${taskName}`
    const task = await text(`${origin}${taskAsset}?task_fix_verify=${stamp}`)
    last = { mainAsset, taskAsset, markerPresent: task.includes(marker) }

    if (last.markerPresent) {
      console.log(`LIVE_MAIN_ASSET=${mainAsset}`)
      console.log(`LIVE_TASK_ASSET=${taskAsset}`)
      console.log('TASK_REALTIME_NO_REMOUNT_LIVE=true')
      console.log('PRODUCTION_DEPLOYMENT_VERIFIED=true')
      console.log('D1_MIGRATION_RUN=false')
      console.log('D1_BACKFILL_RUN=false')
      console.log('MASTER_PACK_REBUILD_RUN=false')
      process.exit(0)
    }
  } catch (error) {
    last = { ...(last || {}), error: String(error?.message || error) }
  }
  await new Promise((resolve) => setTimeout(resolve, 5000))
}

console.error(JSON.stringify(last, null, 2))
throw new Error('Production did not expose the Task no-remount bundle marker')
NODE
