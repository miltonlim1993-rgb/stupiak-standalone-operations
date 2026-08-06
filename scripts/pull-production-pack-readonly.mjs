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
const databaseName = String(process.env.CLOUDFLARE_OPS_DB_NAME || 'stupiaks-ops-realtime').trim()
const schemaVersion = 2
const targetDirectory = path.join(root, 'web', 'public', 'local-sandbox')
const targetFile = path.join(targetDirectory, `${outletId.toLowerCase()}-pack.json`)

function parseJsonOutput(value, label) {
  const text = String(value || '').trim()
  try {
    return JSON.parse(text)
  } catch {
    const objectIndex = text.indexOf('{')
    const arrayIndex = text.indexOf('[')
    const first = [objectIndex, arrayIndex].filter((index) => index >= 0).sort((a, b) => a - b)[0]
    const lastObject = text.lastIndexOf('}')
    const lastArray = text.lastIndexOf(']')
    const last = Math.max(lastObject, lastArray)
    if (Number.isInteger(first) && last > first) {
      try { return JSON.parse(text.slice(first, last + 1)) } catch {}
    }
    throw new Error(`${label} did not return valid JSON.`)
  }
}

function wrangler(args, { maxBuffer = 64 * 1024 * 1024 } = {}) {
  return execFileSync('npx', ['wrangler', ...args], {
    cwd: workerDirectory,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
    env: process.env,
    maxBuffer,
  })
}

function readRemoteKvJson(key) {
  const output = wrangler([
    'kv',
    'key',
    'get',
    key,
    `--namespace-id=${namespaceId}`,
    '--remote',
    '--text',
  ])
  return parseJsonOutput(output, key)
}

function assertReadOnlySql(sql) {
  const normalized = String(sql || '').trim().toUpperCase()
  if (!normalized.startsWith('SELECT ')) throw new Error('Refusing non-SELECT D1 query.')
  if (/\b(INSERT|UPDATE|DELETE|REPLACE|DROP|ALTER|CREATE|ATTACH|DETACH|VACUUM)\b/.test(normalized)) {
    throw new Error('Refusing D1 query containing a write or schema keyword.')
  }
}

function safeSqlText(value) {
  return String(value || '').replaceAll("'", "''")
}

function readRemoteD1Rows(entity, limit) {
  const allowed = new Set(['FoodLabel', 'LabelPrintLog'])
  if (!allowed.has(entity)) throw new Error(`Unsupported read-only entity: ${entity}`)
  if (!/^[A-Za-z0-9_-]+$/.test(outletId)) throw new Error('LOCAL_SANDBOX_OUTLET contains unsupported characters.')

  const sql = `SELECT entity_id, outlet_id, version, created_at, updated_at, deleted_at, payload_json
FROM ops_records
WHERE entity = '${safeSqlText(entity)}'
  AND outlet_id = '${safeSqlText(outletId)}'
  AND deleted_at = ''
ORDER BY updated_at DESC
LIMIT ${Math.max(1, Math.min(Number(limit) || 1000, 5000))};`
  assertReadOnlySql(sql)

  const output = wrangler([
    'd1',
    'execute',
    databaseName,
    '--remote',
    '--json',
    '--command',
    sql,
  ])
  const parsed = parseJsonOutput(output, `${databaseName}:${entity}`)
  const blocks = Array.isArray(parsed) ? parsed : [parsed]
  const rows = []

  for (const block of blocks) {
    const meta = block?.meta || {}
    if (Number(meta.changes || 0) !== 0 || Number(meta.rows_written || 0) !== 0 || meta.changed_db === true) {
      throw new Error(`Read-only verification failed for ${entity}.`)
    }
    for (const row of block?.results || []) {
      let payload = {}
      try { payload = JSON.parse(String(row.payload_json || '{}')) } catch {}
      rows.push({
        ...payload,
        id: payload.id || row.entity_id,
        outlet_id: payload.outlet_id || row.outlet_id,
        __realtime: {
          entity,
          entity_id: row.entity_id,
          outlet_id: row.outlet_id,
          version: Number(row.version || 0),
          created_at: row.created_at || '',
          updated_at: row.updated_at || '',
          deleted_at: row.deleted_at || '',
          production_snapshot_readonly: true,
        },
      })
    }
  }
  return rows
}

async function main() {
  if (!namespaceId) throw new Error('CLOUDFLARE_APP_DATA_PACKS_ID is required.')
  if (!databaseName) throw new Error('CLOUDFLARE_OPS_DB_NAME is required.')

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

  console.log('Reading FoodLabel history from remote D1 with SELECT only...')
  const foodLabels = readRemoteD1Rows('FoodLabel', 2000)
  console.log('Reading LabelPrintLog history from remote D1 with SELECT only...')
  const labelPrintLogs = readRemoteD1Rows('LabelPrintLog', 3000)

  const snapshot = {
    snapshot_version: 2,
    mode: 'production-published-package-and-d1-readonly',
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
    realtime: {
      FoodLabel: foodLabels,
      LabelPrintLog: labelPrintLogs,
    },
  }

  await fs.mkdir(targetDirectory, { recursive: true })
  await fs.writeFile(targetFile, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8')

  console.log('')
  console.log('READ_ONLY_PRODUCTION_PACK_READY=true')
  console.log(`OUTLET=${outletId}`)
  console.log(`VERSION=${manifest.version}`)
  console.log(`GENERATED_AT=${manifest.generated_at || ''}`)
  console.log(`FOOD_LABELS=${foodLabels.length}`)
  console.log(`LABEL_PRINT_LOGS=${labelPrintLogs.length}`)
  console.log(`FILE=${targetFile}`)
  console.log('No Cloudflare KV or D1 data was written or modified.')
}

main().catch((error) => {
  console.error('Unable to pull the read-only production package.')
  console.error(error?.message || error)
  process.exitCode = 1
})
