#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

APPROVAL="${APPROVE_LOCAL_AUTH_PRODUCTION:-}"
if [[ "$APPROVAL" != "YES" ]]; then
  cat >&2 <<'NOTICE'
OPS local authentication production activation was not approved.
Nothing was migrated, no secret was changed, and nothing was deployed.

Run only after reviewing the local-auth migration and deployment boundary:
  APPROVE_LOCAL_AUTH_PRODUCTION=YES bash scripts/ops/activate-local-auth-production.sh
NOTICE
  exit 2
fi

PRODUCTION_ORIGIN="${OPS_PRODUCTION_ORIGIN:-https://stupiaks-ops.sporkburger19.workers.dev}"
OPS_DB_ID="${CLOUDFLARE_OPS_DB_ID:-080c13d7-e2f5-4c01-a1ca-aa00094d6fc0}"
APP_DATA_PACKS_ID="${CLOUDFLARE_APP_DATA_PACKS_ID:-f62696e1a2f14b8a9e0b84a540c7e997}"
MEDIA_BUCKET_NAME="${CLOUDFLARE_MEDIA_BUCKET_NAME:-stupiaks-ops-media}"
QUEUE_NAME="${CLOUDFLARE_SHEET_SYNC_QUEUE_NAME:-stupiaks-ops-sheet-sync}"
DLQ_NAME="${CLOUDFLARE_SHEET_SYNC_DLQ_NAME:-stupiaks-ops-sheet-sync-dlq}"
MASTER_SPREADSHEET_ID="${GOOGLE_MASTER_SPREADSHEET_ID:-1sy-4AIbZssCmP9HQaq-K4OicXjdvOs2EXVNmvh4bSzM}"
STATVARA_BRIDGE_PORT="${STATVARA_OPS_BRIDGE_PORT:-8791}"
STATVARA_API_PATH="${STATVARA_OPS_API_PATH:-/api/ops/v1}"
CONFIG="worker/wrangler.production.jsonc"
SECRETS_DIR="${OPS_LOCAL_AUTH_SECRET_DIR:-$HOME/.config/stupiaks-ops}"
SECRETS_FILE="${OPS_LOCAL_AUTH_SECRET_FILE:-$SECRETS_DIR/local-auth-production.env}"
STAMP="$(date +%Y%m%d-%H%M%S)"
AUDIT_DIR="${OPS_RELEASE_AUDIT_DIR:-$ROOT_DIR/audit/local-auth-production-$STAMP}"

mkdir -p "$AUDIT_DIR"
umask 077
mkdir -p "$SECRETS_DIR"

cat <<INFO
============================================================
Stupiak's OPS local authentication production activation
  Production:          $PRODUCTION_ORIGIN
  D1 migration:        0002_local_auth.sql only
  D1 backfill:         NO
  User rewrite:        NO
  History deletion:    NO
  Task/TaskPhoto write:NO
  Google login:        fallback remains enabled
  Owner password:      not created by this script
  Secret values:       never printed
  Secret persistence:  $SECRETS_FILE
============================================================
INFO

if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "Tracked local changes are present. Activation requires a clean worktree." >&2
  git status --short >&2
  exit 3
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

schema_query() {
  local sql="$1"
  npx wrangler d1 execute OPS_DB --remote --config "$CONFIG" --command "$sql" --json
}

json_first_value() {
  local field="$1"
  node -e '
    const fs = require("node:fs")
    const field = process.argv[1]
    const payload = JSON.parse(fs.readFileSync(0, "utf8") || "[]")
    const entries = Array.isArray(payload) ? payload : [payload]
    const rows = entries.flatMap((entry) => entry?.results || entry?.result || [])
    const value = rows[0]?.[field]
    process.stdout.write(value == null ? "" : String(value))
  ' "$field"
}

TABLE_PROBE="$(schema_query "SELECT COUNT(*) AS table_count FROM sqlite_master WHERE type='table' AND name='local_credentials';")"
LOCAL_CREDENTIALS_TABLE_COUNT="$(printf '%s' "$TABLE_PROBE" | json_first_value table_count)"
LOCAL_CREDENTIAL_ROW_COUNT=0
if [[ "$LOCAL_CREDENTIALS_TABLE_COUNT" == "1" ]]; then
  CREDENTIAL_PROBE="$(schema_query "SELECT COUNT(*) AS credential_count FROM local_credentials;")"
  LOCAL_CREDENTIAL_ROW_COUNT="$(printf '%s' "$CREDENTIAL_PROBE" | json_first_value credential_count)"
fi

EXTERNAL_PEPPER="${LOCAL_AUTH_PEPPER:-}"
EXTERNAL_BOOTSTRAP_SECRET="${LOCAL_AUTH_BOOTSTRAP_SECRET:-}"
LOCAL_AUTH_PEPPER=""
LOCAL_AUTH_BOOTSTRAP_SECRET=""

if [[ -f "$SECRETS_FILE" ]]; then
  # shellcheck disable=SC1090
  source "$SECRETS_FILE"
fi
if [[ -n "$EXTERNAL_PEPPER" ]]; then LOCAL_AUTH_PEPPER="$EXTERNAL_PEPPER"; fi
if [[ -n "$EXTERNAL_BOOTSTRAP_SECRET" ]]; then LOCAL_AUTH_BOOTSTRAP_SECRET="$EXTERNAL_BOOTSTRAP_SECRET"; fi

if [[ -z "$LOCAL_AUTH_PEPPER" ]]; then
  if [[ "${LOCAL_CREDENTIAL_ROW_COUNT:-0}" =~ ^[0-9]+$ ]] && (( LOCAL_CREDENTIAL_ROW_COUNT > 0 )); then
    cat >&2 <<ERROR
Local credentials already exist, but the persistent LOCAL_AUTH_PEPPER was not found.
Refusing to rotate the pepper because that would invalidate every existing PIN and password.
Restore $SECRETS_FILE or provide the original LOCAL_AUTH_PEPPER explicitly.
ERROR
    exit 4
  fi
  LOCAL_AUTH_PEPPER="$(node -e "console.log(require('node:crypto').randomBytes(48).toString('hex'))")"
fi

if [[ -z "$LOCAL_AUTH_BOOTSTRAP_SECRET" ]]; then
  LOCAL_AUTH_BOOTSTRAP_SECRET="$(node -e "console.log(require('node:crypto').randomBytes(48).toString('hex'))")"
fi

if (( ${#LOCAL_AUTH_PEPPER} < 64 )); then
  echo "LOCAL_AUTH_PEPPER must contain at least 64 characters." >&2
  exit 5
fi
if (( ${#LOCAL_AUTH_BOOTSTRAP_SECRET} < 64 )); then
  echo "LOCAL_AUTH_BOOTSTRAP_SECRET must contain at least 64 characters." >&2
  exit 6
fi

SECRETS_TMP="$(mktemp "$SECRETS_DIR/.local-auth-production.XXXXXX")"
trap 'rm -f "$SECRETS_TMP"' EXIT
{
  printf 'LOCAL_AUTH_PEPPER=%q\n' "$LOCAL_AUTH_PEPPER"
  printf 'LOCAL_AUTH_BOOTSTRAP_SECRET=%q\n' "$LOCAL_AUTH_BOOTSTRAP_SECRET"
} > "$SECRETS_TMP"
chmod 600 "$SECRETS_TMP"
mv "$SECRETS_TMP" "$SECRETS_FILE"
chmod 600 "$SECRETS_FILE"
trap - EXIT

printf '%s' "$LOCAL_AUTH_PEPPER" \
  | npx wrangler secret put LOCAL_AUTH_PEPPER --config "$CONFIG" \
  > "$AUDIT_DIR/05-local-auth-pepper-secret.txt"
printf '%s' "$LOCAL_AUTH_BOOTSTRAP_SECRET" \
  | npx wrangler secret put LOCAL_AUTH_BOOTSTRAP_SECRET --config "$CONFIG" \
  > "$AUDIT_DIR/06-local-auth-bootstrap-secret.txt"

echo "LOCAL_AUTH_SECRETS_CONFIGURED=true"
echo "LOCAL_AUTH_SECRETS_REUSED_OR_PERSISTED=true"
echo "LOCAL_AUTH_SECRET_VALUES_PRINTED=false"

REQUIRED_TABLES_SQL="SELECT COUNT(*) AS table_count FROM sqlite_master WHERE type='table' AND name IN ('local_credentials','local_auth_activations','local_auth_rate_limits','local_auth_audit');"
REQUIRED_TABLES_PROBE="$(schema_query "$REQUIRED_TABLES_SQL")"
REQUIRED_TABLE_COUNT="$(printf '%s' "$REQUIRED_TABLES_PROBE" | json_first_value table_count)"

if [[ "$REQUIRED_TABLE_COUNT" == "4" ]]; then
  echo "LOCAL_AUTH_MIGRATION_ALREADY_APPLIED=true" | tee "$AUDIT_DIR/07-local-auth-migration.txt"
  MIGRATION_RESULT="already_applied"
else
  APPROVE_LOCAL_AUTH_MIGRATION=YES \
    OPS_WRANGLER_CONFIG="$CONFIG" \
    bash scripts/ops/apply-local-auth-migration.sh \
    | tee "$AUDIT_DIR/07-local-auth-migration.txt"
  MIGRATION_RESULT="applied"
fi

bash scripts/deploy-master-watch-now.sh \
  | tee "$AUDIT_DIR/08-production-deployment.txt"

OPS_PRODUCTION_ORIGIN="$PRODUCTION_ORIGIN" node --input-type=module <<'NODE' \
  | tee "$AUDIT_DIR/09-local-auth-production-verification.txt"
const origin = String(process.env.OPS_PRODUCTION_ORIGIN || '').replace(/\/$/, '')
const deadline = Date.now() + 180_000
let last = null

while (Date.now() < deadline) {
  try {
    const stamp = Date.now()
    const [healthResponse, configResponse] = await Promise.all([
      fetch(`${origin}/api/health?_=${stamp}`, {
        cache: 'no-store',
        headers: { Accept: 'application/json', 'Cache-Control': 'no-cache' },
      }),
      fetch(`${origin}/api/auth/config?_=${stamp}`, {
        cache: 'no-store',
        headers: { Accept: 'application/json', 'Cache-Control': 'no-cache' },
      }),
    ])
    const [health, config] = await Promise.all([
      healthResponse.json().catch(() => ({})),
      configResponse.json().catch(() => ({})),
    ])
    last = {
      health_status: healthResponse.status,
      config_status: configResponse.status,
      health,
      config,
    }
    const local = health?.deployment?.runtime_dependencies?.local_auth
    if (
      healthResponse.ok
      && configResponse.ok
      && local?.mode === 'enabled'
      && local?.schema_ready === true
      && local?.secret_ready === true
      && local?.ready === true
      && local?.registration === 'enabled'
      && local?.google_login === 'fallback'
      && local?.owner_approval_required === true
      && config?.local_enabled === true
      && config?.local_schema_ready === true
      && config?.local_secret_ready === true
      && config?.registration_enabled === true
      && config?.google_enabled === true
      && config?.owner_approval_required === true
    ) {
      console.log(JSON.stringify({ local_auth: local, auth_config: config }, null, 2))
      console.log('LOCAL_AUTH_HEALTH_VERIFIED=true')
      console.log('LOCAL_AUTH_CONFIG_VERIFIED=true')
      console.log('GOOGLE_LOGIN_FALLBACK_VERIFIED=true')
      console.log('OWNER_APPROVAL_REQUIRED_VERIFIED=true')
      process.exit(0)
    }
  } catch (error) {
    last = { error: String(error?.message || error) }
  }
  await new Promise((resolve) => setTimeout(resolve, 4000))
}

console.error(JSON.stringify(last, null, 2))
throw new Error('Local authentication did not become production-ready within three minutes')
NODE

cat <<RESULT
LOCAL_AUTH_PRODUCTION_READY=true
LOCAL_AUTH_MIGRATION_RESULT=$MIGRATION_RESULT
LOCAL_AUTH_SCHEMA_VERIFIED=true
LOCAL_AUTH_SECRETS_CONFIGURED=true
LOCAL_AUTH_SECRET_VALUES_PRINTED=false
OWNER_LOCAL_PASSWORD_SETUP_REQUIRED=true
OWNER_PASSWORD_CREATED_BY_SCRIPT=false
OWNER_APPROVAL_REQUIRED=true
GOOGLE_LOGIN_FALLBACK_ACTIVE=true
D1_BACKFILL_RUN=false
D1_USER_RECORD_REWRITE=false
D1_HISTORY_DELETE=false
TASK_RECORD_WRITE=false
TASK_PHOTO_RECORD_WRITE=false
STATVARA_OPS_BRIDGE_PORT=8791
LOCAL_AUTH_SECRET_FILE=$SECRETS_FILE
AUDIT_DIR=$AUDIT_DIR
RESULT
