#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

SERVICE_ACCOUNT_JSON="${GOOGLE_SERVICE_ACCOUNT_JSON:-}"
MEDIA_BUCKET_NAME="${CLOUDFLARE_MEDIA_BUCKET_NAME:-stupiaks-ops-media}"
MASTER_SHEET_ID="${GOOGLE_MASTER_SPREADSHEET_ID:-1sy-4AIbZssCmP9HQaq-K4OicXjdvOs2EXVNmvh4bSzM}"
STATVARA_PORT="${STATVARA_OPS_BRIDGE_PORT:-8791}"

if [[ -z "$SERVICE_ACCOUNT_JSON" || ! -f "$SERVICE_ACCOUNT_JSON" ]]; then
  echo "Set GOOGLE_SERVICE_ACCOUNT_JSON to the downloaded Google service-account JSON file." >&2
  echo "Example: GOOGLE_SERVICE_ACCOUNT_JSON=~/Downloads/stupiaks-ops-service-account.json bash scripts/bootstrap-autonomous-runtime.sh" >&2
  exit 2
fi

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

node --input-type=module - "$SERVICE_ACCOUNT_JSON" "$TMP_DIR" <<'NODE'
import fs from 'node:fs'
const [jsonPath, outputDir] = process.argv.slice(2)
const credentials = JSON.parse(fs.readFileSync(jsonPath, 'utf8'))
if (credentials.type !== 'service_account') throw new Error('The JSON file is not a Google service-account key')
if (!credentials.client_email || !credentials.private_key) throw new Error('Service-account email/private_key is missing')
fs.writeFileSync(`${outputDir}/email`, String(credentials.client_email))
fs.writeFileSync(`${outputDir}/private-key`, String(credentials.private_key), { mode: 0o600 })
NODE

SERVICE_ACCOUNT_EMAIL="$(cat "$TMP_DIR/email")"

cat <<INFO
============================================================
Stupiak's OPS autonomous runtime bootstrap
  Google Master auth: Service Account
  Master Sheet:       $MASTER_SHEET_ID
  R2 media bucket:    $MEDIA_BUCKET_NAME
  Statvara bridge:    port $STATVARA_PORT (reserved)
  Google Drive:       optional async backup, disabled by default
  D1 migration:       NO
  D1 backfill:        NO
  Historical rewrite:NO
============================================================
INFO

npx wrangler whoami >/dev/null

if ! npx wrangler r2 bucket list 2>/dev/null | grep -Fq "$MEDIA_BUCKET_NAME"; then
  echo "==> Creating the dedicated R2 media bucket"
  npx wrangler r2 bucket create "$MEDIA_BUCKET_NAME"
else
  echo "==> R2 media bucket already exists"
fi

echo "==> Installing stable Google service-account identity"
printf '%s' "$SERVICE_ACCOUNT_EMAIL" | npx wrangler secret put GOOGLE_SERVICE_ACCOUNT_EMAIL --name stupiaks-ops >/dev/null
cat "$TMP_DIR/private-key" | npx wrangler secret put GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY --name stupiaks-ops >/dev/null

echo
echo "Share the following Google spreadsheets with this service-account email as Editor:"
echo "  $SERVICE_ACCOUNT_EMAIL"
echo "  Master: https://docs.google.com/spreadsheets/d/$MASTER_SHEET_ID/edit"
echo "Also share the Operations, Training, and Label workbooks used by OPS."
echo "Share the existing OPS Drive media root as Viewer so historical photos remain readable."
echo
read -r -p "After sharing the files, press Enter to deploy and verify the complete runtime... " _unused

export CLOUDFLARE_MEDIA_BUCKET_NAME="$MEDIA_BUCKET_NAME"
export GOOGLE_MASTER_SPREADSHEET_ID="$MASTER_SHEET_ID"
export STATVARA_OPS_BRIDGE_PORT="$STATVARA_PORT"
export STATVARA_OPS_API_PATH="${STATVARA_OPS_API_PATH:-/api/ops/v1}"

bash scripts/deploy-master-watch-now.sh

cat <<RESULT
AUTONOMOUS_RUNTIME_BOOTSTRAP_COMPLETE=true
GOOGLE_DATA_AUTH=service_account
MEDIA_PRIMARY_STORAGE=cloudflare-r2
DRIVE_BACKUP_BLOCKS_TASKS=false
STATVARA_OPS_BRIDGE_PORT=$STATVARA_PORT
D1_MIGRATION_RUN=false
D1_BACKFILL_RUN=false
RESULT
