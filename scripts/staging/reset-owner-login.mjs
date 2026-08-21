import { randomBytes } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import process from 'node:process'

const root = process.cwd()
const branchRequired = 'staging/ops-system-cleanup'
const configPath = 'worker/wrangler.staging.example.jsonc'
const stagingUrl = 'https://stupiaks-ops-staging.sporkburger19.workers.dev'
const ownerLogin = 'staging-owner@stupiak.invalid'
const stagingDir = path.join(root, '.staging')
const credentialsPath = path.join(stagingDir, 'credentials.txt')
const bootstrapRetryDelayMs = 3000
const bootstrapRetryAttempts = 30

function fail(message) {
  console.error(`STAGING_LOGIN_RESET_ERROR=${message}`)
  process.exit(1)
}

function run(command, args, { quiet = false, input = undefined } = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    input,
    env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
    maxBuffer: 16 * 1024 * 1024,
  })
  const output = `${result.stdout || ''}${result.stderr || ''}`
  if (!quiet && output) process.stdout.write(output)
  if (result.status !== 0) {
    if (quiet && output) process.stderr.write(output)
    fail(`${command} ${args.join(' ')} exited ${result.status}`)
  }
  return output
}

function randomSecret(bytes = 32) {
  return randomBytes(bytes).toString('base64url')
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function request(url, options = {}) {
  const response = await fetch(url, options)
  const text = await response.text()
  let body = null
  try { body = JSON.parse(text) } catch { body = { raw: text } }
  return { response, body }
}

async function requestJson(url, options = {}) {
  const { response, body } = await request(url, options)
  if (!response.ok) {
    console.error(JSON.stringify(body, null, 2))
    fail(`HTTP ${response.status} from ${url}`)
  }
  return body
}

async function resetOwnerWhenSecretIsLive(bootstrapSecret, ownerPassword) {
  const url = `${stagingUrl}/api/internal/local-auth/bootstrap-owner`
  for (let attempt = 1; attempt <= bootstrapRetryAttempts; attempt += 1) {
    const { response, body } = await request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-ChefOps-Local-Auth-Bootstrap-Secret': bootstrapSecret,
      },
      body: JSON.stringify({ login_id: ownerLogin, password: ownerPassword }),
    })

    if (response.ok) {
      console.log(`STAGING_BOOTSTRAP_SECRET_ACTIVE_AFTER_ATTEMPT=${attempt}`)
      return body
    }

    const code = String(body?.code || '')
    if (response.status !== 403 || code !== 'local_auth_bootstrap_forbidden') {
      console.error(JSON.stringify(body, null, 2))
      fail(`HTTP ${response.status} from ${url}`)
    }

    if (attempt === bootstrapRetryAttempts) {
      console.error(JSON.stringify(body, null, 2))
      fail('rotated staging bootstrap secret did not become active within 90 seconds')
    }

    console.log(`Waiting for rotated staging secret to become active... ${attempt}/${bootstrapRetryAttempts}`)
    await sleep(bootstrapRetryDelayMs)
  }
}

const branch = run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { quiet: true }).trim()
if (branch !== branchRequired) fail(`wrong branch: ${branch}; expected ${branchRequired}`)

console.log('=== VERIFY WRANGLER LOGIN ===')
run('npx', ['wrangler', 'whoami'])

console.log('=== VERIFY STAGING IDENTITY ===')
const info = await requestJson(`${stagingUrl}/api/staging/info`, { headers: { Accept: 'application/json' } })
if (info?.environment !== 'staging' || info?.production !== false || info?.external_side_effects !== false) {
  fail('target URL did not prove staging isolation')
}

const bootstrapSecret = randomSecret(48)
const ownerPassword = `Stg!${randomSecret(18)}`

console.log('=== ROTATE STAGING BOOTSTRAP SECRET ONLY ===')
run('npx', ['wrangler', 'secret', 'put', 'LOCAL_AUTH_BOOTSTRAP_SECRET', '--config', configPath], {
  input: `${bootstrapSecret}\n`,
})

console.log('=== WAIT FOR SECRET DEPLOYMENT + RESET SYNTHETIC OWNER PASSWORD ===')
await resetOwnerWhenSecretIsLive(bootstrapSecret, ownerPassword)

console.log('=== VERIFY NEW STAGING LOGIN ===')
const login = await requestJson(`${stagingUrl}/api/auth/local/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ login_id: ownerLogin, password: ownerPassword }),
})
if (String(login?.user?.role || '').toLowerCase() !== 'owner') fail('new staging Owner credential did not verify')

mkdirSync(stagingDir, { recursive: true })
writeFileSync(credentialsPath, [
  'STAGING_READY=true',
  `STAGING_URL=${stagingUrl}`,
  `STAGING_LOGIN=${ownerLogin}`,
  `STAGING_PASSWORD=${ownerPassword}`,
  'PRODUCTION_TOUCHED=false',
  '',
].join('\n'), { mode: 0o600 })

console.log('')
console.log('========================================')
console.log('STAGING_LOGIN_RESET=true')
console.log(`STAGING_URL=${stagingUrl}`)
console.log(`STAGING_LOGIN=${ownerLogin}`)
console.log(`STAGING_PASSWORD=${ownerPassword}`)
console.log(`STAGING_CREDENTIALS_FILE=${credentialsPath}`)
console.log('PRODUCTION_TOUCHED=false')
console.log('========================================')
