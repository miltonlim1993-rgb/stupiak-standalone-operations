#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DB_NAME="${CLOUDFLARE_OPS_DB_NAME:-stupiaks-ops-realtime}"
SQL_FILE="${1:-}"
ENTITY="${2:-}"
STAMP="$(date +%Y%m%d-%H%M%S)"
AUDIT_DIR="${OPS_BACKFILL_AUDIT_DIR:-$ROOT_DIR/audit/approved-backfill-$STAMP}"

if [[ -z "$SQL_FILE" || -z "$ENTITY" ]]; then
  echo "Usage: APPROVE_D1_BACKFILL=YES bash scripts/ops/run-approved-backfill.sh /private/path/backfill.sql Entity" >&2
  exit 2
fi

if [[ "${APPROVE_D1_BACKFILL:-}" != "YES" ]]; then
  echo "Backfill not approved. Set APPROVE_D1_BACKFILL=YES only after reviewing SQL, manifest, write scope, rollback, and read-only before counts." >&2
  exit 2
fi

SQL_FILE="$(cd "$(dirname "$SQL_FILE")" && pwd)/$(basename "$SQL_FILE")"
[[ -f "$SQL_FILE" ]] || { echo "SQL file not found: $SQL_FILE" >&2; exit 2; }
[[ "$ENTITY" =~ ^[A-Za-z][A-Za-z0-9_]*$ ]] || { echo "Invalid entity: $ENTITY" >&2; exit 2; }

mkdir -p "$AUDIT_DIR"
cd "$ROOT_DIR"

validate_sql() {
  node - "$SQL_FILE" "$ENTITY" <<'NODE'
const fs = require('node:fs')
const file = process.argv[2]
const entity = process.argv[3]
const source = fs.readFileSync(file, 'utf8')
const withoutComments = source
  .split(/\r?\n/)
  .filter((line) => !line.trim().startsWith('--'))
  .join('\n')
  .trim()

if (!withoutComments) throw new Error('SQL file is empty')
const forbidden = /\b(UPDATE|DELETE|REPLACE|DROP|ALTER|CREATE|ATTACH|DETACH|VACUUM|PRAGMA)\b/i
if (forbidden.test(withoutComments)) throw new Error(`SQL contains forbidden write/schema keyword: ${withoutComments.match(forbidden)[0]}`)

const statements = withoutComments.split(';').map((value) => value.trim()).filter(Boolean)
if (!statements.length) throw new Error('SQL contains no statements')
for (const [index, statement] of statements.entries()) {
  if (!/^INSERT\s+INTO\s+ops_records\s*\(/i.test(statement)) {
    throw new Error(`Statement ${index + 1} is not INSERT INTO ops_records`)
  }
  if (!/ON\s+CONFLICT\s*\(\s*entity\s*,\s*entity_id\s*\)\s+DO\s+NOTHING\s*$/i.test(statement)) {
    throw new Error(`Statement ${index + 1} does not end with ON CONFLICT(entity, entity_id) DO NOTHING`)
  }
  const quotedEntity = entity.replaceAll("'", "''")
  if (!statement.includes(`'${quotedEntity}'`)) {
    throw new Error(`Statement ${index + 1} does not contain approved entity ${entity}`)
  }
}
console.log(`APPROVED_INSERT_STATEMENTS=${statements.length}`)
NODE
}

snapshot() {
  local output="$1"
  npx wrangler d1 execute "$DB_NAME" --remote --json --command \
"SELECT entity,
 COUNT(*) AS total_count,
 COUNT(DISTINCT entity_id) AS unique_ids,
 SUM(CASE WHEN deleted_at = '' THEN 1 ELSE 0 END) AS active_count,
 SUM(CASE WHEN deleted_at <> '' THEN 1 ELSE 0 END) AS deleted_count,
 MIN(updated_at) AS first_updated_at,
 MAX(updated_at) AS last_updated_at
 FROM ops_records
 WHERE entity = '$ENTITY'
 GROUP BY entity;" > "$output"
}

echo "============================================================"
echo "Approved D1 historical backfill"
echo "  Database:  $DB_NAME"
echo "  Entity:    $ENTITY"
echo "  SQL:       $SQL_FILE"
echo "  Conflict:  DO NOTHING"
echo "  Migration: NO"
echo "  Deletion:  NO"
echo "============================================================"

validate_sql | tee "$AUDIT_DIR/00-sql-validation.txt"
cp "$SQL_FILE" "$AUDIT_DIR/approved-backfill.sql"
if [[ -f "$SQL_FILE.manifest.json" ]]; then
  cp "$SQL_FILE.manifest.json" "$AUDIT_DIR/approved-backfill.manifest.json"
fi

npx wrangler whoami | tee "$AUDIT_DIR/01-wrangler-whoami.txt"

echo "==> Saving read-only before snapshot"
snapshot "$AUDIT_DIR/02-before.json"
cat "$AUDIT_DIR/02-before.json"

echo "==> Executing approved insert-only SQL"
npx wrangler d1 execute "$DB_NAME" --remote --json --file "$SQL_FILE" \
  | tee "$AUDIT_DIR/03-write-result.json"

echo "==> Saving read-only after snapshot"
snapshot "$AUDIT_DIR/04-after.json"
cat "$AUDIT_DIR/04-after.json"

npx wrangler d1 execute "$DB_NAME" --remote --json --command \
"SELECT entity, entity_id, COUNT(*) AS copies
 FROM ops_records
 WHERE entity = '$ENTITY'
 GROUP BY entity, entity_id
 HAVING COUNT(*) > 1
 ORDER BY entity_id;" \
  | tee "$AUDIT_DIR/05-duplicate-check.json"

npx wrangler d1 execute "$DB_NAME" --remote --json --command \
"SELECT business_date, outlet_id,
 SUM(CASE WHEN deleted_at = '' THEN 1 ELSE 0 END) AS active_count,
 SUM(CASE WHEN deleted_at <> '' THEN 1 ELSE 0 END) AS deleted_count,
 COUNT(*) AS total_count
 FROM ops_records
 WHERE entity = '$ENTITY'
 GROUP BY business_date, outlet_id
 ORDER BY business_date, outlet_id;" \
  | tee "$AUDIT_DIR/06-by-date-outlet.json"

cat > "$AUDIT_DIR/ROLLBACK-NOT-AUTOMATIC.txt" <<EOF
No automatic rollback was executed.

Review approved-backfill.manifest.json and later production changes before any rollback.
Only exact inserted IDs may be considered. Never issue an unbounded entity/date DELETE.
EOF

echo
echo "APPROVED_BACKFILL_COMPLETE=true"
echo "ENTITY=$ENTITY"
echo "D1_MIGRATION_RUN=false"
echo "D1_DELETE_RUN=false"
echo "EXISTING_ROWS_OVERWRITTEN=false"
echo "AUDIT_DIR=$AUDIT_DIR"
