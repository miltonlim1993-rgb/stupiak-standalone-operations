#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"
CONFIG="worker/wrangler.production.jsonc"

if [[ ! -f "$CONFIG" ]]; then
  npm run cf:render >/dev/null
fi

SERVICE_ACCOUNT_EMAIL="${GOOGLE_SERVICE_ACCOUNT_EMAIL:-}"
SERVICE_ACCOUNT_PRIVATE_KEY="${GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY:-}"
SERVICE_ACCOUNT_JSON_FILE="${GOOGLE_SERVICE_ACCOUNT_JSON_FILE:-}"

if [[ -n "$SERVICE_ACCOUNT_JSON_FILE" ]]; then
  if [[ ! -f "$SERVICE_ACCOUNT_JSON_FILE" ]]; then
    echo "Google service-account JSON file was not found: $SERVICE_ACCOUNT_JSON_FILE" >&2
    exit 1
  fi
  SERVICE_ACCOUNT_EMAIL="$(node -e "const v=require(process.argv[1]); process.stdout.write(String(v.client_email||''))" "$SERVICE_ACCOUNT_JSON_FILE")"
  SERVICE_ACCOUNT_PRIVATE_KEY="$(node -e "const v=require(process.argv[1]); process.stdout.write(String(v.private_key||''))" "$SERVICE_ACCOUNT_JSON_FILE")"
fi

if [[ -z "$SERVICE_ACCOUNT_EMAIL" || -z "$SERVICE_ACCOUNT_PRIVATE_KEY" ]]; then
  cat >&2 <<'INFO'
Google Sheet backup cannot be enabled without a service-account email and private key.
Set either:
  GOOGLE_SERVICE_ACCOUNT_JSON_FILE=/absolute/path/to/service-account.json
or both:
  GOOGLE_SERVICE_ACCOUNT_EMAIL
  GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY
No secret was changed.
INFO
  exit 1
fi

STATVARA_TOKEN="${STATVARA_OPS_API_TOKEN:-}"
GENERATED_TOKEN=false
if [[ -z "$STATVARA_TOKEN" ]]; then
  STATVARA_TOKEN="$(node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))")"
  GENERATED_TOKEN=true
fi

printf '%s' "$SERVICE_ACCOUNT_EMAIL" \
  | npx wrangler secret put GOOGLE_SERVICE_ACCOUNT_EMAIL --config "$CONFIG" >/dev/null
printf '%s' "$SERVICE_ACCOUNT_PRIVATE_KEY" \
  | npx wrangler secret put GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY --config "$CONFIG" >/dev/null
printf '%s' "$STATVARA_TOKEN" \
  | npx wrangler secret put STATVARA_OPS_API_TOKEN --config "$CONFIG" >/dev/null

TOKEN_FILE="$ROOT_DIR/audit/statvara-ops-token.txt"
mkdir -p "$(dirname "$TOKEN_FILE")"
printf '%s\n' "$STATVARA_TOKEN" > "$TOKEN_FILE"
chmod 600 "$TOKEN_FILE"

cat <<INFO
GOOGLE_SHEET_BACKUP_AUTH_CONFIGURED=true
STATVARA_OPS_API_TOKEN_CONFIGURED=true
STATVARA_TOKEN_GENERATED=$GENERATED_TOKEN
STATVARA_TOKEN_LOCAL_FILE=$TOKEN_FILE
No D1 migration, backfill, import, or production business write was run.
INFO
