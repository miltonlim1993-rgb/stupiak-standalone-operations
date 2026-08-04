#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

CONFIG="${OPS_WRANGLER_CONFIG:-worker/wrangler.production.jsonc}"
APPROVAL="${APPROVE_LOCAL_AUTH_MIGRATION:-}"
EXPECTED_MIGRATION="0002_local_auth.sql"

if [[ "$APPROVAL" != "YES" ]]; then
  cat >&2 <<'NOTICE'
Local authentication requires one D1 schema migration.
No migration was run.

To approve only the reviewed local-auth schema migration, run:
  APPROVE_LOCAL_AUTH_MIGRATION=YES bash scripts/ops/apply-local-auth-migration.sh
NOTICE
  exit 2
fi

if [[ ! -f "worker/migrations/$EXPECTED_MIGRATION" ]]; then
  echo "Missing reviewed migration: worker/migrations/$EXPECTED_MIGRATION" >&2
  exit 3
fi
if [[ ! -f "$CONFIG" ]]; then
  echo "Missing Wrangler config: $CONFIG" >&2
  exit 4
fi

npx wrangler whoami

MIGRATION_LIST="$(mktemp)"
trap 'rm -f "$MIGRATION_LIST"' EXIT
npx wrangler d1 migrations list OPS_DB --remote --config "$CONFIG" | tee "$MIGRATION_LIST"

if ! grep -Fq "$EXPECTED_MIGRATION" "$MIGRATION_LIST"; then
  echo "$EXPECTED_MIGRATION is not listed as pending. Refusing to guess or reapply it." >&2
  exit 5
fi

OTHER_PENDING="$(grep -Eo '[0-9]{4}_[A-Za-z0-9._-]+\.sql' "$MIGRATION_LIST" | sort -u | grep -Fv "$EXPECTED_MIGRATION" || true)"
if [[ -n "$OTHER_PENDING" ]]; then
  echo "Unexpected additional pending migrations were found:" >&2
  printf '%s\n' "$OTHER_PENDING" >&2
  echo "No migration was run." >&2
  exit 6
fi

printf '%s\n' "==> Applying reviewed schema migration only: $EXPECTED_MIGRATION"
npx wrangler d1 migrations apply OPS_DB --remote --config "$CONFIG"

VERIFY_SQL="SELECT name FROM sqlite_master WHERE type='table' AND name IN ('local_credentials','local_auth_activations','local_auth_rate_limits','local_auth_audit') ORDER BY name;"
VERIFY_OUTPUT="$(npx wrangler d1 execute OPS_DB --remote --config "$CONFIG" --command "$VERIFY_SQL" --json)"
printf '%s\n' "$VERIFY_OUTPUT"

VERIFY_OUTPUT="$VERIFY_OUTPUT" node <<'NODE'
const payload = JSON.parse(process.env.VERIFY_OUTPUT || '[]')
const rows = Array.isArray(payload)
  ? payload.flatMap((entry) => entry?.results || entry?.result || [])
  : (payload?.results || payload?.result || [])
const names = new Set(rows.map((row) => String(row?.name || '')))
const required = [
  'local_credentials',
  'local_auth_activations',
  'local_auth_rate_limits',
  'local_auth_audit',
]
const missing = required.filter((name) => !names.has(name))
if (missing.length) throw new Error(`Local auth schema verification failed: ${missing.join(', ')}`)
console.log('LOCAL_AUTH_SCHEMA_VERIFIED=true')
NODE

cat <<'RESULT'
LOCAL_AUTH_MIGRATION_APPLIED=true
LOCAL_AUTH_MIGRATION_FILE=0002_local_auth.sql
LOCAL_AUTH_SCHEMA_VERIFIED=true
D1_BACKFILL_RUN=false
D1_USER_RECORD_REWRITE=false
D1_HISTORY_DELETE=false
RESULT
