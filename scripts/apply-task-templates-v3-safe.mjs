import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const varsCandidates = [path.join(root, '.dev.vars'), path.join(root, 'worker', '.dev.vars')]
const varsPath = varsCandidates.find((candidate) => existsSync(candidate))
const outletId = String(process.env.CHEFOPS_TASK_OUTLET || 'RR-KCH').trim()
const reportDir = path.join(process.env.HOME || root, '.stupiaks-ops-data-packages', 'reports')
const prefix = 'CHEFOPS_CHECKLIST_V1:'

function parseEnv(text) {
  const result = {}
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const index = line.indexOf('=')
    if (index < 0) continue
    result[line.slice(0, index).trim()] = line.slice(index + 1).trim()
  }
  return result
}

function required(env, key) {
  const value = String(env[key] || '').trim()
  if (!value) throw new Error(`Missing ${key} in ${varsPath || 'local private configuration'}`)
  return value
}

async function googleJson(url, { token, method = 'GET', body } = {}) {
  const response = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await response.text()
  const data = text ? JSON.parse(text) : {}
  if (!response.ok) throw new Error(`Google API ${response.status}: ${JSON.stringify(data)}`)
  return data
}

async function accessToken(env) {
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: required(env, 'GOOGLE_DATA_CLIENT_ID'),
      client_secret: required(env, 'GOOGLE_DATA_CLIENT_SECRET'),
      refresh_token: required(env, 'GOOGLE_DATA_REFRESH_TOKEN'),
      grant_type: 'refresh_token',
    }),
  })
  const data = await response.json()
  if (!response.ok || !data.access_token) throw new Error('Unable to refresh Google access token')
  return data.access_token
}

function hashValues(values) {
  return createHash('sha256').update(JSON.stringify(values)).digest('hex')
}

function clean(value) {
  return String(value ?? '').trim()
}

function bool(value) {
  return value === true || ['true', 'yes', '1'].includes(clean(value).toLowerCase())
}

function parseConfig(row) {
  const raw = clean(row?.instructions)
  if (!raw.startsWith(prefix)) throw new Error(`Template ${row?.id || 'unknown'} has invalid checklist configuration`)
  return JSON.parse(raw.slice(prefix.length))
}

function rowsById(values) {
  if (!values.length) throw new Error('TaskTemplates sheet is empty')
  const headers = values[0].map(clean)
  const rows = values.slice(1).map((row) => Object.fromEntries(headers.map((header, index) => [header, row[index] ?? ''])))
  return new Map(rows.filter((row) => clean(row.id)).map((row) => [clean(row.id), row]))
}

async function readTaskTemplates(token, spreadsheetId) {
  const range = encodeURIComponent("'TaskTemplates'!A:ZZ")
  const data = await googleJson(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${range}`, { token })
  return data.values || []
}

function requiredRow(byId, id) {
  const row = byId.get(id)
  if (!row) throw new Error(`Post-write verification failed: ${id} was not found`)
  return row
}

function assertEqual(actual, expected, label) {
  if (String(actual) !== String(expected)) throw new Error(`Post-write verification failed: ${label} expected ${expected}, received ${actual}`)
}

function verifyApplied(values) {
  const byId = rowsById(values)

  const opening = requiredRow(byId, 'tmpl-rr-opening-checklist-v3')
  const openingConfig = parseConfig(opening)
  assertEqual(openingConfig.version, 3, 'opening config version')
  assertEqual(openingConfig.timezone, 'Asia/Kuching', 'opening timezone')
  const frozenItems = (openingConfig.sections || []).find((row) => row.id === 'frozen')?.items || []
  assertEqual(frozenItems.find((row) => row.id === 'op-11')?.response_type, 'QUANTITY', 'Pork Patty response type')
  if (!frozenItems.some((row) => row.id === 'op-11-storage')) throw new Error('Post-write verification failed: Pork Patty Storage Condition is missing')

  const quick = requiredRow(byId, 'tmpl-rr-toilet-quick-v3')
  const quickConfig = parseConfig(quick)
  assertEqual(clean(quick.period).toUpperCase(), 'DAILY', 'Toilet Quick Check period')
  assertEqual(clean(quick.status).toLowerCase(), 'active', 'Toilet Quick Check status')
  if (!bool(quick.is_active)) throw new Error('Post-write verification failed: Toilet Quick Check is not active')
  assertEqual(clean(quickConfig.schedule?.shift_id).toUpperCase(), 'DAILY', 'Toilet Quick Check shift')
  assertEqual(quickConfig.schedule?.open_time, '10:00', 'Toilet Quick Check open time')
  assertEqual(quickConfig.schedule?.due_time, '20:45', 'Toilet Quick Check due time')
  if (!(quickConfig.photo_groups || []).some((group) => clean(group.rule).toUpperCase() === 'ON_FAIL')) {
    throw new Error('Post-write verification failed: Toilet Quick Check issue-only photo rule is missing')
  }

  const full = requiredRow(byId, 'tmpl-rr-toilet-full-v3')
  const fullConfig = parseConfig(full)
  assertEqual(clean(full.period).toUpperCase(), 'NIGHT', 'Toilet Full Cleaning period')
  assertEqual(clean(full.status).toLowerCase(), 'active', 'Toilet Full Cleaning status')
  if (!bool(full.is_active)) throw new Error('Post-write verification failed: Toilet Full Cleaning is not active')
  assertEqual(clean(fullConfig.schedule?.shift_id).toUpperCase(), 'NIGHT', 'Toilet Full Cleaning shift')
  assertEqual(fullConfig.schedule?.open_time, '21:00', 'Toilet Full Cleaning open time')
  assertEqual(fullConfig.schedule?.due_time, '23:00', 'Toilet Full Cleaning due time')
  const requiredPhotos = (fullConfig.photo_groups || []).filter((group) => clean(group.rule).toUpperCase() === 'REQUIRED')
  assertEqual(requiredPhotos.length, 4, 'Toilet Full Cleaning required photo positions')
  if (requiredPhotos.some((group) => Number(group.min_photos || 0) !== 1)) {
    throw new Error('Post-write verification failed: each Toilet Full Cleaning photo position must require one photo')
  }

  const legacy = requiredRow(byId, 'tmpl-rr-toilet-morning-v3')
  assertEqual(clean(legacy.status).toLowerCase(), 'legacy', 'legacy toilet template status')
  if (bool(legacy.is_active)) throw new Error('Post-write verification failed: legacy morning toilet template is still active')

  return {
    opening: { id: opening.id, quantity_input: true, storage_condition_input: true },
    toilet_quick: { id: quick.id, period: 'DAILY', open_time: '10:00', due_time: '20:45', photo_requirement: 'issue_only' },
    toilet_full: { id: full.id, period: 'NIGHT', open_time: '21:00', due_time: '23:00', required_photo_positions: 4 },
    legacy_toilet: { id: legacy.id, active: false },
  }
}

async function main() {
  if (!varsPath) throw new Error('No .dev.vars or worker/.dev.vars was found')
  const env = parseEnv(await fs.readFile(varsPath, 'utf8'))
  const spreadsheetId = required(env, 'GOOGLE_MASTER_SPREADSHEET_ID')
  const token = await accessToken(env)
  await fs.mkdir(reportDir, { recursive: true })

  const startedAt = new Date().toISOString()
  const safeTime = startedAt.replaceAll(':', '-').replaceAll('.', '-')
  const beforeValues = await readTaskTemplates(token, spreadsheetId)
  const beforeHash = hashValues(beforeValues)
  const backupPath = path.join(reportDir, `${outletId}-task-template-v3-backup-${safeTime}.json`)
  await fs.writeFile(backupPath, `${JSON.stringify({
    schema: 'stupiaks-task-template-v3-backup',
    generated_at: startedAt,
    outlet_id: outletId,
    spreadsheet_id: spreadsheetId,
    source_sha256: beforeHash,
    values: beforeValues,
  }, null, 2)}\n`)

  console.log(`Backup: ${backupPath}`)
  console.log(`Source SHA-256: ${beforeHash}`)
  console.log('Running final no-write preflight...')
  execFileSync(process.execPath, ['scripts/upgrade-task-templates-v3-daily.mjs'], {
    cwd: root,
    stdio: 'inherit',
    env: process.env,
  })

  const preApplyValues = await readTaskTemplates(token, spreadsheetId)
  const preApplyHash = hashValues(preApplyValues)
  if (preApplyHash !== beforeHash) {
    throw new Error('TaskTemplates changed after the backup was created. No write was performed; review the newer Sheet contents and run Dry Run again.')
  }

  console.log('Sheet unchanged since backup. Applying Task Template v3...')
  execFileSync(process.execPath, ['scripts/upgrade-task-templates-v3-daily.mjs', '--apply'], {
    cwd: root,
    stdio: 'inherit',
    env: process.env,
  })

  const afterValues = await readTaskTemplates(token, spreadsheetId)
  const afterHash = hashValues(afterValues)
  const verification = verifyApplied(afterValues)
  const report = {
    schema: 'stupiaks-task-template-v3-safe-apply',
    generated_at: new Date().toISOString(),
    outlet_id: outletId,
    spreadsheet_id: spreadsheetId,
    writes_performed: true,
    backup_path: backupPath,
    source_sha256: beforeHash,
    final_sha256: afterHash,
    verification_passed: true,
    verification,
  }
  const reportPath = path.join(reportDir, `${outletId}-task-template-v3-safe-apply-${safeTime}.json`)
  await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`)

  console.log('\n✅ Task Template v3 safe apply passed')
  console.log(`Outlet: ${outletId}`)
  console.log(`Backup: ${backupPath}`)
  console.log(`Report: ${reportPath}`)
  console.log('Verified: Opening quantity/storage, Quick Check DAILY, Full Cleaning 21:00 with four photos, legacy template inactive.')
}

main().catch((error) => {
  console.error(`\n❌ ${error.message}`)
  process.exitCode = 1
})
