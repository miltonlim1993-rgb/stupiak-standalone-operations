#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DB_NAME="${CLOUDFLARE_OPS_DB_NAME:-stupiaks-ops-realtime}"
STAMP="$(date +%Y%m%d-%H%M%S)"
OUTPUT_DIR="${OPS_AUDIT_DIR:-$ROOT_DIR/audit/d1-readonly-$STAMP}"
ARCHIVE="${OUTPUT_DIR%/*}/stupiaks-d1-readonly-$STAMP.zip"

mkdir -p "$OUTPUT_DIR"
cd "$ROOT_DIR"

assert_select_only() {
  local sql="$1"
  local normalized
  normalized="$(printf '%s' "$sql" | tr '\n\r\t' '   ' | tr -s '[:space:]' ' ' | tr '[:lower:]' '[:upper:]')"
  if ! grep -Eq '^[[:space:]]*(SELECT|WITH)[[:space:]]' <<<"$normalized"; then
    echo "Refusing non-read-only SQL: $sql" >&2
    exit 2
  fi
  if grep -Eq '(^|[^A-Z])(INSERT|UPDATE|DELETE|REPLACE|DROP|ALTER|CREATE|ATTACH|DETACH|VACUUM|PRAGMA[[:space:]]+[^;=]+[=])([^A-Z]|$)' <<<"$normalized"; then
    echo "Refusing SQL containing a write/schema keyword: $sql" >&2
    exit 2
  fi
}

assert_zero_writes() {
  local file="$1"
  node - "$file" <<'NODE'
const fs = require('node:fs')
const file = process.argv[2]
const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
const blocks = Array.isArray(parsed) ? parsed : [parsed]
for (const block of blocks) {
  const meta = block?.meta || {}
  if (Number(meta.changes || 0) !== 0) throw new Error(`${file}: changes was not zero`)
  if (Number(meta.rows_written || 0) !== 0) throw new Error(`${file}: rows_written was not zero`)
  if (meta.changed_db === true) throw new Error(`${file}: changed_db was true`)
}
NODE
}

run_query() {
  local number="$1"
  local slug="$2"
  local sql="$3"
  local output="$OUTPUT_DIR/${number}-${slug}.json"
  assert_select_only "$sql"
  printf '\n[%s-%s]\n%s\n' "$number" "$slug" "$sql"
  npx wrangler d1 execute "$DB_NAME" --remote --json --command "$sql" > "$output"
  assert_zero_writes "$output"
}

echo "Checking existing Wrangler OAuth..."
npx wrangler whoami | tee "$OUTPUT_DIR/00-wrangler-whoami.txt"

run_query "01" "sqlite-schema" \
"SELECT type, name, tbl_name, sql
 FROM sqlite_schema
 WHERE name NOT LIKE 'sqlite_%'
 ORDER BY CASE type WHEN 'table' THEN 1 WHEN 'index' THEN 2 WHEN 'trigger' THEN 3 ELSE 4 END, name;"

run_query "02" "ops-records-entity-counts" \
"SELECT entity,
 SUM(CASE WHEN deleted_at = '' THEN 1 ELSE 0 END) AS active_count,
 SUM(CASE WHEN deleted_at <> '' THEN 1 ELSE 0 END) AS deleted_count,
 COUNT(*) AS total_count
 FROM ops_records
 GROUP BY entity
 ORDER BY entity;"

run_query "03" "existing-entities" \
"SELECT DISTINCT entity FROM ops_records ORDER BY entity;"

run_query "04" "directory-counts" \
"SELECT
 SUM(CASE WHEN entity = 'User' AND deleted_at = '' THEN 1 ELSE 0 END) AS users,
 SUM(CASE WHEN entity = 'Outlet' AND deleted_at = '' THEN 1 ELSE 0 END) AS outlets,
 SUM(CASE WHEN entity = 'User' AND deleted_at = ''
   AND lower(json_extract(payload_json, '$.status')) = 'active' THEN 1 ELSE 0 END) AS active_users
 FROM ops_records
 WHERE entity IN ('User','Outlet');"

run_query "05" "duplicate-entity-ids" \
"SELECT entity, entity_id, COUNT(*) AS copies
 FROM ops_records
 GROUP BY entity, entity_id
 HAVING COUNT(*) > 1
 ORDER BY copies DESC, entity, entity_id;"

run_query "06" "outbox-status" \
"SELECT status, COUNT(*) AS row_count, MAX(attempts) AS max_attempts,
 MIN(next_attempt_at) AS oldest_next_attempt_at,
 MAX(last_error) AS sample_last_error
 FROM sheet_sync_outbox
 GROUP BY status
 ORDER BY status;"

run_query "07" "mutation-counts" \
"SELECT entity, operation, COUNT(*) AS mutation_count,
 MIN(committed_at) AS first_committed_at,
 MAX(committed_at) AS last_committed_at
 FROM ops_mutations
 GROUP BY entity, operation
 ORDER BY entity, operation;"

run_query "08" "user-directory" \
"SELECT entity_id, outlet_id, status, version, created_at, updated_at, deleted_at,
 json_extract(payload_json, '$.email') AS email,
 json_extract(payload_json, '$.full_name') AS full_name,
 json_extract(payload_json, '$.role') AS role,
 json_extract(payload_json, '$.status') AS payload_status
 FROM ops_records
 WHERE entity = 'User'
 ORDER BY lower(json_extract(payload_json, '$.email'));"

run_query "09" "outlet-directory" \
"SELECT entity_id, outlet_id, status, version, created_at, updated_at, deleted_at,
 json_extract(payload_json, '$.name') AS name,
 json_extract(payload_json, '$.code') AS code
 FROM ops_records
 WHERE entity = 'Outlet'
 ORDER BY entity_id;"

run_query "10" "records-by-outlet" \
"SELECT entity, outlet_id,
 SUM(CASE WHEN deleted_at = '' THEN 1 ELSE 0 END) AS active_count,
 SUM(CASE WHEN deleted_at <> '' THEN 1 ELSE 0 END) AS deleted_count,
 COUNT(*) AS total_count
 FROM ops_records
 GROUP BY entity, outlet_id
 ORDER BY entity, outlet_id;"

run_query "11" "protected-production-counts" \
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
 ORDER BY entity;"

cat > "$OUTPUT_DIR/README.txt" <<EOF
Stupiak's OPS remote D1 read-only audit
Database: $DB_NAME
Generated: $STAMP

Every SQL statement was checked for SELECT/WITH-only syntax.
Every Wrangler JSON result was checked for:
- changes = 0
- rows_written = 0
- changed_db != true
EOF

(
  cd "$(dirname "$OUTPUT_DIR")"
  zip -qr "$ARCHIVE" "$(basename "$OUTPUT_DIR")"
)

echo
echo "READ_ONLY_AUDIT_COMPLETE=true"
echo "OUTPUT_DIR=$OUTPUT_DIR"
echo "ARCHIVE=$ARCHIVE"
echo
echo "Entity counts:"
cat "$OUTPUT_DIR/02-ops-records-entity-counts.json"
echo
echo "Directory counts:"
cat "$OUTPUT_DIR/04-directory-counts.json"
