import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const root = process.cwd()
const inputPath = path.join(root, 'worker', 'wrangler.production.jsonc')
const outputPath = path.join(root, 'worker', 'wrangler.local-auth-transition.jsonc')
const config = JSON.parse(readFileSync(inputPath, 'utf8'))

config.vars = {
  ...(config.vars || {}),
  GOOGLE_DATA_AUTH_MODE: String(process.env.OPS_TRANSITION_GOOGLE_DATA_AUTH_MODE || 'oauth_refresh_token'),
  GOOGLE_DRIVE_AUTH_MODE: String(process.env.OPS_TRANSITION_GOOGLE_DRIVE_AUTH_MODE || 'oauth_refresh_token'),
  GOOGLE_DRIVE_BACKUP_MODE: 'disabled',
  MEDIA_PRIMARY_STORAGE: 'google-drive-transition',
  LOCAL_AUTH_MODE: 'enabled',
  LOCAL_AUTH_REGISTRATION: 'enabled',
  GOOGLE_LOGIN_MODE: 'fallback',
}

delete config.r2_buckets

writeFileSync(outputPath, `${JSON.stringify(config, null, 2)}\n`)
console.log(`Generated ${outputPath}`)
console.log('LOCAL_AUTH_TRANSITION_CONFIG=true')
console.log('R2_BINDING_INCLUDED=false')
console.log('GOOGLE_SERVICE_ACCOUNT_REQUIRED=false')
console.log(`GOOGLE_DATA_AUTH_MODE=${config.vars.GOOGLE_DATA_AUTH_MODE}`)
console.log(`GOOGLE_DRIVE_AUTH_MODE=${config.vars.GOOGLE_DRIVE_AUTH_MODE}`)
console.log('GOOGLE_LOGIN_MODE=fallback')
console.log('LOCAL_AUTH_MODE=enabled')
