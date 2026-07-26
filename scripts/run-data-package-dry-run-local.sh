#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUTLET="${1:-RR-KCH}"
PORT="${CHEFOPS_DATA_PACKAGE_TEST_PORT:-8791}"
LOG_FILE="${TMPDIR:-/tmp}/stupiaks-data-package-worker-${PORT}.log"
REPORT_DIR="$HOME/.stupiaks-ops-data-packages/reports"
FALLBACK_VARS="$HOME/Projects/chefops-standalone-v1/worker/.dev.vars"
WORKER_VARS="$ROOT/worker/.dev.vars"
WORKER_PID=""
TEMP_VARS=""
PREVIOUS_WORKER_VARS_KIND="missing"
PREVIOUS_WORKER_VARS_LINK=""
PREVIOUS_WORKER_VARS_COPY=""

terminate_tree() {
  local pid="${1:-}"
  [[ -n "$pid" ]] || return 0

  local children=""
  children="$(pgrep -P "$pid" 2>/dev/null || true)"
  for child in $children; do
    terminate_tree "$child"
  done

  if kill -0 "$pid" 2>/dev/null; then
    kill "$pid" 2>/dev/null || true
  fi
}

cleanup() {
  if [[ -n "$WORKER_PID" ]]; then
    terminate_tree "$WORKER_PID"
    wait "$WORKER_PID" 2>/dev/null || true
  fi

  rm -f "$WORKER_VARS"
  if [[ "$PREVIOUS_WORKER_VARS_KIND" == "symlink" ]]; then
    ln -s "$PREVIOUS_WORKER_VARS_LINK" "$WORKER_VARS"
  elif [[ "$PREVIOUS_WORKER_VARS_KIND" == "file" && -n "$PREVIOUS_WORKER_VARS_COPY" ]]; then
    cp "$PREVIOUS_WORKER_VARS_COPY" "$WORKER_VARS"
  fi

  [[ -n "$TEMP_VARS" ]] && rm -f "$TEMP_VARS"
  [[ -n "$PREVIOUS_WORKER_VARS_COPY" ]] && rm -f "$PREVIOUS_WORKER_VARS_COPY"
}
trap cleanup EXIT INT TERM

cd "$ROOT"

if [[ ! -f .dev.vars ]]; then
  if [[ -f "$FALLBACK_VARS" ]]; then
    cp "$FALLBACK_VARS" .dev.vars
    chmod 600 .dev.vars
    echo "Copied existing Google Data configuration into this private workspace."
  else
    echo "Missing $ROOT/.dev.vars"
    echo "No fallback configuration was found at $FALLBACK_VARS"
    exit 1
  fi
fi

for required_name in \
  GOOGLE_DATA_CLIENT_ID \
  GOOGLE_DATA_CLIENT_SECRET \
  GOOGLE_DATA_REFRESH_TOKEN \
  GOOGLE_PUBLISHED_PACKAGE_FOLDER_ID
do
  if ! grep -q "^${required_name}=" .dev.vars; then
    echo "$required_name is missing from $ROOT/.dev.vars"
    exit 1
  fi
done

if command -v lsof >/dev/null 2>&1 && lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "Port $PORT is already in use. Nothing was started."
  lsof -nP -iTCP:"$PORT" -sTCP:LISTEN || true
  exit 1
fi

mkdir -p worker "$REPORT_DIR"

if [[ -L "$WORKER_VARS" ]]; then
  PREVIOUS_WORKER_VARS_KIND="symlink"
  PREVIOUS_WORKER_VARS_LINK="$(readlink "$WORKER_VARS")"
elif [[ -f "$WORKER_VARS" ]]; then
  PREVIOUS_WORKER_VARS_KIND="file"
  PREVIOUS_WORKER_VARS_COPY="$(mktemp "${TMPDIR:-/tmp}/stupiaks-worker-vars-backup.XXXXXX")"
  cp "$WORKER_VARS" "$PREVIOUS_WORKER_VARS_COPY"
fi

TEMP_SECRET="$(node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('hex'))")"
TEMP_VARS="$(mktemp "${TMPDIR:-/tmp}/stupiaks-data-package-vars.XXXXXX")"

grep -v '^APP_PACK_WEBHOOK_SECRET=' .dev.vars > "$TEMP_VARS"
printf '\nAPP_PACK_WEBHOOK_SECRET=%s\n' "$TEMP_SECRET" >> "$TEMP_VARS"
chmod 600 "$TEMP_VARS"
rm -f "$WORKER_VARS"
ln -s "$TEMP_VARS" "$WORKER_VARS"

echo "Generated an isolated one-time local publisher secret."
echo "Production Cloudflare secrets were not read or changed."

printf '\nBuilding web assets...\n'
npm run build -w web

printf '\nStarting isolated local Worker on port %s...\n' "$PORT"
(
  cd worker
  npx wrangler dev --config wrangler.dev.jsonc --port "$PORT"
) >"$LOG_FILE" 2>&1 &
WORKER_PID=$!

READY=0
for _ in $(seq 1 45); do
  if curl -fsS "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1; then
    READY=1
    break
  fi
  if ! kill -0 "$WORKER_PID" 2>/dev/null; then
    break
  fi
  sleep 1
done

if [[ "$READY" != "1" ]]; then
  echo "Local Worker did not become ready. Last log lines:"
  tail -n 80 "$LOG_FILE" || true
  exit 1
fi

printf '\nRunning read-only Data Package v2 Dry Run for %s...\n' "$OUTLET"
APP_PACK_WEBHOOK_SECRET="$TEMP_SECRET" \
npm run package:publish-drive -- \
  --outlet "$OUTLET" \
  --worker-url "http://127.0.0.1:${PORT}" \
  --dry-run

REPORT="$(find "$REPORT_DIR" -type f -name "${OUTLET}-dry-run-*.json" -print0 2>/dev/null | xargs -0 ls -1t 2>/dev/null | head -n 1 || true)"

printf '\nDry Run finished.\n'
echo "Worker log: $LOG_FILE"
if [[ -n "$REPORT" ]]; then
  echo "Report: $REPORT"
  if command -v open >/dev/null 2>&1; then
    open -R "$REPORT" || true
  fi
else
  echo "Report file was not found in $REPORT_DIR"
  exit 1
fi
