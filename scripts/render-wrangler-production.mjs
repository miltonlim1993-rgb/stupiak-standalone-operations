import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const root = process.cwd()
const templatePath = path.join(root, 'worker', 'wrangler.production.example.jsonc')
const outputPath = path.join(root, 'worker', 'wrangler.production.jsonc')
const kvId = String(process.env.CLOUDFLARE_APP_DATA_PACKS_ID || '').trim()
const d1Id = String(process.env.CLOUDFLARE_OPS_DB_ID || '').trim()
const bucketName = String(process.env.CLOUDFLARE_MEDIA_BUCKET_NAME || '').trim()
const queueName = String(process.env.CLOUDFLARE_SHEET_SYNC_QUEUE_NAME || 'stupiaks-ops-sheet-sync').trim()
const deadLetterQueueName = String(process.env.CLOUDFLARE_SHEET_SYNC_DLQ_NAME || 'stupiaks-ops-sheet-sync-dlq').trim()
const masterSpreadsheetId = String(process.env.GOOGLE_MASTER_SPREADSHEET_ID || '').trim()

const missing = []
if (!kvId) missing.push('CLOUDFLARE_APP_DATA_PACKS_ID')
if (!d1Id) missing.push('CLOUDFLARE_OPS_DB_ID')
if (!queueName) missing.push('CLOUDFLARE_SHEET_SYNC_QUEUE_NAME')
if (!deadLetterQueueName) missing.push('CLOUDFLARE_SHEET_SYNC_DLQ_NAME')
if (!masterSpreadsheetId) missing.push('GOOGLE_MASTER_SPREADSHEET_ID')
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
    .replaceAll('__MEDIA_BUCKET_NAME__', bucketName || 'stupiaks-ops-media')
    .replaceAll('__GOOGLE_MASTER_SPREADSHEET_ID__', masterSpreadsheetId),
)

// Media still uses Google Drive during rollout. Only bind R2 after the account
// has enabled R2 and CLOUDFLARE_MEDIA_BUCKET_NAME has been configured.
if (!bucketName) delete config.r2_buckets

writeFileSync(outputPath, `${JSON.stringify(config, null, 2)}\n`)
console.log(`Generated ${outputPath}`)
console.log(`Realtime D1: ${config.d1_databases[0].database_name} (${d1Id})`)
console.log(`Master spreadsheet binding: ${masterSpreadsheetId}`)
console.log(`Sheet mirror Queue: ${queueName}`)
console.log(`Sheet mirror DLQ: ${deadLetterQueueName}`)
console.log(bucketName ? `R2 media binding: ${bucketName}` : 'R2 media binding: disabled')
