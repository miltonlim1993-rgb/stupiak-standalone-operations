import assert from 'node:assert/strict'
import fs from 'node:fs'

import {
  credentialKindForRole,
  hashLocalSecret,
  normalizeLoginId,
  validatePassword,
  validatePin,
  verifyLocalSecret,
} from '../../worker/src/local-auth-crypto.js'

const env = { LOCAL_AUTH_PEPPER: 'test-pepper-'.repeat(8) }

assert.equal(normalizeLoginId('012-345 6789'), '+60123456789')
assert.equal(normalizeLoginId('+60 12 345 6789'), '+60123456789')
assert.equal(normalizeLoginId(' Staff.RR-01 '), 'staff.rr-01')
assert.equal(normalizeLoginId('ab'), '')
assert.equal(credentialKindForRole('staff'), 'pin')
assert.equal(credentialKindForRole('leader'), 'pin')
assert.equal(credentialKindForRole('manager'), 'password')
assert.equal(credentialKindForRole('owner'), 'password')
assert.equal(validatePin('482915', '+60123456789'), '482915')
assert.throws(() => validatePin('123456', '+60123456789'), /less predictable|Sequential/)
assert.throws(() => validatePin('456789', '+60123456789'), /phone number|Sequential/)
assert.equal(validatePassword('Perfect!Owner2026', 'milton-owner'), 'Perfect!Owner2026')
assert.throws(() => validatePassword('password123', 'milton-owner'), /12 to 128|letters, numbers and a symbol/)

const encoded = await hashLocalSecret({
  secret: '482915',
  loginId: '+60123456789',
  purpose: 'credential:pin',
  env,
})
assert.ok(encoded.hash)
assert.ok(encoded.salt)
assert.ok(encoded.iterations >= 120_000)
assert.equal(await verifyLocalSecret({
  secret: '482915',
  loginId: '+60123456789',
  purpose: 'credential:pin',
  expectedHash: encoded.hash,
  salt: encoded.salt,
  iterations: encoded.iterations,
  env,
}), true)
assert.equal(await verifyLocalSecret({
  secret: '482916',
  loginId: '+60123456789',
  purpose: 'credential:pin',
  expectedHash: encoded.hash,
  salt: encoded.salt,
  iterations: encoded.iterations,
  env,
}), false)

const migration = fs.readFileSync('worker/migrations/0002_local_auth.sql', 'utf8')
const authSource = fs.readFileSync('worker/src/auth.js', 'utf8')
const localAuthSource = fs.readFileSync('worker/src/local-auth.js', 'utf8')
const storeSource = fs.readFileSync('worker/src/local-auth-store.js', 'utf8')
const adminSource = fs.readFileSync('worker/src/local-auth-admin.js', 'utf8')
const wrapperSource = fs.readFileSync('worker/src/entry-local-auth.js', 'utf8')
const productionEntry = fs.readFileSync('worker/src/entry-master-watch.js', 'utf8')
const directoryApiSource = fs.readFileSync('worker/src/d1-directory-api.js', 'utf8')
const config = JSON.parse(fs.readFileSync('worker/wrangler.production.example.jsonc', 'utf8'))
const appSource = fs.readFileSync('web/src/App.jsx', 'utf8')
const loginPage = fs.readFileSync('web/src/pages/Login.jsx', 'utf8')
const authContext = fs.readFileSync('web/src/lib/AuthContext.jsx', 'utf8')
const opsControl = fs.readFileSync('web/src/pages/OpsControl.jsx', 'utf8')
const localClient = fs.readFileSync('web/src/api/localAuthClient.js', 'utf8')
const migrationRunner = fs.readFileSync('scripts/ops/apply-local-auth-migration.sh', 'utf8')
const normalDeploy = fs.readFileSync('scripts/deploy-master-watch-now.sh', 'utf8')
const realtimeDeploy = fs.readFileSync('scripts/deploy-realtime-ops-now.sh', 'utf8')
const userSchema = fs.readFileSync('worker/src/schema.js', 'utf8')

for (const table of ['local_credentials', 'local_auth_activations', 'local_auth_rate_limits', 'local_auth_audit']) {
  assert.match(migration, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`))
}
assert.match(migration, /secret_hash TEXT NOT NULL/)
assert.match(migration, /salt TEXT NOT NULL/)
assert.match(migration, /session_version INTEGER NOT NULL/)
assert.doesNotMatch(migration, /plaintext|raw_secret|raw_pin|raw_password/i)

assert.match(authSource, /auth_method/)
assert.match(authSource, /assertLocalSessionVersion/)
assert.match(authSource, /uid:/)
assert.match(localAuthSource, /\/api\/auth\/local\/register/)
assert.match(localAuthSource, /\/api\/auth\/local\/activate/)
assert.match(localAuthSource, /\/api\/auth\/local\/login/)
assert.match(localAuthSource, /local-access/)
assert.match(localAuthSource, /issueActivation/)
assert.match(localAuthSource, /owner_approval_required: true/)
assert.match(storeSource, /validateCredentialSecret/)
assert.match(storeSource, /PBKDF2|hashLocalSecret/)
assert.match(storeSource, /session_version = session_version \+ 1/)
assert.match(adminSource, /revokeLocalCredential/)
assert.match(adminSource, /localCredentialMustReset/)
assert.match(wrapperSource, /handleLocalAuth/)
assert.match(wrapperSource, /X-ChefOps-Local-Auth-Bootstrap-Secret/)
assert.match(wrapperSource, /Only the Owner may issue or reset local login access/)
assert.match(wrapperSource, /owner_required/)
assert.match(directoryApiSource, /assertOwnerApproval/)
assert.match(directoryApiSource, /Only the Owner may approve or restore an OPS account/)
assert.match(productionEntry, /from '\.\/entry-local-auth\.js'/)
assert.match(productionEntry, /local_auth:/)

assert.equal(config.vars.LOCAL_AUTH_MODE, 'enabled')
assert.equal(config.vars.LOCAL_AUTH_REGISTRATION, 'enabled')
assert.equal(config.vars.GOOGLE_LOGIN_MODE, 'fallback')
assert.equal(config.vars.STATVARA_OPS_BRIDGE_PORT, '__STATVARA_OPS_BRIDGE_PORT__')

assert.match(appSource, /function OwnerOnly/)
assert.match(appSource, /role \|\| ''\)\.toLowerCase\(\) === 'owner'/)
assert.match(appSource, /<OwnerOnly><OpsControl \/><\/OwnerOnly>/)
assert.match(loginPage, /No personal Google account required/)
assert.match(loginPage, /Owner-approved local account/)
assert.match(loginPage, /Activate local login/)
assert.match(loginPage, /temporary Google migration fallback/i)
assert.match(authContext, /parsed\?\.id \|\| parsed\?\.google_sub/)
assert.match(authContext, /loginLocal/)
assert.match(localClient, /\/api\/auth\/local\/login/)
assert.match(localClient, /issueActivation/)
assert.match(opsControl, /Approve \+ code/)
assert.match(opsControl, /Issue \/ reset login/)
assert.match(opsControl, /activation_code/)
assert.match(opsControl, /My local login/)

assert.match(migrationRunner, /APPROVE_LOCAL_AUTH_MIGRATION/)
assert.match(migrationRunner, /0002_local_auth\.sql/)
assert.match(migrationRunner, /D1_BACKFILL_RUN=false/)
assert.doesNotMatch(normalDeploy, /d1 migrations apply/)
assert.doesNotMatch(realtimeDeploy, /d1 migrations apply/)
assert.doesNotMatch(userSchema, /secret_hash|activation_code|password_hash|pin_hash/)
assert.doesNotMatch(localAuthSource, /console\.log\([^\n]*(secret|password|pin|activation)/i)
assert.doesNotMatch(storeSource, /console\.log\([^\n]*(secret|password|pin|activation)/i)

console.log('LOCAL_AUTH_TEST_OK=true')
console.log('OWNER_APPROVAL_REQUIRED=true')
console.log('OWNER_ONLY_ACTIVATION=true')
console.log('OWNER_ONLY_APPROVAL=true')
console.log('STAFF_CREDENTIAL=6_digit_pin')
console.log('MANAGEMENT_CREDENTIAL=strong_password')
console.log('GOOGLE_LOGIN_MODE=fallback')
console.log('LOCAL_SESSION_REVOCATION=true')
console.log('NORMAL_DEPLOYMENT_RUNS_MIGRATION=false')
console.log('D1_BACKFILL_RUN=false')
console.log('STATVARA_OPS_BRIDGE_PORT=8791')
