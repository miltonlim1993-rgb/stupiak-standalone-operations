import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const root = process.cwd()
const templatePath = path.join(root, 'worker', 'wrangler.production.example.jsonc')
const outputPath = path.join(root, 'worker', 'wrangler.production.jsonc')
const kvId = String(process.env.CLOUDFLARE_APP_DATA_PACKS_ID || '').trim()
const d1Id = String(process.env.CLOUDFLARE_OPS_DB_ID || '').trim()
const bucketName = String(process.env.CLOUDFLARE_MEDIA_BUCKET_NAME || 'stupiaks-ops-media').trim()
const queueName = String(process.env.CLOUDFLARE_SHEET_SYNC_QUEUE_NAME || 'stupiaks-ops-sheet-sync').trim()
const deadLetterQueueName = String(process.env.CLOUDFLARE_SHEET_SYNC_DLQ_NAME || 'stupiaks-ops-sheet-sync-dlq').trim()
const masterSpreadsheetId = String(process.env.GOOGLE_MASTER_SPREADSHEET_ID || '').trim()
const statvaraBridgePort = String(process.env.STATVARA_OPS_BRIDGE_PORT || '8791').trim()
const statvaraApiPath = String(process.env.STATVARA_OPS_API_PATH || '/api/ops/v1').trim()

const missing = []
if (!kvId) missing.push('CLOUDFLARE_APP_DATA_PACKS_ID')
if (!d1Id) missing.push('CLOUDFLARE_OPS_DB_ID')
if (!bucketName) missing.push('CLOUDFLARE_MEDIA_BUCKET_NAME')
if (!queueName) missing.push('CLOUDFLARE_SHEET_SYNC_QUEUE_NAME')
if (!deadLetterQueueName) missing.push('CLOUDFLARE_SHEET_SYNC_DLQ_NAME')
if (!masterSpreadsheetId) missing.push('GOOGLE_MASTER_SPREADSHEET_ID')
if (!/^\d+$/.test(statvaraBridgePort) || Number(statvaraBridgePort) < 1024 || Number(statvaraBridgePort) > 65535) {
  missing.push('STATVARA_OPS_BRIDGE_PORT(valid 1024-65535)')
}
if (!statvaraApiPath.startsWith('/')) missing.push('STATVARA_OPS_API_PATH')
if (missing.length) {
  console.error(`Missing required Cloudflare configuration: ${missing.join(', ')}`)
  process.exit(1)
}

const template = readFileSync(templatePath, 'utf8')
const config = JSON.parse(
  template
    .replaceAll('__APP_DATA_PACKS_ID__', kvId)
    .replaceAll('__OPS_DB_ID__', d1Id)
    .replaceAll('__SHEET_SYNC_QUEUE_NAME__', queueName)
    .replaceAll('__SHEET_SYNC_DLQ_NAME__', deadLetterQueueName)
    .replaceAll('__MEDIA_BUCKET_NAME__', bucketName)
    .replaceAll('__GOOGLE_MASTER_SPREADSHEET_ID__', masterSpreadsheetId)
    .replaceAll('__STATVARA_OPS_BRIDGE_PORT__', statvaraBridgePort)
    .replaceAll('__STATVARA_OPS_API_PATH__', statvaraApiPath),
)

writeFileSync(outputPath, `${JSON.stringify(config, null, 2)}\n`)
console.log(`Generated ${outputPath}`)
console.log(`Realtime D1: ${config.d1_databases[0].database_name} (${d1Id})`)
console.log(`Master spreadsheet binding: ${masterSpreadsheetId}`)
console.log('Google Master auth mode: service_account')
console.log('Legacy Google Drive read auth: service_account')
console.log('Google Drive backup mode: disabled (R2 remains canonical)')
console.log(`Sheet mirror Queue: ${queueName}`)
console.log(`Sheet mirror DLQ: ${deadLetterQueueName}`)
console.log(`R2 media binding: ${bucketName}`)
console.log(`Statvara OPS bridge reserved port: ${statvaraBridgePort}`)
console.log(`Statvara OPS API path: ${statvaraApiPath}`)
