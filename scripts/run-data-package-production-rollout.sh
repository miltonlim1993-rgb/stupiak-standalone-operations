#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUTLET="${1:-RR-KCH}"
BRANCH="${CHEFOPS_DATA_PACKAGE_BRANCH:-feature/data-package-v2}"
WORKER_URL="${CHEFOPS_PRODUCTION_WORKER_URL:-https://stupiaks-ops.sporkburger19.workers.dev}"
KV_ID="${CLOUDFLARE_APP_DATA_PACKS_ID:-f62696e1a2f14b8a9e0b84a540c7e997}"
REPORT_DIR="$HOME/.stupiaks-ops-data-packages/reports"
SECRET_DIR="$HOME/.stupiaks-ops-data-packages/secrets"
SECRET_FILE="$SECRET_DIR/production-data-package-publisher.env"
CONFIG="$ROOT/worker/wrangler.production.jsonc"
EXPECTED_REVISION="data-package-v2-production-publisher-v1"
TEMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/stupiaks-production-rollout.XXXXXX")"
PUBLISH_BODY="$TEMP_DIR/publish-body.json"
VALIDATION_RESULT="$TEMP_DIR/validation.json"
PUBLISH_RESULT="$TEMP_DIR/publish-result.json"
STATUS_RESULT="$TEMP_DIR/status-result.json"
HEALTH_HEADERS="$TEMP_DIR/health-headers.txt"
HEALTH_BODY="$TEMP_DIR/health-body.json"

cleanup() {
  rm -rf "$TEMP_DIR"
}
trap cleanup EXIT INT TERM

fail() {
  echo "❌ $*" >&2
  exit 1
}

latest_report() {
  local pattern="$1"
  find "$REPORT_DIR" -type f -name "$pattern" -print0 2>/dev/null \
    | xargs -0 ls -1t 2>/dev/null \
    | head -n 1 || true
}

cd "$ROOT"

printf '\n==================================================\n'
printf '1. Verify repository and release evidence\n'
printf '==================================================\n'

[[ -d .git ]] || fail "Not a Git repository: $ROOT"
if ! git diff --quiet || ! git diff --cached --quiet; then
  git status --short
  fail "Git working tree contains uncommitted changes"
fi

git fetch origin
git switch "$BRANCH"
git pull --ff-only origin "$BRANCH"

CURRENT_COMMIT="$(git rev-parse HEAD)"
echo "Branch: $BRANCH"
echo "Commit: ${CURRENT_COMMIT:0:12}"

PREPARE_REPORT="$(latest_report "${OUTLET}-prepare-media-*.json")"
RC_REPORT="$(latest_report "${OUTLET}-release-candidate-*.json")"

[[ -n "$PREPARE_REPORT" && -f "$PREPARE_REPORT" ]] || fail "Prepare Media report was not found for $OUTLET"
[[ -n "$RC_REPORT" && -f "$RC_REPORT" ]] || fail "Release Candidate report was not found for $OUTLET"

echo "Prepare Media: $PREPARE_REPORT"
echo "Release Candidate: $RC_REPORT"

PREPARE_REPORT="$PREPARE_REPORT" \
RC_REPORT="$RC_REPORT" \
OUTLET="$OUTLET" \
PUBLISH_BODY="$PUBLISH_BODY" \
VALIDATION_RESULT="$VALIDATION_RESULT" \
CURRENT_COMMIT="$CURRENT_COMMIT" \
python3 - <<'PY'
import json
import os
from pathlib import Path

prepare_path = Path(os.environ['PREPARE_REPORT'])
rc_path = Path(os.environ['RC_REPORT'])
outlet = os.environ['OUTLET']
publish_body_path = Path(os.environ['PUBLISH_BODY'])
validation_path = Path(os.environ['VALIDATION_RESULT'])
commit = os.environ['CURRENT_COMMIT']

prepare = json.loads(prepare_path.read_text(encoding='utf-8'))
rc = json.loads(rc_path.read_text(encoding='utf-8'))

errors = []

def require(condition, message):
    if not condition:
        errors.append(message)

require(prepare.get('schema') == 'stupiaks-ops-data-package-publisher-report-v1', 'Prepare Media report schema is invalid')
require(prepare.get('mode') == 'prepare-media', 'Report is not a Prepare Media report')
require(prepare.get('release_changed') is False, 'Prepare Media report indicates that a release was changed')
require(prepare.get('outlet_id') == outlet, 'Prepare Media outlet does not match requested outlet')
require(rc.get('schema') == 'stupiaks-ops-data-package-release-candidate-report-v1', 'Release Candidate report schema is invalid')
require(rc.get('passed') is True, 'Release Candidate did not pass')
require(rc.get('outlet_id') == outlet, 'Release Candidate outlet does not match requested outlet')
require(rc.get('release_version') == prepare.get('draft_version'), 'Prepare Media and Release Candidate versions do not match')
require(rc.get('source_pack_version') == prepare.get('source_pack_version'), 'Prepare Media and Release Candidate source versions do not match')
require(int(rc.get('checks', {}).get('module_count', 0)) == len(prepare.get('draft_manifest', {}).get('modules', {})), 'Module count does not match')
require(int(rc.get('checks', {}).get('media_count', 0)) == len(prepare.get('media_files', [])), 'Media count does not match')
require(int(rc.get('checks', {}).get('total_bytes', 0)) == int(prepare.get('total_package_bytes', 0)), 'Total package bytes do not match')
require(prepare.get('draft_manifest', {}).get('version') == prepare.get('draft_version'), 'Prepare Media draft manifest version is inconsistent')
require(prepare.get('draft_manifest', {}).get('outlet_id') == outlet, 'Prepare Media draft manifest outlet is inconsistent')

media_files = prepare.get('media_files', [])
manifest_media = prepare.get('draft_manifest', {}).get('media', {}).get('files', {})
require(bool(media_files), 'Prepare Media report contains no media files')

seen_hashes = set()
for index, item in enumerate(media_files, start=1):
    hash_value = str(item.get('hash') or '')
    drive_id = str(item.get('published_drive_file_id') or '')
    require(len(hash_value) == 64, f'Media #{index} has an invalid SHA-256')
    require(hash_value not in seen_hashes, f'Media #{index} duplicates hash {hash_value}')
    require(bool(drive_id) and not drive_id.startswith('dry-run:'), f'Media #{index} is not a real published Drive file')
    require(item.get('dry_run') is False, f'Media #{index} is still marked as dry-run')
    manifest_item = manifest_media.get(hash_value, {})
    require(str(manifest_item.get('source_id') or '') == drive_id, f'Media #{index} Drive ID does not match the draft manifest')
    require(int(manifest_item.get('bytes') or 0) == int(item.get('bytes') or 0), f'Media #{index} byte size does not match the draft manifest')
    seen_hashes.add(hash_value)

if errors:
    print('Release evidence validation failed:')
    for error in errors:
        print(f' - {error}')
    raise SystemExit(1)

publish_body = {
    'outlet_id': outlet,
    'actor': f'production-rollout:{commit[:12]}',
    'expected_source_version': rc['source_pack_version'],
    'expected_version': rc['release_version'],
    'media_files': media_files,
}
publish_body_path.write_text(json.dumps(publish_body, separators=(',', ':')), encoding='utf-8')

validation = {
    'ok': True,
    'outlet_id': outlet,
    'release_version': rc['release_version'],
    'source_pack_version': rc['source_pack_version'],
    'module_count': rc['checks']['module_count'],
    'media_count': rc['checks']['media_count'],
    'total_bytes': rc['checks']['total_bytes'],
    'git_commit': commit,
    'prepare_media_report': str(prepare_path),
    'release_candidate_report': str(rc_path),
}
validation_path.write_text(json.dumps(validation, indent=2) + '\n', encoding='utf-8')
print(f"✅ Release evidence verified: {rc['release_version'][:12]}")
print(f"   Modules: {rc['checks']['module_count']}")
print(f"   Media: {rc['checks']['media_count']}")
print(f"   Bytes: {rc['checks']['total_bytes']}")
PY

EXPECTED_VERSION="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["release_version"])' "$VALIDATION_RESULT")"
EXPECTED_SOURCE_VERSION="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["source_pack_version"])' "$VALIDATION_RESULT")"

printf '\n==================================================\n'
printf '2. Build and verify production configuration\n'
printf '==================================================\n'

npm ci
npm run build
CLOUDFLARE_APP_DATA_PACKS_ID="$KV_ID" npm run cf:render

CONFIG="$CONFIG" KV_ID="$KV_ID" python3 - <<'PY'
import json
import os
from pathlib import Path

path = Path(os.environ['CONFIG'])
config = json.loads(path.read_text(encoding='utf-8'))
errors = []
if config.get('name') != 'stupiaks-ops': errors.append('Worker name must be stupiaks-ops')
if config.get('main') != 'src/entry.js': errors.append('Worker main must be src/entry.js')
kv = {item.get('binding'): item.get('id') for item in config.get('kv_namespaces', [])}
if kv.get('APP_DATA_PACKS') != os.environ['KV_ID']: errors.append('APP_DATA_PACKS KV ID is incorrect')
if config.get('r2_buckets'): errors.append('R2 must remain disabled during Drive media rollout')
if errors:
    for error in errors: print(f' - {error}')
    raise SystemExit(1)
print('✅ Production config verified')
PY

printf '\nChecking Cloudflare authentication...\n'
npx wrangler whoami >/dev/null
printf '✅ Wrangler authentication is available\n'

printf '\n==================================================\n'
printf '3. Install isolated production publisher secret\n'
printf '==================================================\n'

mkdir -p "$SECRET_DIR"
chmod 700 "$SECRET_DIR"

if [[ ! -f "$SECRET_FILE" ]]; then
  GENERATED_SECRET="$(node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('hex'))")"
  printf 'DATA_PACKAGE_PUBLISH_SECRET=%s\n' "$GENERATED_SECRET" > "$SECRET_FILE"
  chmod 600 "$SECRET_FILE"
  unset GENERATED_SECRET
  echo "Created private publisher secret file: $SECRET_FILE"
else
  chmod 600 "$SECRET_FILE"
  echo "Reusing private publisher secret file: $SECRET_FILE"
fi

PUBLISH_SECRET="$(SECRET_FILE="$SECRET_FILE" python3 - <<'PY'
import os
from pathlib import Path

path = Path(os.environ['SECRET_FILE'])
value = ''
for raw in path.read_text(encoding='utf-8').splitlines():
    line = raw.strip()
    if line.startswith('DATA_PACKAGE_PUBLISH_SECRET='):
        value = line.split('=', 1)[1].strip()
        break
if len(value) < 48:
    raise SystemExit('DATA_PACKAGE_PUBLISH_SECRET is missing or too short')
print(value)
PY
)"

printf '%s' "$PUBLISH_SECRET" | npx wrangler secret put DATA_PACKAGE_PUBLISH_SECRET --config "$CONFIG" >/dev/null
echo "✅ Added/updated DATA_PACKAGE_PUBLISH_SECRET"
echo "✅ APP_PACK_WEBHOOK_SECRET was not read, changed or deleted"

printf '\n==================================================\n'
printf '4. Deploy Worker and Web assets\n'
printf '==================================================\n'

npx wrangler deploy --config "$CONFIG"

printf '\nWaiting for production health...\n'
HEALTHY=0
for _ in $(seq 1 30); do
  : > "$HEALTH_HEADERS"
  if curl -sS -D "$HEALTH_HEADERS" -o "$HEALTH_BODY" "$WORKER_URL/api/health" >/dev/null 2>&1; then
    STATUS_CODE="$(awk 'toupper($1) ~ /^HTTP\// { code=$2 } END { print code }' "$HEALTH_HEADERS")"
    REVISION="$(awk -F': ' 'tolower($1)=="x-chefops-worker-revision" { gsub("\r", "", $2); value=$2 } END { print value }' "$HEALTH_HEADERS")"
    if [[ "$STATUS_CODE" == "200" && "$REVISION" == "$EXPECTED_REVISION" ]]; then
      HEALTHY=1
      break
    fi
  fi
  sleep 2
done

if [[ "$HEALTHY" != "1" ]]; then
  echo "Health headers:"
  cat "$HEALTH_HEADERS" || true
  echo "Health body:"
  cat "$HEALTH_BODY" || true
  fail "Production Worker did not report revision $EXPECTED_REVISION"
fi

echo "✅ Production Worker is healthy"
echo "✅ Revision: $EXPECTED_REVISION"

printf '\n==================================================\n'
printf '5. Publish immutable RR-KCH release\n'
printf '==================================================\n'

WORKER_URL="$WORKER_URL" \
PUBLISH_SECRET="$PUBLISH_SECRET" \
PUBLISH_BODY="$PUBLISH_BODY" \
PUBLISH_RESULT="$PUBLISH_RESULT" \
node --input-type=module <<'NODE'
import fs from 'node:fs/promises'

const workerUrl = process.env.WORKER_URL.replace(/\/$/, '')
const body = await fs.readFile(process.env.PUBLISH_BODY, 'utf8')
const response = await fetch(`${workerUrl}/api/internal/data-package-v2/publish`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-ChefOps-Pack-Secret': process.env.PUBLISH_SECRET,
  },
  body,
})
const text = await response.text()
let data = {}
try { data = JSON.parse(text) } catch {}
if (!response.ok) {
  console.error(`Publish failed (${response.status}): ${data.error || data.message || text}`)
  if (data.code) console.error(`Code: ${data.code}`)
  if (data.details) console.error(JSON.stringify(data.details, null, 2))
  process.exit(1)
}
await fs.writeFile(process.env.PUBLISH_RESULT, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
console.log(`✅ Published ${String(data.manifest?.version || '').slice(0, 12)}`)
NODE

ACTUAL_VERSION="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("manifest",{}).get("version",""))' "$PUBLISH_RESULT")"
[[ "$ACTUAL_VERSION" == "$EXPECTED_VERSION" ]] || fail "Published version $ACTUAL_VERSION does not match expected $EXPECTED_VERSION"

printf '\n==================================================\n'
printf '6. Verify Cloudflare latest pointer\n'
printf '==================================================\n'

WORKER_URL="$WORKER_URL" \
PUBLISH_SECRET="$PUBLISH_SECRET" \
OUTLET="$OUTLET" \
STATUS_RESULT="$STATUS_RESULT" \
node --input-type=module <<'NODE'
import fs from 'node:fs/promises'

const workerUrl = process.env.WORKER_URL.replace(/\/$/, '')
let lastError = null
for (let attempt = 0; attempt < 10; attempt += 1) {
  const response = await fetch(`${workerUrl}/api/internal/data-package-v2/status`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-ChefOps-Pack-Secret': process.env.PUBLISH_SECRET,
    },
    body: JSON.stringify({ outlet_id: process.env.OUTLET }),
  })
  const text = await response.text()
  let data = {}
  try { data = JSON.parse(text) } catch {}
  if (response.ok && data.manifest?.version) {
    await fs.writeFile(process.env.STATUS_RESULT, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
    console.log(`✅ Cloudflare latest: ${String(data.manifest.version).slice(0, 12)}`)
    process.exit(0)
  }
  lastError = new Error(data.error || data.message || `Status failed (${response.status})`)
  await new Promise((resolve) => setTimeout(resolve, 1500))
}
console.error(lastError?.message || 'Unable to verify latest pointer')
process.exit(1)
NODE

LATEST_VERSION="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("manifest",{}).get("version",""))' "$STATUS_RESULT")"
[[ "$LATEST_VERSION" == "$EXPECTED_VERSION" ]] || fail "Cloudflare latest $LATEST_VERSION does not match expected $EXPECTED_VERSION"

UNAUTH_STATUS="$(curl -sS -o /dev/null -w '%{http_code}' "$WORKER_URL/api/app/v4/data-package/manifest?outlet_id=$OUTLET" || true)"
[[ "$UNAUTH_STATUS" == "401" ]] || fail "Unauthenticated manifest request returned $UNAUTH_STATUS instead of 401"
echo "✅ Unauthenticated package access remains blocked"

printf '\n==================================================\n'
printf '7. Save production rollout report\n'
printf '==================================================\n'

TIMESTAMP="$(date -u +%Y-%m-%d_%H-%M-%S)"
ROLLOUT_REPORT="$REPORT_DIR/${OUTLET}-production-rollout-${TIMESTAMP}.json"
mkdir -p "$REPORT_DIR"

VALIDATION_RESULT="$VALIDATION_RESULT" \
PUBLISH_RESULT="$PUBLISH_RESULT" \
STATUS_RESULT="$STATUS_RESULT" \
ROLLOUT_REPORT="$ROLLOUT_REPORT" \
WORKER_URL="$WORKER_URL" \
EXPECTED_REVISION="$EXPECTED_REVISION" \
python3 - <<'PY'
import json
import os
from datetime import datetime, timezone
from pathlib import Path

validation = json.loads(Path(os.environ['VALIDATION_RESULT']).read_text(encoding='utf-8'))
published = json.loads(Path(os.environ['PUBLISH_RESULT']).read_text(encoding='utf-8'))
status = json.loads(Path(os.environ['STATUS_RESULT']).read_text(encoding='utf-8'))
report = {
    'schema': 'stupiaks-ops-data-package-production-rollout-v1',
    'passed': True,
    'generated_at': datetime.now(timezone.utc).isoformat(),
    'worker_url': os.environ['WORKER_URL'],
    'worker_revision': os.environ['EXPECTED_REVISION'],
    **validation,
    'published_manifest': published.get('manifest'),
    'verified_latest_manifest': status.get('manifest'),
    'legacy_compatibility_enabled': True,
    'old_app_pack_webhook_secret_changed': False,
}
Path(os.environ['ROLLOUT_REPORT']).write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')
PY

unset PUBLISH_SECRET

echo "✅ Production rollout passed"
echo "Outlet: $OUTLET"
echo "Release: $EXPECTED_VERSION"
echo "Source: $EXPECTED_SOURCE_VERSION"
echo "Worker: $WORKER_URL"
echo "Report: $ROLLOUT_REPORT"
if command -v open >/dev/null 2>&1; then
  open -R "$ROLLOUT_REPORT" || true
fi
