import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const reportDir = path.join(os.homedir(), '.stupiaks-ops-data-packages', 'reports')
const varsCandidates = [path.join(root, '.dev.vars'), path.join(root, 'worker', '.dev.vars')]

function clean(value = '') {
  return String(value ?? '').trim()
}

function bool(value) {
  return value === true || ['true', 'yes', '1'].includes(clean(value).toLowerCase())
}

function parseArgs(argv) {
  const result = { outlet: 'RR-KCH', waitSeconds: 20 }
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (value === '--outlet') result.outlet = clean(argv[++index])
    else if (value === '--wait-seconds') result.waitSeconds = Number(argv[++index] || 0)
    else if (value === '--help' || value === '-h') result.help = true
    else throw new Error(`Unknown argument: ${value}`)
  }
  if (!Number.isFinite(result.waitSeconds) || result.waitSeconds < 0 || result.waitSeconds > 600) {
    throw new Error('--wait-seconds must be between 0 and 600')
  }
  return result
}

function usage() {
  console.log(`
Read-only V4 Task Package source audit

Usage:
  node scripts/audit-task-package-source-v4.mjs --outlet RR-KCH --wait-seconds 20

No Google Sheet rows are written.
`)
}

function parseEnv(text) {
  const result = {}
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#') || !line.includes('=')) continue
    const index = line.indexOf('=')
    const key = line.slice(0, index).trim()
    let value = line.slice(index + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    result[key] = value
  }
  return result
}

async function loadEnv() {
  const result = {}
  for (const candidate of varsCandidates) {
    try { Object.assign(result, parseEnv(await fs.readFile(candidate, 'utf8'))) } catch {}
  }
  return { ...result, ...process.env }
}

function required(env, key) {
  const value = clean(env[key])
  if (!value) throw new Error(`${key} is missing from local private configuration`)
  return value
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
  const data = await response.json().catch(() => ({}))
  if (!response.ok || !data.access_token) throw new Error('Unable to refresh Google access token')
  return data.access_token
}

async function readValues(token, spreadsheetId, sheetName) {
  const range = encodeURIComponent(`'${sheetName}'!A:ZZ`)
  const response = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${range}`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: 'no-store',
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(`Google Sheets ${response.status}: ${JSON.stringify(data).slice(0, 500)}`)
  return data.values || []
}

function normalizeValues(values) {
  return (values || []).map((row) => {
    const next = [...row]
    while (next.length && clean(next.at(-1)) === '') next.pop()
    return next.map((value) => value ?? '')
  })
}

function parseTable(values) {
  const normalized = normalizeValues(values)
  const headers = (normalized[0] || []).map(clean)
  const rows = normalized.slice(1).map((cells, index) => ({
    row: index + 2,
    record: Object.fromEntries(headers.map((header, column) => [header, cells[column] ?? ''])),
  }))
  return { values: normalized, headers, rows }
}

function sha256(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function activeTemplate(record) {
  return clean(record.deleted_at) === '' && bool(record.is_active) && clean(record.status).toLowerCase() === 'active'
}

function activePhoto(record) {
  return clean(record.deleted_at) === '' && bool(record.enabled) && Boolean(clean(record.drive_file_id || record.file_url))
}

function rowsForId(table, id) {
  return table.rows.filter((entry) => clean(entry.record.id) === id)
}

function requireExactlyOne(table, id) {
  const matches = rowsForId(table, id)
  if (matches.length !== 1) throw new Error(`${id} must exist exactly once; found ${matches.length}`)
  return matches[0]
}

function duplicateIds(table) {
  const groups = new Map()
  for (const entry of table.rows) {
    const id = clean(entry.record.id)
    if (!id) continue
    if (!groups.has(id)) groups.set(id, [])
    groups.get(id).push(entry.row)
  }
  return [...groups.entries()].filter(([, rows]) => rows.length > 1).map(([id, rows]) => ({ id, rows }))
}

function parseChecklist(record) {
  const raw = clean(record.instructions)
  const prefix = 'CHEFOPS_CHECKLIST_V1:'
  if (!raw.startsWith(prefix)) throw new Error(`${record.id} has invalid checklist configuration`)
  return JSON.parse(raw.slice(prefix.length))
}

function templateState(table, id, expected) {
  const entry = requireExactlyOne(table, id)
  const record = entry.record
  const config = parseChecklist(record)
  const active = activeTemplate(record)

  if (expected.active !== active) throw new Error(`${id} active expected ${expected.active}, received ${active}`)
  if (expected.period && clean(record.period).toUpperCase() !== expected.period) {
    throw new Error(`${id} period expected ${expected.period}, received ${record.period}`)
  }
  if (expected.shift && clean(config.schedule?.shift_id).toUpperCase() !== expected.shift) {
    throw new Error(`${id} shift expected ${expected.shift}, received ${config.schedule?.shift_id}`)
  }
  if (expected.open && clean(config.schedule?.open_time) !== expected.open) {
    throw new Error(`${id} open time expected ${expected.open}, received ${config.schedule?.open_time}`)
  }

  return {
    id,
    row: entry.row,
    active,
    status: clean(record.status),
    period: clean(record.period),
    shift_id: clean(config.schedule?.shift_id),
    open_time: clean(config.schedule?.open_time),
    due_time: clean(config.schedule?.due_time),
    timezone: clean(config.timezone),
    version: Number(record.version || 0),
  }
}

async function snapshot(token, spreadsheetId) {
  const [templateValues, photoValues] = await Promise.all([
    readValues(token, spreadsheetId, 'TaskTemplates'),
    readValues(token, spreadsheetId, 'TaskTemplatePhotos'),
  ])
  const templates = parseTable(templateValues)
  const photos = parseTable(photoValues)
  const templateDuplicates = duplicateIds(templates)
  const photoDuplicates = duplicateIds(photos)
  if (templateDuplicates.length) throw new Error(`Duplicate TaskTemplate IDs: ${templateDuplicates.map((item) => item.id).join(', ')}`)
  if (photoDuplicates.length) throw new Error(`Duplicate TaskTemplatePhoto IDs: ${photoDuplicates.map((item) => item.id).join(', ')}`)

  const states = {
    opening_v3: templateState(templates, 'tmpl-rr-opening-checklist-v3', { active: true, period: 'MORNING', shift: 'MORNING', open: '10:00' }),
    toilet_full_v3: templateState(templates, 'tmpl-rr-toilet-full-v3', { active: true, period: 'NIGHT', shift: 'NIGHT', open: '21:00' }),
    toilet_quick_v3: templateState(templates, 'tmpl-rr-toilet-quick-v3', { active: false, period: 'DAILY', shift: 'DAILY', open: '10:00' }),
    morning_cleaning_v4: templateState(templates, 'tmpl-rr-morning-cleaning-v4', { active: true, period: 'MORNING', shift: 'MORNING', open: '11:00' }),
    toilet_quick_v4: templateState(templates, 'tmpl-rr-toilet-quick-v4', { active: true, period: 'SHIFT_CONTROLLED', shift: 'SHIFT_CONTROLLED', open: '10:00' }),
    evening_closing_v4: templateState(templates, 'tmpl-rr-evening-closing-v4', { active: true, period: 'NIGHT', shift: 'NIGHT', open: '21:00' }),
  }

  return {
    captured_at: new Date().toISOString(),
    hashes: {
      task_templates: sha256(templates.values),
      task_template_photos: sha256(photos.values),
      combined: sha256({ templates: templates.values, photos: photos.values }),
    },
    counts: {
      template_rows: templates.rows.length,
      active_templates: templates.rows.filter((entry) => activeTemplate(entry.record)).length,
      photo_rows: photos.rows.length,
      enabled_sample_photos: photos.rows.filter((entry) => activePhoto(entry.record)).length,
    },
    states,
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) return usage()

  const env = await loadEnv()
  const spreadsheetId = required(env, 'GOOGLE_MASTER_SPREADSHEET_ID')
  const token = await accessToken(env)
  await fs.mkdir(reportDir, { recursive: true })

  console.log(`Reading current V4 Task source for ${args.outlet} ...`)
  const first = await snapshot(token, spreadsheetId)
  console.log(`First source SHA-256: ${first.hashes.combined}`)
  console.log(`Active templates: ${first.counts.active_templates}`)
  console.log(`Enabled real sample photos: ${first.counts.enabled_sample_photos}`)

  if (args.waitSeconds > 0) {
    console.log(`Waiting ${args.waitSeconds} seconds before the second direct read ...`)
    await new Promise((resolve) => setTimeout(resolve, args.waitSeconds * 1000))
  }

  const second = await snapshot(token, spreadsheetId)
  const stable = first.hashes.combined === second.hashes.combined
  const report = {
    schema: 'stupiaks-task-package-source-v4-audit-v1',
    generated_at: new Date().toISOString(),
    outlet_id: args.outlet,
    writes_performed: false,
    wait_seconds: args.waitSeconds,
    stable_source: stable,
    first,
    second,
    sample_photos_ready: second.counts.enabled_sample_photos > 0,
  }
  const safeTime = report.generated_at.replaceAll(':', '-').replaceAll('.', '-')
  const reportPath = path.join(reportDir, `${args.outlet}-task-source-v4-${safeTime}.json`)
  await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')

  console.log(`Second source SHA-256: ${second.hashes.combined}`)
  console.log(`Stable source: ${stable}`)
  console.log(`Report: ${reportPath}`)
  console.log('No Google Sheet rows were changed.')

  if (!stable) throw new Error('TaskTemplates or TaskTemplatePhotos changed during the audit window')
  console.log('\n✅ V4 Task package source audit passed')
  if (!report.sample_photos_ready) {
    console.log('⚠️ Real Sample Photo media is not configured yet; photo positions and captions are available.')
  }
}

main().catch((error) => {
  console.error(`\n❌ ${error.message}`)
  process.exitCode = 1
})
