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
requireText('web/src/App.jsx', "import NativeMediaCaptureBridge from '@/components/NativeMediaCaptureBridge'", 'native media capture bridge import')
requireText('web/src/App.jsx', '<NativeMediaCaptureBridge />', 'native media capture bridge mount')
requireText('web/src/components/NativeMediaCaptureBridge.jsx', "capacitor.isPluginAvailable?.('Camera')", 'native Camera availability check')
requireText('web/src/components/NativeMediaCaptureBridge.jsx', "capacitor.registerPlugin?.('Camera')", 'explicit native Camera proxy registration')
requireText('web/src/components/NativeMediaCaptureBridge.jsx', 'camera.takePhoto', 'native camera invocation')
requireText('web/src/components/NativeMediaCaptureBridge.jsx', "cameraDirection: 'REAR'", 'official rear-camera enum value')
requireText('web/src/components/NativeMediaCaptureBridge.jsx', 'new DataTransfer()', 'captured file delivery to existing workflows')
requireText('web/src/components/NativeMediaCaptureBridge.jsx', 'input.showPicker()', 'direct Web/PWA picker fallback')
requireText('web/src/components/NativeMediaCaptureBridge.jsx', 'event.stopImmediatePropagation()', 'hidden input click suppression')

const entrySource = file('worker/src/entry.js')
const revisionMatch = entrySource.match(/const WORKER_REVISION = ['"]([^'"]+)['"]/) 
const workerRevision = String(revisionMatch?.[1] || '').trim()
if (!workerRevision) failures.push('worker/src/entry.js: WORKER_REVISION is required')
requireText('worker/src/entry.js', "import { handleD1Labels } from './realtime-labels-d1.js'", 'D1 Label router import')
requireBefore('worker/src/entry.js', 'const d1LabelsResponse = await handleD1Labels', 'const appResponse = await app.fetch', 'D1 Label router must run before legacy app.fetch fallback')
requireText('worker/src/entry.js', "runtimeUrl.searchParams.set('legacy_seed', '0')", 'legacy Sheet hydration disabled for realtime data reads')

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
console.log('WEB_CAMERA_PICKER_FALLBACK=true')
console.log('NORMAL_DEPLOYMENT_RUNS_MIGRATION=false')
console.log('SAFE_BACKFILL_GUARDS_PRESENT=true')
console.log('FIXED_APK_VERIFICATION_REQUIRED=true')
