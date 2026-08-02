#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

PRODUCTION_ORIGIN="${OPS_PRODUCTION_ORIGIN:-https://stupiaks-ops.sporkburger19.workers.dev}"
DB_NAME="${CLOUDFLARE_OPS_DB_NAME:-stupiaks-ops-realtime}"
OPS_DB_ID="${CLOUDFLARE_OPS_DB_ID:-080c13d7-e2f5-4c01-a1ca-aa00094d6fc0}"
APP_DATA_PACKS_ID="${CLOUDFLARE_APP_DATA_PACKS_ID:-f62696e1a2f14b8a9e0b84a540c7e997}"
QUEUE_NAME="${CLOUDFLARE_SHEET_SYNC_QUEUE_NAME:-stupiaks-ops-sheet-sync}"
DLQ_NAME="${CLOUDFLARE_SHEET_SYNC_DLQ_NAME:-stupiaks-ops-sheet-sync-dlq}"
STAMP="$(date +%Y%m%d-%H%M%S)"
AUDIT_DIR="${OPS_RELEASE_AUDIT_DIR:-$ROOT_DIR/audit/verified-production-deploy-$STAMP}"

mkdir -p "$AUDIT_DIR" "$HOME/Downloads"

manifest_value() {
  local field="$1"
  node - "$field" <<'NODE'
const fs = require('node:fs')
const field = process.argv[2]
const manifest = JSON.parse(fs.readFileSync('web/public/app-release.json', 'utf8'))
const value = manifest[field]
if (value === undefined || value === null || String(value).trim() === '') process.exit(2)
process.stdout.write(String(value))
NODE
}

worker_revision() {
  node <<'NODE'
const fs = require('node:fs')
const source = fs.readFileSync('worker/src/entry.js', 'utf8')
const match = source.match(/const WORKER_REVISION = ['"]([^'"]+)['"]/)
if (!match) process.exit(2)
process.stdout.write(match[1])
NODE
}

normalized_snapshot() {
  npx wrangler d1 execute "$DB_NAME" --remote --json --command \
"SELECT entity,
 COUNT(*) AS total_count,
 COUNT(DISTINCT entity_id) AS unique_ids,
 SUM(CASE WHEN deleted_at = '' THEN 1 ELSE 0 END) AS active_count,
 SUM(CASE WHEN deleted_at <> '' THEN 1 ELSE 0 END) AS deleted_count
 FROM ops_records
 WHERE entity IN (
   'User','Outlet','Task','TaskPhoto','Attendance','StockCount','CloseUp',
   'PrinterProfile','FoodLabel','LabelPrintLog','LabelProduct','LabelRule'
 )
 GROUP BY entity
 ORDER BY entity;" \
  | node <<'NODE'
const fs = require('node:fs')
const input = fs.readFileSync(0, 'utf8').trim()
const parsed = JSON.parse(input)
const block = Array.isArray(parsed) ? parsed[0] : parsed
const meta = block?.meta || {}
if (Number(meta.changes || 0) !== 0) throw new Error('Read-only snapshot reported changes')
if (Number(meta.rows_written || 0) !== 0) throw new Error('Read-only snapshot reported rows_written')
if (meta.changed_db === true) throw new Error('Read-only snapshot changed the database')
const rows = Array.isArray(block?.results) ? block.results : []
rows.sort((a, b) => String(a.entity).localeCompare(String(b.entity)))
process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`)
NODE
}

assert_release_ready() {
  local output="$1"
  node - "$output" <<'NODE'
const fs = require('node:fs')
const output = process.argv[2]
const manifest = JSON.parse(fs.readFileSync('web/public/app-release.json', 'utf8'))
const target = String(manifest.minimum_apk_version || manifest.apk_version || '')
const expectedAsset = String(manifest.apk_asset_name || 'stupiaks-ops-task-sop-alarm.apk')
const api = String(manifest.release_api_url || '')
if (!target || !api) throw new Error('Release manifest is incomplete')
const response = await fetch(`${api}${api.includes('?') ? '&' : '?'}_=${Date.now()}`, {
  cache: 'no-store',
  headers: { Accept: 'application/vnd.github+json', 'Cache-Control': 'no-cache' },
})
if (!response.ok) throw new Error(`GitHub release API returned ${response.status}`)
const release = await response.json()
const identity = `${release.name || ''} ${release.tag_name || ''}`
if (!identity.includes(target)) throw new Error(`Fixed release does not contain target version ${target}`)
const asset = (release.assets || []).find((row) => row.name === expectedAsset)
const sums = (release.assets || []).find((row) => row.name === 'SHA256SUMS.txt')
if (!asset?.browser_download_url) throw new Error(`Missing ${expectedAsset}`)
if (Number(asset.size || 0) < 1_000_000) throw new Error('APK asset is unexpectedly small')
if (!sums?.browser_download_url) throw new Error('Missing SHA256SUMS.txt')
fs.writeFileSync(output, `${JSON.stringify(release, null, 2)}\n`)
console.log(`GITHUB_RELEASE_READY=true`)
console.log(`GITHUB_RELEASE_NAME=${release.name || ''}`)
console.log(`GITHUB_APK_SIZE=${asset.size || 0}`)
NODE
}

echo "============================================================"
echo "Stupiak's OPS verified production deployment"
echo "  Production:       $PRODUCTION_ORIGIN"
echo "  D1:               $DB_NAME ($OPS_DB_ID)"
echo "  D1 migration:     NO"
echo "  D1 backfill:      NO"
echo "  Resource creation:NO"
echo "============================================================"

echo "==> Requiring a clean local worktree"
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

APK_VERSION="$(manifest_value minimum_apk_version)"
PWA_VERSION="$(manifest_value minimum_pwa_version)"
EXPECTED_REVISION="$(worker_revision)"
LATEST_APK="$HOME/Downloads/Stupiaks-Ops-${APK_VERSION}-latest.apk"

printf 'apk_version=%s\npwa_version=%s\nworker_revision=%s\n' \
  "$APK_VERSION" "$PWA_VERSION" "$EXPECTED_REVISION" \
  | tee "$AUDIT_DIR/02-release-contract.txt"

echo "==> Running architecture contract audit"
npm run ops:audit:contract | tee "$AUDIT_DIR/03-architecture-contract.txt"

echo "==> Confirming the signed fixed GitHub release exists before deployment"
assert_release_ready "$AUDIT_DIR/04-github-release.json" | tee "$AUDIT_DIR/04-github-release-check.txt"

echo "==> Saving read-only protected D1 counts before deployment"
normalized_snapshot | tee "$AUDIT_DIR/05-d1-before.json"

export CLOUDFLARE_APP_DATA_PACKS_ID="$APP_DATA_PACKS_ID"
export CLOUDFLARE_OPS_DB_ID="$OPS_DB_ID"
export CLOUDFLARE_SHEET_SYNC_QUEUE_NAME="$QUEUE_NAME"
export CLOUDFLARE_SHEET_SYNC_DLQ_NAME="$DLQ_NAME"

echo "==> Installing exact dependencies"
npm ci

echo "==> Building Web and Worker dry-run"
npm run build | tee "$AUDIT_DIR/06-build.txt"

echo "==> Rendering canonical production bindings"
npm run cf:render | tee "$AUDIT_DIR/07-render.txt"
grep -Fq '"main": "src/entry.js"' worker/wrangler.production.jsonc
grep -Fq '"database_name": "stupiaks-ops-realtime"' worker/wrangler.production.jsonc
grep -Fq '"database_id": "080c13d7-e2f5-4c01-a1ca-aa00094d6fc0"' worker/wrangler.production.jsonc

echo "==> Recording current Cloudflare deployments"
npx wrangler deployments list --config worker/wrangler.production.jsonc \
  > "$AUDIT_DIR/08-deployments-before.txt" 2>&1 || true

echo "==> Deploying Worker and Web/PWA assets"
echo "No D1 migration, database creation, Queue creation, Sheet bootstrap, or marker call will run."
npx wrangler deploy --config worker/wrangler.production.jsonc \
  | tee "$AUDIT_DIR/09-deploy.txt"

echo "==> Verifying production Worker, forced PWA and exact signed APK"
OPS_PRODUCTION_ORIGIN="$PRODUCTION_ORIGIN" \
OPS_VERIFY_OUTPUT_DIR="$AUDIT_DIR/production-verification" \
OPS_APK_OUTPUT="$LATEST_APK" \
node scripts/ops/verify-production-release.mjs \
  | tee "$AUDIT_DIR/10-production-verification.txt"

echo "==> Saving read-only protected D1 counts after deployment"
normalized_snapshot | tee "$AUDIT_DIR/11-d1-after.json"

if ! diff -u "$AUDIT_DIR/05-d1-before.json" "$AUDIT_DIR/11-d1-after.json" \
  | tee "$AUDIT_DIR/12-d1-count-diff.txt"; then
  if [[ "${OPS_ALLOW_D1_COUNT_CHANGE:-0}" != "1" ]]; then
    echo "Protected D1 counts changed during deployment." >&2
    echo "This may be legitimate staff activity, but it requires review before declaring deployment complete." >&2
    echo "Set OPS_ALLOW_D1_COUNT_CHANGE=1 only after reviewing the saved diff." >&2
    exit 1
  fi
fi

npx wrangler deployments list --config worker/wrangler.production.jsonc \
  > "$AUDIT_DIR/13-deployments-after.txt" 2>&1 || true

cat <<RESULT

VERIFIED_PRODUCTION_DEPLOYMENT=true
WORKER_REVISION=$EXPECTED_REVISION
APK_REQUIRED_VERSION=$APK_VERSION
PWA_REQUIRED_VERSION=$PWA_VERSION
LATEST_APK=$LATEST_APK
FIXED_APK_MATCH=true
D1_MIGRATION_RUN=false
D1_BACKFILL_RUN=false
D1_RESOURCE_CREATION_RUN=false
D1_COUNTS_UNCHANGED=true
AUDIT_DIR=$AUDIT_DIR
RESULT
