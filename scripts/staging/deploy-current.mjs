import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import process from 'node:process'

const root = process.cwd()
const branchRequired = 'staging/ops-system-cleanup'
const configPath = 'worker/wrangler.staging.example.jsonc'
const stagingUrl = 'https://stupiaks-ops-staging.sporkburger19.workers.dev'

const FORBIDDEN_PRODUCTION_MARKERS = [
  '"name": "stupiaks-ops"',
  '080c13d7-e2f5-4c01-a1ca-aa00094d6fc0',
  'f62696e1a2f14b8a9e0b84a540c7e997',
  'stupiaks-ops-media',
  'stupiaks-ops-sheet-sync',
  '1sy-4AIbZssCmP9HQaq-K4OicXjdvOs2EXVNmvh4bSzM',
]

function fail(message) {
  console.error(`STAGING_DEPLOY_ERROR=${message}`)
  process.exit(1)
}

function run(command, args, { quiet = false } = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
    maxBuffer: 32 * 1024 * 1024,
  })
  const output = `${result.stdout || ''}${result.stderr || ''}`
  if (!quiet && output) process.stdout.write(output)
  if (result.status !== 0) {
    if (quiet && output) process.stderr.write(output)
    fail(`${command} ${args.join(' ')} exited ${result.status}`)
  }
  return output
}

function assertSafeConfig() {
  const content = readFileSync(configPath, 'utf8')
  if (!content.includes('"name": "stupiaks-ops-staging"')) fail('staging Worker name missing')
  if (!content.includes('"database_name": "stupiaks-ops-staging"')) fail('staging D1 name missing')
  for (const marker of FORBIDDEN_PRODUCTION_MARKERS) {
    if (content.includes(marker)) fail(`production marker detected: ${marker}`)
  }
  if (/SHEET_SYNC_QUEUE|"queues"\s*:/.test(content)) fail('staging deploy must not bind production Sheet sync Queue')
  if (/"triggers"\s*:/.test(content)) fail('staging deploy must not define scheduled triggers')
}

async function verifyStaging() {
  const response = await fetch(`${stagingUrl}/api/staging/info`, { headers: { Accept: 'application/json' } })
  if (!response.ok) fail(`staging identity HTTP ${response.status}`)
  const body = await response.json()
  if (body?.environment !== 'staging' || body?.production !== false || body?.external_side_effects !== false) {
    fail('target did not prove staging isolation')
  }
}

const branch = run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { quiet: true }).trim()
if (branch !== branchRequired) fail(`wrong branch: ${branch}; expected ${branchRequired}`)

assertSafeConfig()
console.log('=== VERIFY WRANGLER LOGIN ===')
run('npx', ['wrangler', 'whoami'])

console.log('=== VERIFY EXISTING STAGING TARGET ===')
await verifyStaging()

console.log('=== BUILD STAGING WEB ASSETS ===')
run('npm', ['run', 'build', '-w', 'web'])

console.log('=== STAGING WORKER DRY RUN ===')
run('npx', ['wrangler', 'deploy', '--dry-run', '--config', configPath])
assertSafeConfig()

console.log('=== DEPLOY CODE + ASSETS TO STAGING ONLY ===')
run('npx', ['wrangler', 'deploy', '--config', configPath])
assertSafeConfig()

console.log('=== VERIFY STAGING AFTER DEPLOY ===')
for (let attempt = 1; attempt <= 20; attempt += 1) {
  try {
    await verifyStaging()
    console.log(`STAGING_DEPLOY_VERIFIED_AFTER_ATTEMPT=${attempt}`)
    console.log('STAGING_DEPLOY_READY=true')
    console.log(`STAGING_URL=${stagingUrl}`)
    console.log('MIGRATION_RUN=false')
    console.log('SEED_RUN=false')
    console.log('SECRET_ROTATION_RUN=false')
    console.log('PRODUCTION_TOUCHED=false')
    process.exit(0)
  } catch (error) {
    if (attempt === 20) throw error
    await new Promise((resolve) => setTimeout(resolve, 2000))
  }
}
