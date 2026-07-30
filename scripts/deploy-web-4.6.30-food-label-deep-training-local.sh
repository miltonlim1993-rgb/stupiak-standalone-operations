#!/usr/bin/env bash
set -Eeuo pipefail

EXPECTED_BRANCH="feature/task-workflow-v3-apk"
EXPECTED_ACCOUNT_ID="bb2ac1970975a5018a17c878e61cb88f"
OPS_KV_ID="f62696e1a2f14b8a9e0b84a540c7e997"
RECRUITMENT_KV_ID="ccf52a9b0bb94a4a90889f30a0e623d5"
WORKER_URL="https://stupiaks-ops.sporkburger19.workers.dev"
LOGIN_CLIENT_ID="460544373229-06mv64nt3e78mtse5sc375cobv13i1ii.apps.googleusercontent.com"
EXPECTED_WORKER_REVISION="food-label-deep-training-v31-v4.6.30"
EXPECTED_SHELL_REVISION="4.6.30-food-label-deep-training-v31"
EXPECTED_SW_VERSION="chefops-v4-6-30-food-label-deep-training-v31"

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || true)"
if [[ -z "$ROOT" ]]; then
  echo "ERROR: Run this inside the stupiak-standalone-operations repository."
  exit 1
fi
cd "$ROOT"

CURRENT_BRANCH="$(git branch --show-current)"
if [[ "$CURRENT_BRANCH" != "$EXPECTED_BRANCH" ]]; then
  echo "ERROR: Current branch is '$CURRENT_BRANCH'. Expected '$EXPECTED_BRANCH'."
  exit 1
fi

if [[ -n "$(git status --porcelain)" ]]; then
  echo "ERROR: Working tree is not clean. Commit or stash unrelated changes first."
  git status --short
  exit 1
fi

printf '\n==================================================\n'
echo "1. Pull and verify 4.6.30 Food Label deep training"
echo "=================================================="
git fetch origin "$EXPECTED_BRANCH"
git merge --ff-only "origin/$EXPECTED_BRANCH"
COMMIT="$(git rev-parse HEAD)"
echo "Commit: $COMMIT"

grep -q '"version": "4.6.30"' package.json
grep -q "$EXPECTED_WORKER_REVISION" worker/src/entry-v3.js
grep -q "$EXPECTED_SHELL_REVISION" web/src/main.jsx
grep -q "$EXPECTED_SW_VERSION" web/public/sw.js
grep -q "foodLabelTraining: 'deep-bilingual-12-step-v31'" web/src/main.jsx
grep -q "trainingQuestionBank: 'random-up-to-50-v31'" web/src/main.jsx
grep -q 'installTrainingQuestionRandomV31' web/src/main.jsx
grep -q '4.6.30-random-50-v31' web/src/lib/training-question-random-core-v31.js
grep -q 'randomizeTrainingQuestions(await originalList(...args), 50)' web/src/lib/training-question-random-v31.js
grep -q '"activeStepCount": 12' config/training-content-baseline-v31.json
grep -q '"questionBankSize": 70' config/training-content-baseline-v31.json
grep -q '"questionsPerAttempt": 50' config/training-content-baseline-v31.json
grep -q "import('@/pages/OperationalTasksV2')" web/src/App.jsx
grep -q "import('@/pages/TrainingHubV29')" web/src/App.jsx
grep -q "import('@/pages/GuidedSopLearningV30')" web/src/App.jsx
grep -q 'data-training-hub="ops-compact-v29"' web/src/pages/TrainingHubV29.jsx
grep -q 'data-sop-standard="ops-compact-guided-v30"' web/src/pages/GuidedSopLearningV30.jsx
grep -q 'handleTaskWorkflowV5(request, env, url, context, app)' worker/src/entry-v3.js
grep -q 'handleNoDeletePolicyV27' worker/src/entry-v3.js
grep -q 'hard_delete_disabled' worker/src/no-delete-policy-v27.js
grep -q 'installNoDeleteUiV27' web/src/main.jsx
grep -q 'stable-tspl-v16-date-fit-v22' config/android-production-release-baseline.json
grep -q 'if (isNativeAndroid()) installStableLabelPrintV16()' web/src/main.jsx
grep -q 'else installStableLabelPrintV20()' web/src/main.jsx
if grep -q 'BITMAP\|html-raster' web/src/lib/stable-label-print-v20.js; then
  echo "ERROR: Stable Web print contains Raster/BITMAP. Refusing deployment."
  exit 1
fi

printf '\n==================================================\n'
echo "2. Verify Cloudflare authentication"
echo "=================================================="
WHOAMI_OUTPUT="$(npx wrangler whoami 2>&1)"
printf '%s\n' "$WHOAMI_OUTPUT"
printf '%s\n' "$WHOAMI_OUTPUT" | grep -q "$EXPECTED_ACCOUNT_ID"

printf '\n==================================================\n'
echo "3. Build and test Web, Worker and frozen Android source"
echo "=================================================="
export CLOUDFLARE_ACCOUNT_ID="$EXPECTED_ACCOUNT_ID"
export CLOUDFLARE_APP_DATA_PACKS_ID="$OPS_KV_ID"
export VITE_API_BASE_URL="$WORKER_URL"
export VITE_GOOGLE_LOGIN_CLIENT_ID="$LOGIN_CLIENT_ID"
unset CLOUDFLARE_MEDIA_BUCKET_NAME || true

npm ci
npm run build
bash -n scripts/deploy-web-4.6.30-food-label-deep-training-local.sh
npm run cf:render

CONFIG="worker/wrangler.production.jsonc"
grep -q '"name": "stupiaks-ops"' "$CONFIG"
grep -q "$OPS_KV_ID" "$CONFIG"
if grep -q "$RECRUITMENT_KV_ID" "$CONFIG"; then
  echo "ERROR: Recruitment KV appeared in the Ops config. Refusing deployment."
  exit 1
fi
if grep -q 'MEDIA_BUCKET' "$CONFIG"; then
  echo "ERROR: R2 binding appeared in the Ops config. Refusing deployment."
  exit 1
fi

printf '\n==================================================\n'
echo "4. Deploy Web and Ops Worker only"
echo "=================================================="
npx wrangler deploy --config "$CONFIG"

printf '\n==================================================\n'
echo "5. Verify production 4.6.30"
echo "=================================================="
VERIFIED=""
for attempt in $(seq 1 18); do
  ROOT_HEADERS="$(curl -fsSI --max-time 20 "$WORKER_URL/?acceptance=4.6.30-$COMMIT-$attempt" || true)"
  TRAINING_HEADERS="$(curl -fsSI --max-time 20 "$WORKER_URL/training?acceptance=4.6.30-$COMMIT-$attempt" || true)"
  SOP_HEADERS="$(curl -fsSI --max-time 20 "$WORKER_URL/sop/sop-food-labels?acceptance=4.6.30-$COMMIT-$attempt" || true)"
  SHELL="$(curl -fsS --max-time 20 "$WORKER_URL/sw.js?acceptance=4.6.30-$COMMIT-$attempt" || true)"
  DELETE_RESULT="$(curl -sS --max-time 20 -X DELETE -H 'Accept: application/json' -w '\n%{http_code}' "$WORKER_URL/api/entities/TaskPhoto/no-delete-acceptance-$attempt" || true)"
  DELETE_STATUS="$(printf '%s\n' "$DELETE_RESULT" | tail -n 1)"
  DELETE_BODY="$(printf '%s\n' "$DELETE_RESULT" | sed '$d')"
  if printf '%s' "$ROOT_HEADERS" | grep -Fqi "x-chefops-worker-revision: $EXPECTED_WORKER_REVISION" \
    && printf '%s' "$TRAINING_HEADERS" | grep -Fqi "x-chefops-shell-revision: $EXPECTED_SHELL_REVISION" \
    && printf '%s' "$TRAINING_HEADERS" | grep -Fqi 'cache-control: no-store' \
    && printf '%s' "$SOP_HEADERS" | grep -Fqi 'cache-control: no-store' \
    && printf '%s' "$SHELL" | grep -Fq "$EXPECTED_SW_VERSION" \
    && [[ "$DELETE_STATUS" == "405" ]] \
    && printf '%s' "$DELETE_BODY" | grep -Fq 'hard_delete_disabled'; then
    VERIFIED="yes"
    break
  fi
  sleep 5
done

if [[ "$VERIFIED" != "yes" ]]; then
  echo "ERROR: Deployment completed but 4.6.30 production markers were not visible."
  printf '%s\n' "$ROOT_HEADERS"
  printf '%s\n' "$TRAINING_HEADERS"
  printf '%s\n' "$SOP_HEADERS"
  printf '%s\n' "$DELETE_RESULT"
  exit 1
fi

printf '%s\n' "$ROOT_HEADERS" | grep -Ei '^(HTTP/|x-chefops-worker-revision:|permissions-policy:)'
printf '%s\n' "$TRAINING_HEADERS" | grep -Ei '^(HTTP/|cache-control:|x-chefops-shell-revision:)'
printf '%s\n' "$SOP_HEADERS" | grep -Ei '^(HTTP/|cache-control:|x-chefops-shell-revision:)'
printf '%s\n' "$SHELL" | grep 'const VERSION'
printf '%s\n' "$DELETE_BODY" | python3 -m json.tool
curl -fsS "$WORKER_URL/api/health" | python3 -m json.tool

printf '\n==================================================\n'
echo "SUCCESS: Food Label deep training 4.6.30 deployed"
echo "=================================================="
echo "URL: $WORKER_URL/training"
echo "Commit: $COMMIT"
echo "Food Label SOP: bilingual 12-step deep training"
echo "Certification: 70-question bank, 50 randomly selected per attempt, 80 percent pass"
echo "Existing linked images: eight original step visuals remain"
echo "New scenario images: tracked separately and not falsely marked complete"
echo "Tasks, FIFO, scanner, no-delete and Stable TSPL routes remain unchanged"
echo "Ops KV: $OPS_KV_ID"
echo "Recruitment KV unchanged: $RECRUITMENT_KV_ID"
echo "R2 remains disabled."
echo "No Sheet upgrade, TaskTemplate apply, Data Package publish, Ops Control or Android release command was run."
