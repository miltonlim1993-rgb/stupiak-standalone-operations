import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const root = process.cwd()
const templatePath = path.join(root, 'worker', 'wrangler.production.example.jsonc')
const outputPath = path.join(root, 'worker', 'wrangler.production.jsonc')
const kvId = String(process.env.CLOUDFLARE_APP_DATA_PACKS_ID || '').trim()
const bucketName = String(process.env.CLOUDFLARE_MEDIA_BUCKET_NAME || '').trim()

if (!kvId) {
  console.error('Missing CLOUDFLARE_APP_DATA_PACKS_ID')
  process.exit(1)
}

const template = readFileSync(templatePath, 'utf8')
const config = JSON.parse(
  template
    .replaceAll('__APP_DATA_PACKS_ID__', kvId)
    .replaceAll('__MEDIA_BUCKET_NAME__', bucketName || 'stupiaks-ops-media'),
)

// Media still uses Google Drive during rollout. Only bind R2 after the account
// has enabled R2 and CLOUDFLARE_MEDIA_BUCKET_NAME has been configured.
if (!bucketName) delete config.r2_buckets

writeFileSync(outputPath, `${JSON.stringify(config, null, 2)}\n`)
console.log(`Generated ${outputPath}${bucketName ? ' with R2 binding' : ' without R2 binding'}`)
