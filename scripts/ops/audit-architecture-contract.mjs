import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const root = process.cwd()
const failures = []

function file(relativePath) {
  const absolute = path.join(root, relativePath)
  if (!existsSync(absolute)) {
    failures.push(`Missing required file: ${relativePath}`)
    return ''
  }
  return readFileSync(absolute, 'utf8')
}

function requireText(relativePath, needle, description = needle) {
  const content = file(relativePath)
  if (!content.includes(needle)) failures.push(`${relativePath}: missing ${description}`)
}

function forbidText(relativePath, needle, description = needle) {
  const content = file(relativePath)
  if (content.includes(needle)) failures.push(`${relativePath}: forbidden ${description}`)
}

function requireBefore(relativePath, first, second, description) {
  const content = file(relativePath)
  const firstIndex = content.indexOf(first)
  const secondIndex = content.indexOf(second)
  if (firstIndex < 0 || secondIndex < 0 || firstIndex >= secondIndex) failures.push(`${relativePath}: ${description}`)
}

const manifestPath = 'web/public/app-release.json'
let manifest = {}
try {
  manifest = JSON.parse(file(manifestPath))
} catch (error) {
  failures.push(`${manifestPath}: invalid JSON (${error.message})`)
}

const apkVersion = String(manifest.apk_version || '').trim()
const minimumApkVersion = String(manifest.minimum_apk_version || '').trim()
const pwaVersion = String(manifest.pwa_version || '').trim()
const minimumPwaVersion = String(manifest.minimum_pwa_version || '').trim()
const apkAssetName = String(manifest.apk_asset_name || '').trim()

if (!apkVersion) failures.push(`${manifestPath}: apk_version is required`)
if (apkVersion !== minimumApkVersion) failures.push(`${manifestPath}: apk_version and minimum_apk_version must match for a forced release`)
if (manifest.force_update !== true) failures.push(`${manifestPath}: force_update must be true for the canonical mandatory release`)
if (!pwaVersion) failures.push(`${manifestPath}: pwa_version is required`)
if (pwaVersion !== minimumPwaVersion) failures.push(`${manifestPath}: pwa_version and minimum_pwa_version must match`)
if (manifest.pwa_force_update !== true) failures.push(`${manifestPath}: pwa_force_update must be true`)
if (apkAssetName !== 'stupiaks-ops-task-sop-alarm.apk') failures.push(`${manifestPath}: canonical APK asset name changed unexpectedly`)
if (!String(manifest.apk_url || '').includes('/android-release-latest/stupiaks-ops-task-sop-alarm.apk')) failures.push(`${manifestPath}: apk_url is not the fixed canonical release URL`)

requireText('web/src/components/AppUpdateBanner.jsx', `const CURRENT_RELEASE = '${apkVersion}'`, 'CURRENT_RELEASE matching app-release.json')
requireText('web/src/components/AppUpdateBanner.jsx', 'Number(asset.size || 0) < 1_000_000', 'minimum APK size verification')
requireText('web/src/components/AppUpdateBanner.jsx', "cache: 'no-store'", 'no-store release manifest fetch')
requireText('web/src/components/AppUpdateBanner.jsx', 'AUTO_OPEN_COOLDOWN_MS', 'mandatory update auto-open cooldown')
requireText('web/src/main.jsx', `const SHELL_VERSION = '${pwaVersion}'`, 'PWA shell version matching app-release.json')

const mainSource = file('web/src/main.jsx')
const serviceWorkerMatch = mainSource.match(/navigator\.serviceWorker\.register\(['"]([^'"]+)['"]/) 
if (!serviceWorkerMatch) {
  failures.push('web/src/main.jsx: versioned service worker registration not found')
} else {
  const serviceWorkerPath = serviceWorkerMatch[1].replace(/^\//, '')
  const serviceWorkerFile = `web/public/${serviceWorkerPath}`
  requireText(serviceWorkerFile, pwaVersion, 'PWA version token')
  requireText(serviceWorkerFile, 'self.skipWaiting()', 'skipWaiting activation')
  requireText(serviceWorkerFile, 'caches.delete', 'old cache deletion')
  requireText(serviceWorkerFile, 'self.clients.claim()', 'client takeover')
}

requireText('scripts/setup-android.mjs', '@capacitor/camera@^8', 'Capacitor Camera plugin installation')
requireText('scripts/setup-android.mjs', '@capacitor/app@^8', 'Capacitor App plugin installation')
requireText('web/src/App.jsx', "import NativeMediaCaptureBridge from '@/components/NativeMediaCaptureBridge'", 'native media capture bridge import')
requireText('web/src/App.jsx', '<NativeMediaCaptureBridge />', 'native media capture bridge mount')
requireText('web/src/components/NativeMediaCaptureBridge.jsx', "capacitor.isPluginAvailable?.('Camera')", 'native Camera availability check')
requireText('web/src/components/NativeMediaCaptureBridge.jsx', "capacitor.registerPlugin?.('Camera')", 'explicit native Camera proxy registration')
requireText('web/src/components/NativeMediaCaptureBridge.jsx', 'camera.takePhoto', 'native camera invocation')
requireText('web/src/components/NativeMediaCaptureBridge.jsx', "cameraDirection: 'REAR'", 'official rear-camera enum value')
requireText('web/src/components/NativeMediaCaptureBridge.jsx', "app.addListener('appRestoredResult'", 'Android restored camera result handling')
requireText('web/src/components/NativeMediaCaptureBridge.jsx', 'publishTaskPhotoCapture', 'direct native capture delivery into Task state')
requireText('web/src/components/NativeMediaCaptureBridge.jsx', 'PENDING_CAPTURE_KEY', 'persisted native capture context')
requireText('web/src/components/NativeMediaCaptureBridge.jsx', 'RESTORED_RESULT_KEY', 'persisted restored camera result')
forbidText('web/src/components/NativeMediaCaptureBridge.jsx', 'new DataTransfer()', 'synthetic DataTransfer bridge for native camera result')
requireText('web/src/components/NativeMediaCaptureBridge.jsx', 'input.showPicker()', 'direct Web/PWA picker fallback')
requireText('web/src/components/NativeMediaCaptureBridge.jsx', 'event.stopImmediatePropagation()', 'hidden input click suppression')
requireText('web/src/pages/OperationalTasksRealtime.jsx', 'subscribeTaskPhotoCapture', 'Task consumes native photo capture event directly')
requireText('web/src/pages/OperationalTasksRealtime.jsx', 'announceTaskPhotoCaptureConsumer(task.id)', 'restored native photo can be replayed when Task opens')
requireText('web/src/pages/OperationalTasksRealtime.jsx', 'data-task-photo-task-id={task.id}', 'native photo capture task context')
requireText('web/src/pages/OperationalTasksRealtime.jsx', 'data-task-photo-outlet-id={outletId}', 'native photo capture outlet context')

forbidText('web/src/pages/OperationalTasksLive.jsx', 'AUTOSAVE_DELAY_MS', 'fixed Task autosave delay')
forbidText('web/src/pages/OperationalTasksLive.jsx', 'autosaveTimer', 'timer-based Task autosave scheduler')
forbidText('web/src/pages/OperationalTasksLive.jsx', 'scheduleSave', 'per-interaction Task autosave scheduler')
forbidText('web/src/pages/OperationalTasksLive.jsx', 'requestIdleCallback', 'idle Task autosave')
forbidText('web/src/pages/OperationalTasksLive.jsx', 'cancelIdleCallback', 'idle Task autosave cancellation')
forbidText('web/src/pages/OperationalTasksLive.jsx', "document.addEventListener('focusout'", 'blur-triggered Task save')
forbidText('web/src/pages/OperationalTasksLive.jsx', 'setInterval(', 'interval Task save')
requireText('web/src/pages/OperationalTasksLive.jsx', "['保存进度', '完成任务']", 'explicit Task save actions')
requireText('web/src/pages/OperationalTasksLive.jsx', 'flushDirtyDraftOnce', 'one-shot dirty draft protection')
requireText('web/src/pages/OperationalTasksLive.jsx', "window.addEventListener('pagehide', flushDirtyDraftOnce)", 'leave-page one-shot draft flush')
requireText('web/src/pages/OperationalTasksLive.jsx', "document.visibilityState === 'hidden'", 'background one-shot draft flush')
requireText('web/src/pages/OperationalTasksLive.jsx', 'pendingCloseButton.current = closeButton', 'save-before-close drawer guard')
requireText('web/src/pages/OperationalTasksLive.jsx', 'observeSaveCompletion', 'event-based save completion observation')

requireText('web/src/lib/viewport-geometry.js', 'window.visualViewport', 'Visual Viewport API tracking')
requireText('web/src/lib/viewport-geometry.js', "--chefops-viewport-height", 'visual viewport height CSS variable')
requireText('web/src/lib/viewport-geometry.js', "--chefops-viewport-bottom", 'visual viewport bottom CSS variable')
requireText('web/src/lib/viewport-geometry.js', "chefops:viewport-changed", 'viewport change event')
requireText('web/src/main.jsx', 'installViewportGeometry()', 'viewport geometry installed before app render')
requireText('web/src/main.jsx', "import '@/responsive-overlays-v33.css'", 'responsive overlay override stylesheet')
requireText('web/src/viewport.css', 'var(--chefops-viewport-height)', 'shell uses real visual viewport height')
requireText('web/src/viewport.css', "data-chefops-keyboard='open'", 'software keyboard layout state')
requireText('web/src/responsive-overlays-v33.css', '.chefops-viewport-overlay', 'viewport-constrained full-screen overlays')
requireText('web/src/responsive-overlays-v33.css', '.chefops-drawer-content', 'responsive drawer geometry')
requireText('web/src/responsive-overlays-v33.css', '@media (min-width: 640px)', 'tablet layout breakpoint')
requireText('web/src/responsive-overlays-v33.css', '@media (min-width: 1024px)', 'desktop layout breakpoint')
requireText('web/src/components/MobileSheet.jsx', 'z-[900]', 'sheet above app navigation')
requireText('web/src/components/MobileSheet.jsx', 'absolute bottom-0', 'sheet positioned inside viewport container')
requireText('web/src/components/AppDrawer.jsx', 'z-[880]', 'drawer overlay above app navigation')
requireText('web/src/components/AppDrawer.jsx', "data-fullscreen={fullScreen ? 'true' : 'false'}", 'responsive full-screen drawer mode')

requireText('worker/src/operational-task-policy.js', "const RETAINED_TEMPLATE_ID = 'tmpl-rr-opening-checklist-v3'", 'canonical retained Opening Preparation template')
requireText('worker/src/operational-task-policy.js', "new Set(['tmpl-rr-daily-standards-v4'])", 'retired overlapping Daily Standards template')
requireText('worker/src/operational-task-policy.js', 'const TASK_PHOTO_LIMIT = 10', 'ten-photo Task policy')
requireText('worker/src/operational-task-policy.js', '同类物品请放在同一张照片一起拍摄', 'group matching items photo guidance')
requireText('worker/src/operational-task-policy.js', 'applyOperationalTaskPolicyResponse', 'bootstrap response policy')
requireText('web/src/lib/operational-task-policy.js', 'installOperationalTaskPolicy', 'client cache-resilience task policy')
requireText('web/src/lib/operational-task-policy.js', 'const TASK_PHOTO_LIMIT = 10', 'client ten-photo policy')
requireText('web/src/lib/operational-task-policy.js', "url?.pathname !== '/api/tasks/operational/bootstrap'", 'client bootstrap policy route')
requireText('web/src/lib/operational-task-policy.js', 'chefops-photo-policy-guidance', 'in-flow staff guidance')
requireText('web/src/main.jsx', 'installOperationalTaskPolicy()', 'operational task policy installed before render')
requireText('web/src/main.jsx', "import '@/operational-task-policy.css'", 'operational task guidance styling')
requireText('worker/src/media-rules.js', 'max_files: 10', 'ten-photo Task and Issue fallback rules')
forbidText('worker/src/media-rules.js', 'max_files: 4', 'old Urgent Issue four-photo limit')
requireText('web/src/components/ProtectedRoute.jsx', "const SENSITIVE_MANAGER_PATHS = new Set(['/ops-control'])", 'manager-only sensitive Ops Control route')
requireText('web/src/components/ProtectedRoute.jsx', "<Navigate to=\"/tasks\"", 'staff redirect from sensitive access route')
requireText('web/src/App.jsx', '<Route path="/tasks" element={<Tasks />} />', 'staff-visible Daily Tasks route')
requireText('web/src/App.jsx', '<Route path="/training" element={<Training />} />', 'staff-visible Training route')
requireText('web/src/App.jsx', '<Route path="/sop/:sopId" element={<GuidedSop />} />', 'staff-visible SOP route')
requireText('docs/TASK-PHOTO-ACCESS-POLICY.md', 'Historical `Task` records are not deleted or rewritten', 'history preservation statement')
requireText('docs/TASK-PHOTO-ACCESS-POLICY.md', 'Ops Control (`/ops-control`) requires `manager` level or above', 'sensitive access policy')

const entrySource = file('worker/src/entry.js')
const revisionMatch = entrySource.match(/const WORKER_REVISION = ['"]([^'"]+)['"]/) 
const workerRevision = String(revisionMatch?.[1] || '').trim()
if (!workerRevision) failures.push('worker/src/entry.js: WORKER_REVISION is required')
requireText('worker/src/entry.js', "import { handleD1Labels } from './realtime-labels-d1.js'", 'D1 Label router import')
requireBefore('worker/src/entry.js', 'const d1LabelsResponse = await handleD1Labels', 'const appResponse = await app.fetch', 'D1 Label router must run before legacy app.fetch fallback')
requireText('worker/src/entry.js', "runtimeUrl.searchParams.set('legacy_seed', '0')", 'legacy Sheet hydration disabled for realtime data reads')
requireText('worker/src/entry.js', "import { applyOperationalTaskPolicyResponse } from './operational-task-policy.js'", 'server operational policy import')
requireBefore('worker/src/entry.js', 'await overlayOperationalBootstrapResponse', 'await applyOperationalTaskPolicyResponse', 'operational policy must run after D1 bootstrap overlay')

requireText('worker/src/label-d1-store.js', "const LABEL_MUTATION_ENTITIES = new Set(['PrinterProfile', 'FoodLabel', 'LabelPrintLog'])", 'approved Label mutation entity allow-list')
requireText('worker/src/label-d1-store.js', 'INSERT INTO ops_records', 'canonical record mutation')
requireText('worker/src/label-d1-store.js', 'INSERT INTO ops_mutations', 'idempotent mutation journal')
requireText('worker/src/label-d1-store.js', 'INSERT INTO sheet_sync_outbox', 'durable Sheet mirror outbox')
requireText('worker/src/label-d1-store.js', 'await db.batch(statements)', 'atomic D1 batch')
requireText('worker/src/label-d1-store.js', "listD1Rows(env, 'LabelProduct'", 'D1 LabelProduct catalog read')
requireText('worker/src/label-d1-store.js', "listD1Rows(env, 'LabelRule'", 'D1 LabelRule catalog read')
requireText('worker/src/label-d1-operations.js', "entity: 'FoodLabel'", 'FoodLabel D1 mutation')
requireText('worker/src/label-d1-operations.js', "entity: 'LabelPrintLog'", 'LabelPrintLog D1 mutation')
requireText('worker/src/label-d1-printer.js', "entity: 'PrinterProfile'", 'PrinterProfile D1 mutation')

const deployScript = 'scripts/deploy-realtime-ops-now.sh'
forbidText(deployScript, 'd1 migrations apply', 'automatic D1 migration in normal deployment')
forbidText(deployScript, 'd1 create', 'automatic D1 database creation in normal deployment')
forbidText(deployScript, 'queues create', 'automatic Queue creation in normal deployment')
forbidText(deployScript, 'migrate-once', 'directory bootstrap marker call in normal deployment')
forbidText(deployScript, 'legacy_seed=1', 'legacy Sheet hydration in normal deployment')
requireText(deployScript, 'D1_MIGRATION_RUN=false', 'explicit no-migration result marker')
requireText(deployScript, 'D1_COUNTS_UNCHANGED=true', 'protected D1 count verification marker')
requireText(deployScript, 'FIXED_APK_MATCH=true', 'fixed APK SHA verification marker')
requireText(deployScript, 'npm run ops:audit:contract', 'architecture audit before deployment')
requireText(deployScript, 'verify-production-release.mjs', 'production Worker/PWA/APK verifier')

requireText('scripts/ops/d1-readonly-audit.sh', 'assert_select_only', 'SELECT-only query guard')
requireText('scripts/ops/d1-readonly-audit.sh', 'assert_zero_writes', 'zero-write metadata guard')
requireText('scripts/ops/build-safe-backfill.mjs', 'ON CONFLICT(entity, entity_id) DO NOTHING', 'insert-only conflict protection')
requireText('scripts/ops/build-safe-backfill.mjs', 'connects_to_d1: false', 'offline SQL generation contract')
requireText('scripts/ops/run-approved-backfill.sh', 'APPROVE_D1_BACKFILL', 'explicit backfill approval')
requireText('scripts/ops/run-approved-backfill.sh', 'ROLLBACK-NOT-AUTOMATIC', 'no automatic broad rollback')

requireText('.github/workflows/android-apk.yml', 'Resolve manifest release contract', 'manifest-derived Android version contract')
requireText('.github/workflows/android-apk.yml', 'Audit canonical OPS architecture contract', 'Android release architecture gate')
forbidText('.github/workflows/android-apk.yml', 'ANDROID_VERSION_NAME: 4.5.15', 'stale hard-coded Android release version')
requireText('.github/workflows/deploy-cloudflare.yml', "if: github.event_name == 'workflow_dispatch'", 'explicit manual production deployment gate')
forbidText('.github/workflows/deploy-cloudflare.yml', 'd1 migrations apply', 'D1 migration in Cloudflare workflow')

requireText('README.md', 'D1 is the canonical runtime database', 'canonical D1 architecture statement')
forbidText('README.md', 'Google Sheets — owner-controlled operational source data', 'outdated Sheet source-of-truth statement')
requireText('AGENTS.md', 'Do not run a D1 migration as part of a normal deployment', 'migration guardrail')
forbidText('deploy/cloudflare/README.md', 'Google Sheets remain the owner-controlled source of truth', 'outdated Sheet source-of-truth statement')
requireText('docs/OPS-D1-PRODUCTION-RUNBOOK.md', 'Required evidence before saying “done”', 'authoritative completion evidence section')

if (failures.length) {
  console.error('OPS architecture contract audit failed:')
  for (const failure of failures) console.error(`- ${failure}`)
  process.exit(1)
}

console.log('OPS_ARCHITECTURE_CONTRACT_OK=true')
console.log(`WORKER_REVISION=${workerRevision}`)
console.log(`APK_VERSION=${apkVersion}`)
console.log(`PWA_VERSION=${pwaVersion}`)
console.log('D1_LABEL_ROUTING_BEFORE_LEGACY=true')
console.log('LABEL_MUTATIONS_ATOMIC=true')
console.log('NATIVE_CAMERA_CAPTURE_BRIDGE=true')
console.log('REGISTERED_NATIVE_CAMERA_PROXY=true')
console.log('NATIVE_CAMERA_DIRECT_TASK_CHANNEL=true')
console.log('ANDROID_CAMERA_RESTORED_RESULT=true')
console.log('NATIVE_CAMERA_SYNTHETIC_DATATRANSFER=false')
console.log('WEB_CAMERA_PICKER_FALLBACK=true')
console.log('EVENT_DRIVEN_TASK_SAVE=true')
console.log('TASK_SAVE_INTERVAL=false')
console.log('TASK_SAVE_ON_INPUT=false')
console.log('TASK_SAVE_ON_CHANGE=false')
console.log('TASK_SAVE_ON_FOCUSOUT=false')
console.log('TASK_SAVE_EXPLICIT_BUTTONS=true')
console.log('TASK_SAVE_DIRTY_CLOSE_ONCE=true')
console.log('TASK_SAVE_DIRTY_BACKGROUND_ONCE=true')
console.log('FIXED_AUTOSAVE_SECONDS=false')
console.log('VISUAL_VIEWPORT_LAYOUT=true')
console.log('PHONE_TABLET_DESKTOP_OVERLAYS=true')
console.log('CANONICAL_OPENING_TASK_ONLY=true')
console.log('TASK_AND_ISSUE_PHOTO_LIMIT=10')
console.log('MATCHING_ITEMS_GROUP_PHOTO_GUIDANCE=true')
console.log('STAFF_TASK_SOP_ACCESS=true')
console.log('OPS_CONTROL_MANAGER_ONLY=true')
console.log('NORMAL_DEPLOYMENT_RUNS_MIGRATION=false')
console.log('SAFE_BACKFILL_GUARDS_PRESENT=true')
console.log('FIXED_APK_VERIFICATION_REQUIRED=true')
