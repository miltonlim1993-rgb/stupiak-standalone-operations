import { randomBytes } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import process from 'node:process'

const root = process.cwd()
const branchRequired = 'staging/ops-system-cleanup'
const workerName = 'stupiaks-ops-staging'
const configTemplate = path.join(root, 'worker', 'wrangler.staging.example.jsonc')
const configPath = path.join(root, 'worker', 'wrangler.staging.jsonc')
const stagingDir = path.join(root, '.staging')
const ownerLogin = 'staging-owner@stupiak.invalid'

const FORBIDDEN_PRODUCTION_MARKERS = [
  '"name": "stupiaks-ops"',
  '080c13d7-e2f5-4c01-a1ca-aa00094d6fc0',
  'f62696e1a2f14b8a9e0b84a540c7e997',
  'stupiaks-ops-media',
  'stupiaks-ops-sheet-sync',
  '1sy-4AIbZssCmP9HQaq-K4OicXjdvOs2EXVNmvh4bSzM',
]

function fail(message) {
  console.error(`STAGING_PROVISION_ERROR=${message}`)
  process.exit(1)
}

function run(command, args, { quiet = false, input = undefined } = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    input,
    env: {
      ...process.env,
      WRANGLER_SEND_METRICS: 'false',
    },
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

function assertStagingConfigSafe(filePath) {
  const content = readFileSync(filePath, 'utf8')
  if (!content.includes(`"name": "${workerName}"`)) fail('staging Worker name is missing')
  if (!content.includes('"database_name": "stupiaks-ops-staging"')) fail('staging D1 name is missing')
  for (const marker of FORBIDDEN_PRODUCTION_MARKERS) {
    if (content.includes(marker)) fail(`production binding marker detected in staging config: ${marker}`)
  }
  if (/SHEET_SYNC_QUEUE|queues\s*"?\s*:/.test(content)) fail('staging must not bind the Sheet sync Queue')
  if (/"triggers"\s*:/.test(content)) fail('staging must not define scheduled triggers')
}

function randomSecret(bytes = 48) {
  return randomBytes(bytes).toString('base64url')
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, options)
  const text = await response.text()
  let body = null
  try { body = JSON.parse(text) } catch { body = { raw: text } }
  if (!response.ok) {
    console.error(JSON.stringify(body, null, 2))
    fail(`HTTP ${response.status} from ${url}`)
  }
  return { response, body }
}

const branch = run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { quiet: true }).trim()
if (branch !== branchRequired) fail(`wrong branch: ${branch}; expected ${branchRequired}`)

run('npx', ['wrangler', 'whoami'])
mkdirSync(stagingDir, { recursive: true })
copyFileSync(configTemplate, configPath)
assertStagingConfigSafe(configPath)

console.log('=== BUILD SYNTHETIC STAGING FIXTURES ===')
run('node', ['scripts/staging/build-fixtures.mjs'])

console.log('=== BUILD WEB ===')
run('npm', ['run', 'build', '-w', 'web'])

console.log('=== STAGING WORKER DRY RUN ===')
run('npx', ['wrangler', 'deploy', '--dry-run', '--config', 'worker/wrangler.staging.jsonc'])
assertStagingConfigSafe(configPath)

console.log('=== FIRST STAGING DEPLOY / AUTO-PROVISION ISOLATED RESOURCES ===')
const firstDeploy = run('npx', ['wrangler', 'deploy', '--config', 'worker/wrangler.staging.jsonc'])
assertStagingConfigSafe(configPath)

console.log('=== APPLY MIGRATIONS TO STAGING D1 ONLY ===')
run('npx', ['wrangler', 'd1', 'migrations', 'apply', 'OPS_DB', '--remote', '--config', 'worker/wrangler.staging.jsonc'])
assertStagingConfigSafe(configPath)

console.log('=== SEED SYNTHETIC D1 DIRECTORY ===')
run('npx', ['wrangler', 'd1', 'execute', 'OPS_DB', '--remote', '--file=.staging/d1-seed.sql', '--config', 'worker/wrangler.staging.jsonc'])

console.log('=== SEED SYNTHETIC PUBLISHED APP PACK ===')
run('npx', ['wrangler', 'kv', 'bulk', 'put', '.staging/kv-seed.json', '--binding', 'APP_DATA_PACKS', '--remote', '--config', 'worker/wrangler.staging.jsonc'])

const sessionSecret = randomSecret()
const localPepper = randomSecret()
const bootstrapSecret = randomSecret()
const ownerPassword = `Stg!${randomSecret(18)}`
const secretsPath = path.join(stagingDir, 'secrets.json')
writeFileSync(secretsPath, JSON.stringify({
  SESSION_SECRET: sessionSecret,
  LOCAL_AUTH_PEPPER: localPepper,
  LOCAL_AUTH_BOOTSTRAP_SECRET: bootstrapSecret,
}, null, 2), { mode: 0o600 })

try {
  console.log('=== INSTALL STAGING-ONLY SECRETS ===')
  run('npx', ['wrangler', 'secret', 'bulk', '.staging/secrets.json', '--config', 'worker/wrangler.staging.jsonc'])
} finally {
  if (existsSync(secretsPath)) rmSync(secretsPath, { force: true })
}

console.log('=== FINAL STAGING DEPLOY ===')
const finalDeploy = run('npx', ['wrangler', 'deploy', '--config', 'worker/wrangler.staging.jsonc'])
assertStagingConfigSafe(configPath)

const deployOutput = `${finalDeploy}\n${firstDeploy}`
const urlMatch = deployOutput.match(/https:\/\/[a-z0-9.-]+\.workers\.dev/gi)
const stagingUrl = urlMatch?.find((value) => value.toLowerCase().includes('stupiaks-ops-staging')) || urlMatch?.at(-1) || ''
if (!stagingUrl) fail('Wrangler deployed but the staging workers.dev URL could not be detected')

console.log('=== VERIFY STAGING IDENTITY ===')
const info = await requestJson(`${stagingUrl}/api/staging/info`, {
  headers: { Accept: 'application/json' },
})
if (info.body?.environment !== 'staging' || info.body?.production !== false) {
  fail('staging identity endpoint did not confirm isolation')
}

console.log('=== BOOTSTRAP SYNTHETIC STAGING OWNER ===')
await requestJson(`${stagingUrl}/api/internal/local-auth/bootstrap-owner`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-ChefOps-Local-Auth-Bootstrap-Secret': bootstrapSecret,
  },
  body: JSON.stringify({ login_id: ownerLogin, password: ownerPassword }),
})

console.log('=== VERIFY STAGING LOGIN ===')
const login = await requestJson(`${stagingUrl}/api/auth/local/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ login_id: ownerLogin, password: ownerPassword }),
})
if (String(login.body?.user?.role || '').toLowerCase() !== 'owner') fail('staging Owner login verification failed')

console.log('')
console.log('========================================')
console.log('STAGING_READY=true')
console.log(`STAGING_URL=${stagingUrl}`)
console.log(`STAGING_LOGIN=${ownerLogin}`)
console.log(`STAGING_PASSWORD=${ownerPassword}`)
console.log('STAGING_TEST_DATA_ONLY=true')
console.log('STAGING_EXTERNAL_SIDE_EFFECTS=false')
console.log('PRODUCTION_WORKER_TOUCHED=false')
console.log('PRODUCTION_D1_TOUCHED=false')
console.log('PRODUCTION_KV_TOUCHED=false')
console.log('PRODUCTION_R2_TOUCHED=false')
console.log('PRODUCTION_SHEETS_TOUCHED=false')
console.log('========================================')
