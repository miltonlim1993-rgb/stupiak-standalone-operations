import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const workerDirectory = path.join(root, 'worker')
const outletId = String(process.env.LOCAL_SANDBOX_OUTLET || 'RR-KCH').trim() || 'RR-KCH'
const namespaceId = String(
  process.env.CLOUDFLARE_APP_DATA_PACKS_ID
  || 'f62696e1a2f14b8a9e0b84a540c7e997',
).trim()
const schemaVersion = 2
const targetDirectory = path.join(root, 'web', 'public', 'local-sandbox')
const targetFile = path.join(targetDirectory, `${outletId.toLowerCase()}-pack.json`)

function parseJsonOutput(value, label) {
  const text = String(value || '').trim()
  try {
    return JSON.parse(text)
  } catch {
    const first = text.indexOf('{')
    const last = text.lastIndexOf('}')
    if (first >= 0 && last > first) {
      try { return JSON.parse(text.slice(first, last + 1)) } catch {}
    }
    throw new Error(`${label} did not return valid JSON.`)
  }
}

function readRemoteKvJson(key) {
  const output = execFileSync(
    'npx',
    [
      'wrangler',
      'kv',
      'key',
      'get',
      key,
      `--namespace-id=${namespaceId}`,
      '--remote',
      '--text',
    ],
    {
      cwd: workerDirectory,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'inherit'],
      env: process.env,
      maxBuffer: 64 * 1024 * 1024,
    },
  )
  return parseJsonOutput(output, key)
}

async function main() {
  if (!namespaceId) throw new Error('CLOUDFLARE_APP_DATA_PACKS_ID is required.')

  const manifestKey = `chefops:pack:${schemaVersion}:manifest:${outletId}`
  console.log(`Reading published manifest for ${outletId} from remote KV...`)
  const manifest = readRemoteKvJson(manifestKey)
  if (!manifest?.version || !manifest?.modules) {
    throw new Error(`Published package for ${outletId} is missing or incomplete.`)
  }

  const modules = {}
  for (const [name, info] of Object.entries(manifest.modules)) {
    if (!info?.hash) continue
    const moduleKey = `chefops:pack:${schemaVersion}:module:${outletId}:${name}:${info.hash}`
    console.log(`Reading module ${name}...`)
    const modulePayload = readRemoteKvJson(moduleKey)
    modules[name] = modulePayload?.data ?? modulePayload
  }

  const snapshot = {
    snapshot_version: 1,
    mode: 'production-published-package-readonly',
    outlet_id: outletId,
    pulled_at: new Date().toISOString(),
    manifest: {
      version: manifest.version,
      data_version: manifest.data_version || manifest.version,
      generated_at: manifest.generated_at || '',
      total_bytes: Number(manifest.total_bytes || 0),
      storage: manifest.storage || 'cloudflare-kv',
      modules: manifest.modules,
    },
    modules,
    realtime: {},
  }

  await fs.mkdir(targetDirectory, { recursive: true })
  await fs.writeFile(targetFile, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8')

  console.log('')
  console.log('READ_ONLY_PRODUCTION_PACK_READY=true')
  console.log(`OUTLET=${outletId}`)
  console.log(`VERSION=${manifest.version}`)
  console.log(`GENERATED_AT=${manifest.generated_at || ''}`)
  console.log(`FILE=${targetFile}`)
  console.log('No Cloudflare data was written or modified.')
}

main().catch((error) => {
  console.error('Unable to pull the read-only production package.')
  console.error(error?.message || error)
  process.exitCode = 1
})
