import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const root = process.cwd()
const templatePath = path.join(root, 'worker', 'wrangler.production.example.jsonc')
const outputPath = path.join(root, 'worker', 'wrangler.production.jsonc')
const kvId = String(process.env.CLOUDFLARE_APP_DATA_PACKS_ID || '').trim()
const bucketName = String(process.env.CLOUDFLARE_MEDIA_BUCKET_NAME || 'stupiaks-ops-media').trim()

if (!kvId) {
  console.error('Missing CLOUDFLARE_APP_DATA_PACKS_ID')
  process.exit(1)
}

const template = readFileSync(templatePath, 'utf8')
const output = template
  .replaceAll('__APP_DATA_PACKS_ID__', kvId)
  .replaceAll('__MEDIA_BUCKET_NAME__', bucketName)

writeFileSync(outputPath, output)
console.log(`Generated ${outputPath}`)
