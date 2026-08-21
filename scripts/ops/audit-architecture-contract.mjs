import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const root = process.cwd()
const failures = []

function absolute(relativePath) {
  return path.join(root, relativePath)
}

function file(relativePath) {
  const target = absolute(relativePath)
  if (!existsSync(target)) {
    failures.push(`Missing required file: ${relativePath}`)
    return ''
  }
  return readFileSync(target, 'utf8')
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
  if (firstIndex < 0 || secondIndex < 0 || firstIndex >= secondIndex) {
    failures.push(`${relativePath}: ${description}`)
  }
}

function requireAbsent(relativePath, description = 'obsolete path must stay removed') {
  if (existsSync(absolute(relativePath))) failures.push(`${relativePath}: ${description}`)
}

function parseJson(relativePath) {
  try {
    return JSON.parse(file(relativePath))
  } catch (error) {
    failures.push(`${relativePath}: invalid JSON (${error.message})`)
    return {}
  }
}

const packageJson = parseJson('package.json')
const workerPackage = parseJson('worker/package.json')
const productionTemplate = parseJson('worker/wrangler.production.example.jsonc')
const release = parseJson('web/public/app-release.json')

// Canonical production identity and bindings.
if (productionTemplate.name !== 'stupiaks-ops') failures.push('production Worker name must be stupiaks-ops')
if (productionTemplate.main !== 'src/entry-master-watch.js') failures.push('production entry must be src/entry-master-watch.js')
if (productionTemplate.d1_databases?.[0]?.binding !== 'OPS_DB') failures.push('production OPS_DB binding is missing')
if (productionTemplate.d1_databases?.[0]?.database_name !== 'stupiaks-ops-realtime') failures.push('production D1 database name changed unexpectedly')
if (productionTemplate.kv_namespaces?.[0]?.binding !== 'APP_DATA_PACKS') failures.push('production APP_DATA_PACKS binding is missing')
if (productionTemplate.r2_buckets?.[0]?.binding !== 'MEDIA_BUCKET') failures.push('production MEDIA_BUCKET binding is missing')
if (productionTemplate.queues?.producers?.[0]?.binding !== 'SHEET_SYNC_QUEUE') failures.push('production SHEET_SYNC_QUEUE binding is missing')
if (productionTemplate.vars?.LOCAL_AUTH_MODE !== 'enabled') failures.push('production local auth must remain enabled')
if (productionTemplate.vars?.MEDIA_PRIMARY_STORAGE !== 'cloudflare-r2') failures.push('Cloudflare R2 must remain canonical media storage')
const crons = new Set(productionTemplate.triggers?.crons || [])
if (!crons.has('*/2 * * * *') || !crons.has('0 * * * *')) failures.push('canonical watcher/safety crons are missing')

// A second production-named Wrangler config must never reappear.
requireAbsent('worker/wrangler.jsonc', 'unsafe default production-named Wrangler config must stay removed')
requireText('worker/package.json', 'Direct worker deploy is disabled', 'direct Worker deployment kill switch')
forbidText('worker/package.json', '"deploy": "wrangler deploy"', 'bare Worker production deploy')

// Root production commands must resolve to the single verified deployer.
if (packageJson.scripts?.deploy !== 'npm run ops:deploy:verified') failures.push('root deploy must resolve to ops:deploy:verified')
if (packageJson.scripts?.['ops:deploy:verified'] !== 'bash scripts/deploy-master-watch-now.sh') failures.push('ops:deploy:verified must use the canonical deployer')
for (const staleCommand of ['deploy:secrets', 'ops:migrate:local-auth', 'ops:activate:local-auth', 'deploy:workers-builds']) {
  if (Object.prototype.hasOwnProperty.call(packageJson.scripts || {}, staleCommand)) failures.push(`obsolete package command must stay removed: ${staleCommand}`)
}

// Canonical Worker chain and D1-first routes.
requireText('worker/src/entry-master-watch.js', "from './entry-local-auth.js'", 'master-watch to local-auth canonical chain')
requireText('worker/src/entry.js', "import { handleD1Labels } from './realtime-labels-d1.js'", 'D1 Label router import')
requireBefore('worker/src/entry.js', 'const d1LabelsResponse = await handleD1Labels', 'let response = await app.fetch', 'D1 Label router must execute before legacy app fallback')
requireText('worker/src/entry.js', "runtimeUrl.searchParams.set('legacy_seed', '0')", 'runtime Sheet hydration must remain disabled')
requireText('worker/src/entry.js', "import { handleD1CloseUpUpsert } from './realtime-closeup-upsert-d1.js'", 'D1 Close Up mutation router')
requireText('worker/src/entry.js', "import { handleJsonAtomicStockCountBatch } from './realtime-stock-batch-json.js'", 'atomic D1 Stock Count router')

// Canonical deploy must never migrate, backfill, create production resources, or call bootstrap endpoints.
const deployScript = 'scripts/deploy-master-watch-now.sh'
requireText(deployScript, 'npm run ops:audit:contract', 'architecture audit before deployment')
requireText(deployScript, 'npm run build', 'build before deployment')
requireText(deployScript, 'npm run cf:render', 'canonical production config render')
requireText(deployScript, 'npx wrangler deploy --config worker/wrangler.production.jsonc', 'canonical Wrangler deployment')
requireText(deployScript, 'D1_MIGRATION_RUN=false', 'explicit no-migration result marker')
requireText(deployScript, 'D1_BACKFILL_RUN=false', 'explicit no-backfill result marker')
requireText(deployScript, 'D1_DIRECT_WRITE_RUN=false', 'explicit no-direct-D1-write result marker')
forbidText(deployScript, 'd1 migrations apply', 'automatic D1 migration')
forbidText(deployScript, 'd1 create', 'automatic D1 creation')
forbidText(deployScript, 'queues create', 'automatic Queue creation')
forbidText(deployScript, '/migrate-once', 'directory migration endpoint call')
forbidText(deployScript, 'run-approved-backfill.sh', 'historical backfill during deploy')

// GitHub push validates; only explicit manual dispatch may deploy.
requireText('.github/workflows/deploy-cloudflare.yml', "if: github.event_name == 'workflow_dispatch'", 'manual production deployment gate')
forbidText('.github/workflows/deploy-cloudflare.yml', 'd1 migrations apply', 'D1 migration in Cloudflare workflow')
requireText('.github/workflows/deploy-cloudflare.yml', 'PRODUCTION_DEPLOYMENT_RUN=false', 'push validation must state no deployment')

// D1 write semantics that must remain durable and idempotent.
requireText('worker/src/label-d1-store.js', 'INSERT INTO ops_records', 'canonical Label record mutation')
requireText('worker/src/label-d1-store.js', 'INSERT INTO ops_mutations', 'Label idempotent mutation journal')
requireText('worker/src/label-d1-store.js', 'INSERT INTO sheet_sync_outbox', 'Label durable mirror outbox')
requireText('worker/src/label-d1-store.js', 'await db.batch(statements)', 'atomic Label D1 batch')
requireText('scripts/ops/d1-readonly-audit.sh', 'assert_select_only', 'SELECT-only D1 audit guard')
requireText('scripts/ops/d1-readonly-audit.sh', 'assert_zero_writes', 'zero-write D1 audit guard')
requireText('scripts/ops/build-safe-backfill.mjs', 'ON CONFLICT(entity, entity_id) DO NOTHING', 'insert-only historical backfill conflict guard')
requireText('scripts/ops/run-approved-backfill.sh', 'APPROVE_D1_BACKFILL', 'explicit historical backfill approval')
requireText('scripts/ops/run-approved-backfill.sh', 'ROLLBACK-NOT-AUTOMATIC', 'no automatic broad backfill rollback')

// Release contract remains coupled across manifest/PWA/APK.
const apkVersion = String(release.apk_version || '').trim()
const pwaVersion = String(release.pwa_version || '').trim()
if (!apkVersion || apkVersion !== String(release.minimum_apk_version || '').trim()) failures.push('APK forced-release version contract is invalid')
if (release.force_update !== true) failures.push('APK canonical release must force update')
if (!pwaVersion || pwaVersion !== String(release.minimum_pwa_version || '').trim()) failures.push('PWA forced-release version contract is invalid')
if (release.pwa_force_update !== true) failures.push('PWA canonical release must force update')
requireText('web/src/components/AppUpdateBanner.jsx', `const CURRENT_RELEASE = '${apkVersion}'`, 'APK release version matching manifest')
requireText('web/src/main.jsx', `const SHELL_VERSION = '${pwaVersion}'`, 'PWA shell version matching manifest')

// Sensitive UI access must remain gated; server authorization remains separately tested.
requireText('web/src/components/ProtectedRoute.jsx', "const SENSITIVE_MANAGER_PATHS = new Set(['/ops-control'])", 'sensitive Ops Control route guard')
requireText('web/src/App.jsx', '<Route path="/ops-control" element={<OwnerOnly><OpsControl /></OwnerOnly>} />', 'Owner-only Ops Control route')

// Historical deployment/migration artifacts are intentionally retired and must not return.
for (const obsoletePath of [
  'scripts/deploy-realtime-ops-now.sh',
  'scripts/deploy-task-realtime-fix-now.sh',
  'scripts/deploy-stock-media-v13-now.sh',
  'scripts/deploy-stock-history-v14-now.sh',
  'scripts/deploy-d1-source-of-truth-v15-now.sh',
  'scripts/deploy-d1-directory-v16-now.sh',
  'scripts/restore-d1-directory-v17-now.sh',
  'scripts/deploy-roster-sop-v11-now.sh',
  'scripts/deploy-roster-sop-v12-now.sh',
  'scripts/deploy-stale-aware-ops-now.sh',
  'scripts/restore-directory-from-master-sheet.sql',
  'scripts/repair-roster-2026-08-02.sql',
  'scripts/register-sales-template.mjs',
  'scripts/test-closeup-gas.mjs',
  'scripts/configure-production-integrations.sh',
  'scripts/render-wrangler-local-auth-transition.mjs',
  'scripts/ops/apply-local-auth-migration.sh',
  'scripts/ops/activate-local-auth-production.sh',
  'scripts/ops/test-local-auth-production-activation.mjs',
]) requireAbsent(obsoletePath)

requireText('.gitignore', '.deployments/', 'transient deployment artifacts ignored')
requireText('.gitignore', '.ops-deploy-status/', 'transient deployment status ignored')
requireText('.gitignore', '.ops-deploy-trigger/', 'transient deployment triggers ignored')
requireText('README.md', 'D1 is the canonical runtime database', 'canonical D1 architecture statement')
requireText('README.md', 'Direct deployment from `worker/` is intentionally disabled', 'single production deployment path documentation')
requireText('AGENTS.md', 'Do not run a D1 migration as part of a normal deployment', 'normal deployment migration guardrail')

if (failures.length) {
  console.error('OPS architecture contract audit failed:')
  for (const failure of failures) console.error(`- ${failure}`)
  process.exit(1)
}

console.log('OPS_ARCHITECTURE_CONTRACT_OK=true')
console.log('CANONICAL_PRODUCTION_ENTRY=src/entry-master-watch.js')
console.log('SINGLE_PRODUCTION_DEPLOY_PATH=true')
console.log('BARE_WORKER_DEPLOY_DISABLED=true')
console.log('OBSOLETE_DEPLOYERS_REMOVED=true')
console.log('NORMAL_DEPLOYMENT_RUNS_MIGRATION=false')
console.log('NORMAL_DEPLOYMENT_RUNS_BACKFILL=false')
console.log('NORMAL_DEPLOYMENT_DIRECT_D1_WRITE=false')
console.log('D1_LABEL_ROUTING_BEFORE_LEGACY=true')
console.log('SAFE_BACKFILL_GUARDS_PRESENT=true')
console.log(`APK_VERSION=${apkVersion}`)
console.log(`PWA_VERSION=${pwaVersion}`)
