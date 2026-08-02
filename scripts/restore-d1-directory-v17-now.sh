#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

PRODUCTION_ORIGIN="https://stupiaks-ops.sporkburger19.workers.dev"
MIGRATION_URL="$PRODUCTION_ORIGIN/api/internal/d1-directory/migrate-once"
DB_NAME="${CLOUDFLARE_OPS_DB_NAME:-stupiaks-ops-realtime}"
QUEUE_NAME="${CLOUDFLARE_SHEET_SYNC_QUEUE_NAME:-stupiaks-ops-sheet-sync}"
DLQ_NAME="${CLOUDFLARE_SHEET_SYNC_DLQ_NAME:-stupiaks-ops-sheet-sync-dlq}"
APP_DATA_PACKS_ID="${CLOUDFLARE_APP_DATA_PACKS_ID:-f62696e1a2f14b8a9e0b84a540c7e997}"
SQL_FILE="scripts/restore-directory-from-master-sheet.sql"
EXPECTED_USERS=9
EXPECTED_OUTLETS=4
EXPECTED_ACTIVE_USERS=9

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

read_counts() {
  node -e '
    const fs = require("node:fs")
    const parsed = JSON.parse(fs.readFileSync(0, "utf8"))
    const groups = Array.isArray(parsed) ? parsed : [parsed]
    const rows = groups.flatMap((group) => group?.results || group?.result?.results || group?.result || [])
    const counts = { User: 0, Outlet: 0, active_users: 0 }
    for (const row of rows) {
      if (row.entity === "User") counts.User = Number(row.count || 0)
      if (row.entity === "Outlet") counts.Outlet = Number(row.count || 0)
      if (row.entity === "active_users") counts.active_users = Number(row.count || 0)
    }
    process.stdout.write(`${counts.User} ${counts.Outlet} ${counts.active_users}`)
  '
}

query_counts() {
  local query json
  query="SELECT entity, COUNT(*) AS count FROM ops_records WHERE entity IN ('User','Outlet') AND deleted_at = '' GROUP BY entity UNION ALL SELECT 'active_users' AS entity, COUNT(*) AS count FROM ops_records WHERE entity = 'User' AND deleted_at = '' AND lower(json_extract(payload_json, '$.status')) = 'active'"
  json="$(npx wrangler d1 execute OPS_DB --remote --config worker/wrangler.production.jsonc --json --command "$query")"
  printf '%s' "$json" | read_counts
}

echo "==> Updating canonical main"
git fetch origin main
git switch main 2>/dev/null || git checkout main
git pull --ff-only origin main

echo "==> Checking Wrangler login"
npx wrangler whoami

[[ -f "$SQL_FILE" ]] || { echo "Missing $SQL_FILE" >&2; exit 1; }
grep -Fq "miltonlim1993@gmail.com" "$SQL_FILE"
grep -Fq "waylenyeo08@gmail.com" "$SQL_FILE"
grep -Fq "RR-KCH" "$SQL_FILE"
grep -Fq "SKONE-BTU" "$SQL_FILE"

OPS_DB_ID="$(npx wrangler d1 list --json | json_database_id "$DB_NAME")"
[[ -n "$OPS_DB_ID" ]] || { echo "Unable to resolve D1 database ID for $DB_NAME" >&2; exit 1; }

export CLOUDFLARE_APP_DATA_PACKS_ID="$APP_DATA_PACKS_ID"
export CLOUDFLARE_OPS_DB_ID="$OPS_DB_ID"
export CLOUDFLARE_SHEET_SYNC_QUEUE_NAME="$QUEUE_NAME"
export CLOUDFLARE_SHEET_SYNC_DLQ_NAME="$DLQ_NAME"
npm run cf:render

echo "==> Copying the exact Master Sheet User and Outlet snapshot directly into D1"
npx wrangler d1 execute OPS_DB --remote --config worker/wrangler.production.jsonc --file "$SQL_FILE"

read -r USER_COUNT OUTLET_COUNT ACTIVE_USER_COUNT <<<"$(query_counts)"
echo "D1_USER_COUNT=$USER_COUNT"
echo "D1_OUTLET_COUNT=$OUTLET_COUNT"
echo "D1_ACTIVE_USER_COUNT=$ACTIVE_USER_COUNT"

if [[ "$USER_COUNT" -ne "$EXPECTED_USERS" || "$OUTLET_COUNT" -ne "$EXPECTED_OUTLETS" || "$ACTIVE_USER_COUNT" -ne "$EXPECTED_ACTIVE_USERS" ]]; then
  echo "D1 directory count does not exactly match the Master Sheet snapshot." >&2
  exit 1
fi

echo "==> Marking the D1 directory bootstrap permanently complete"
MIGRATION_SECRET="$(node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('hex'))")"
printf '%s' "$MIGRATION_SECRET" | npx wrangler secret put D1_DIRECTORY_MIGRATION_SECRET --config worker/wrangler.production.jsonc >/dev/null

marker_ok=false
for attempt in $(seq 1 12); do
  body_file="$(mktemp)"
  status="$(curl -sS --max-time 30 -o "$body_file" -w '%{http_code}' \
    -X POST \
    -H "X-ChefOps-Directory-Migration-Secret: $MIGRATION_SECRET" \
    "$MIGRATION_URL" || true)"
  if [[ "$status" == "200" || "$status" == "201" ]]; then
    if node -e '
      const fs = require("node:fs")
      const body = JSON.parse(fs.readFileSync(process.argv[1], "utf8"))
      if (!body.ok || !body.already_complete) process.exit(1)
      if (Number(body.counts?.users || 0) !== 9) process.exit(2)
      if (Number(body.counts?.outlets || 0) !== 4) process.exit(3)
      if (Number(body.counts?.active_users || 0) !== 9) process.exit(4)
    ' "$body_file"; then
      cat "$body_file"
      echo
      marker_ok=true
      rm -f "$body_file"
      break
    fi
  fi
  echo "Marker attempt $attempt returned HTTP ${status:-000}; retrying..." >&2
  cat "$body_file" >&2 || true
  rm -f "$body_file"
  sleep 5
done

if [[ "$marker_ok" != "true" ]]; then
  echo "D1 rows are restored, but the permanent completion marker was not confirmed." >&2
  exit 1
fi

echo "MASTER_SHEET_USERS_COPIED_TO_D1=true"
echo "MASTER_SHEET_OUTLETS_COPIED_TO_D1=true"
echo "D1_DIRECTORY_COUNTS_VERIFIED=true"
echo "RUNTIME_SHEET_DIRECTORY_IMPORT_DISABLED=true"
echo "D1_DIRECTORY_BOOTSTRAP_MARKED_COMPLETE=true"
echo "V17_DIRECTORY_RESTORE_VERIFIED=true"
