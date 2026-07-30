#!/usr/bin/env bash
set -Eeuo pipefail

EXPECTED_BRANCH="feature/task-workflow-v3-apk"
WORKER_URL="https://stupiaks-ops.sporkburger19.workers.dev"
EXPECTED_WORKER_REVISION="no-delete-task-training-package-v27-v4.6.26"
REPORT_DIR="$HOME/.stupiaks-ops-data-packages/reports"

if [[ "$#" -gt 0 ]]; then
  OUTLETS=("$@")
else
  OUTLETS=("RR-KCH" "SKONE-BTU")
fi

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || true)"
if [[ -z "$ROOT" ]]; then
  echo "ERROR: Run this inside the stupiak-standalone-operations repository."
  exit 1
fi
cd "$ROOT"

if [[ "$(git branch --show-current)" != "$EXPECTED_BRANCH" ]]; then
  echo "ERROR: Expected branch $EXPECTED_BRANCH."
  exit 1
fi
if [[ -n "$(git status --porcelain)" ]]; then
  echo "ERROR: Working tree is not clean."
  git status --short
  exit 1
fi

grep -q '"version": "4.6.26"' package.json
grep -q "operational-content-baseline-v27" config/operational-content-baseline-v27.json
grep -q "HOLD_UNTIL_EXPLICIT_APPROVAL" config/android-production-release-baseline.json

PRODUCTION_HEADERS="$(curl -fsSI --max-time 20 "$WORKER_URL/?package-cleanup=$(date +%s)")"
printf '%s\n' "$PRODUCTION_HEADERS" | grep -Fqi "x-chefops-worker-revision: $EXPECTED_WORKER_REVISION"

npm ci
npm run build
mkdir -p "$REPORT_DIR"

for outlet in "${OUTLETS[@]}"; do
  case "$outlet" in
    RR-KCH|SKONE-BTU) ;;
    *)
      echo "ERROR: Unsupported outlet '$outlet'. Review it before adding to this guarded script."
      exit 1
      ;;
  esac

  echo
  echo "=================================================="
  echo "Rebuilding clean Data Package v2 for $outlet"
  echo "=================================================="

  BEFORE="$(find "$REPORT_DIR" -maxdepth 1 -type f -name "${outlet}-publish-*.json" -print 2>/dev/null | sort | tail -n 1 || true)"
  npm run package:publish-drive -- \
    --outlet "$outlet" \
    --worker-url "$WORKER_URL" \
    --actor "no-delete-task-training-package-v27"
  AFTER="$(find "$REPORT_DIR" -maxdepth 1 -type f -name "${outlet}-publish-*.json" -print 2>/dev/null | sort | tail -n 1 || true)"

  if [[ -z "$AFTER" || "$AFTER" == "$BEFORE" ]]; then
    echo "ERROR: No new package report was created for $outlet."
    exit 1
  fi

  python3 - "$AFTER" "$outlet" <<'PY'
import json
import sys
from pathlib import Path

path = Path(sys.argv[1])
outlet = sys.argv[2]
data = json.loads(path.read_text())
assert data.get('outlet_id') == outlet, data.get('outlet_id')
assert data.get('published_version'), 'published_version missing'
manifest = data.get('published_manifest') or {}
modules = manifest.get('modules') or {}
assert set(modules) == {'core', 'inventory', 'tasks', 'training', 'labels'}, sorted(modules)
assert all(int(info.get('bytes') or 0) > 0 for info in modules.values()), modules
print(json.dumps({
    'outlet': outlet,
    'release': data.get('published_version'),
    'modules': sorted(modules),
    'media': len((manifest.get('media') or {}).get('files') or {}),
    'bytes': int(manifest.get('total_bytes') or 0),
    'report': str(path),
}, indent=2))
PY

done

cat <<'EOF'

SUCCESS: Clean operational Data Package v2 releases published.
Included:
- restored active Task v4/v5 baseline;
- valid active SOP, steps, station assets and training courses;
- current label and inventory modules.
Excluded:
- retired v6 Task split;
- SOP-OPS-101 through SOP-OPS-108 duplicate training chapters;
- soft-deleted legacy Task sample-photo rows;
- inactive or deleted SOP steps/assets.
No Sheet upgrade, TaskTemplate apply, Ops Control, Recruitment KV, R2 or Android release command was run.
EOF
