import assert from 'node:assert/strict'
import fs from 'node:fs'

import { driveBackupMode, mediaPrimaryStorage } from '../../worker/src/drive.js'
import { googleAuthMode } from '../../worker/src/google.js'

const serviceAccountEnv = {
  GOOGLE_SERVICE_ACCOUNT_EMAIL: 'ops-runtime@example.iam.gserviceaccount.com',
  GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: 'private-key-placeholder',
}
const oauthEnv = {
  GOOGLE_DATA_CLIENT_ID: 'client-id',
  GOOGLE_DATA_CLIENT_SECRET: 'client-secret',
  GOOGLE_DATA_REFRESH_TOKEN: 'refresh-token',
}

assert.equal(googleAuthMode(serviceAccountEnv, 'data'), 'service_account')
assert.equal(googleAuthMode(oauthEnv, 'data'), 'oauth_refresh_token')
assert.equal(googleAuthMode({ ...serviceAccountEnv, ...oauthEnv }, 'data'), 'service_account')
assert.equal(googleAuthMode({ ...serviceAccountEnv, ...oauthEnv }, 'drive'), 'oauth_refresh_token')
assert.equal(googleAuthMode({ ...serviceAccountEnv, GOOGLE_DRIVE_AUTH_MODE: 'service_account' }, 'drive'), 'service_account')
assert.equal(googleAuthMode({ ...serviceAccountEnv, GOOGLE_DRIVE_AUTH_MODE: 'disabled' }, 'drive'), 'disabled')
assert.equal(driveBackupMode({}), 'disabled')
assert.equal(driveBackupMode({ GOOGLE_DRIVE_BACKUP_MODE: 'enabled' }), 'enabled')
assert.equal(mediaPrimaryStorage({ MEDIA_BUCKET: { put() {}, get() {} } }), 'cloudflare-r2')
assert.equal(mediaPrimaryStorage({}), 'google-drive')

const googleSource = fs.readFileSync('worker/src/google.js', 'utf8')
const driveSource = fs.readFileSync('worker/src/drive.js', 'utf8')
const entrySource = fs.readFileSync('worker/src/entry-master-watch.js', 'utf8')
const renderSource = fs.readFileSync('scripts/render-wrangler-production.mjs', 'utf8')
const deploySource = fs.readFileSync('scripts/deploy-master-watch-now.sh', 'utf8')
const bootstrapSource = fs.readFileSync('scripts/bootstrap-autonomous-runtime.sh', 'utf8')
const config = JSON.parse(fs.readFileSync('worker/wrangler.production.example.jsonc', 'utf8'))

assert.match(googleSource, /urn:ietf:params:oauth:grant-type:jwt-bearer/)
assert.match(googleSource, /RSASSA-PKCS1-v1_5/)
assert.match(googleSource, /GOOGLE_SERVICE_ACCOUNT_EMAIL/)
assert.match(googleSource, /GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY/)
assert.match(googleSource, /service_account/)

assert.match(driveSource, /MEDIA_BUCKET\.put/)
assert.match(driveSource, /MEDIA_BUCKET\.get/)
assert.match(driveSource, /cloudflare-r2/)
assert.match(driveSource, /GOOGLE_DRIVE_BACKUP_MODE/)
assert.match(driveSource, /scheduleDriveBackup/)
assert.match(driveSource, /retryPendingDriveBackups/)
assert.match(driveSource, /R2 remains canonical/)
assert.match(driveSource, /appProperties: \{ chefops_media_id: sourceMediaId \}/)

assert.equal(config.vars.GOOGLE_DATA_AUTH_MODE, 'service_account')
assert.equal(config.vars.GOOGLE_DRIVE_AUTH_MODE, 'service_account')
assert.equal(config.vars.GOOGLE_DRIVE_BACKUP_MODE, 'disabled')
assert.equal(config.vars.MEDIA_PRIMARY_STORAGE, 'cloudflare-r2')
assert.equal(config.vars.STATVARA_OPS_BRIDGE_PORT, '__STATVARA_OPS_BRIDGE_PORT__')
assert.equal(config.r2_buckets?.[0]?.binding, 'MEDIA_BUCKET')

assert.match(entrySource, /DEFAULT_STATVARA_BRIDGE_PORT = 8791/)
assert.match(entrySource, /blocks_store_execution: false/)
assert.match(entrySource, /media_primary_storage/)
assert.match(entrySource, /drive_legacy_read_auth/)
assert.match(entrySource, /disabled_non_blocking/)
assert.match(entrySource, /google_data_auth/)
assert.match(entrySource, /retryPendingDriveBackups/)

assert.match(renderSource, /stupiaks-ops-media/)
assert.match(renderSource, /STATVARA_OPS_BRIDGE_PORT/)
assert.doesNotMatch(renderSource, /delete config\.r2_buckets/)
assert.match(deploySource, /AUTONOMOUS_RUNTIME_VERIFIED=true/)
assert.match(deploySource, /MASTER_SPREADSHEET_BINDING_VERIFIED=true/)
assert.match(deploySource, /R2_MEDIA_PRIMARY_VERIFIED=true/)
assert.match(deploySource, /LEGACY_DRIVE_READ_AUTH_VERIFIED=service_account/)
assert.match(deploySource, /DRIVE_BACKUP_MODE_VERIFIED=disabled/)
assert.match(deploySource, /STATVARA_OPS_BRIDGE_PORT=8791/)
assert.match(bootstrapSource, /wrangler r2 bucket create/)
assert.match(bootstrapSource, /GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY/)

for (const source of [deploySource, bootstrapSource]) {
  assert.doesNotMatch(source, /wrangler d1 migrations apply/)
  assert.doesNotMatch(source, /wrangler d1 execute/)
  assert.doesNotMatch(source, /ops:backfill:run/)
}

console.log('AUTONOMOUS_RUNTIME_TEST_OK=true')
console.log('GOOGLE_DATA_AUTH=service_account')
console.log('LEGACY_DRIVE_READ_AUTH=service_account')
console.log('DRIVE_BACKUP_MODE=disabled')
console.log('MEDIA_PRIMARY_STORAGE=cloudflare-r2')
console.log('DRIVE_BACKUP_BLOCKS_TASKS=false')
console.log('STATVARA_OPS_BRIDGE_PORT=8791')
console.log('D1_MIGRATION_RUN=false')
