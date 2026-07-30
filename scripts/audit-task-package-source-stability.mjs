import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const varsCandidates = [path.join(root, '.dev.vars'), path.join(root, 'worker', '.dev.vars')]
const reportDir = path.join(os.homedir(), '.stupiaks-ops-data-packages', 'reports')

function clean(value = '') {
  return String(value ?? '').trim()
}

function bool(value) {
  return value === true || ['true', 'yes', '1'].includes(clean(value).toLowerCase())
}

function parseArgs(argv) {
  const result = { outlet: 'RR-KCH', waitSeconds: 20, expectedReport: '' }
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (value === '--outlet') result.outlet = clean(argv[++index])
    else if (value === '--wait-seconds') result.waitSeconds = Number(argv[++index] || 0)
    else if (value === '--expected-report') result.expectedReport = clean(argv[++index])
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
Read-only Task Package source stability audit

Usage:
  node scripts/audit-task-package-source-stability.mjs \\
    --outlet RR-KCH \\
    --wait-seconds 20 \\
    --expected-report ~/.stupiaks-ops-data-packages/reports/RR-KCH-prepare-media-....json

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

async function googleValues(token, spreadsheetId, sheet) {
  const range = encodeURIComponent(`'${sheet}'!A:ZZ`)
  const response = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${range}`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: 'no-store',
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(`Google Sheets ${response.status}: ${JSON.stringify(data).slice(0, 500)}`)
  return data.values || []
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]))
}

function hash(value) {
  return createHash('sha256').update(JSON.stringify(stable(value))).digest('hex')
}

function normalizeValues(values) {
  return (values || []).map((row) => {
    const next = [...row]
    while (next.length && clean(next.at(-1)) === '') next.pop()
    return next.map((value) => value ?? '')
  })
}

function table(values) {
  const normalized = normalizeValues(values)
  const headers = (normalized[0] || []).map(clean)
  const rows = normalized.slice(1).map((cells, index) => ({
    row_number: index + 2,
    record: Object.fromEntries(headers.map((header, column) => [header, cells[column] ?? ''])),
  }))
  return { headers, rows, values: normalized }
}

function activeTemplate(row) {
  return clean(row.deleted_at) === '' && bool(row.is_active)
}

function activePhoto(row) {
  return clean(row.deleted_at) === ''
}

function duplicates(rows, predicate) {
  const grouped = new Map()
  for (const entry of rows) {
    if (!predicate(entry.record)) continue
    const id = clean(entry.record.id)
    if (!id) continue
    if (!grouped.has(id)) grouped.set(id, [])
    grouped.get(id).push(entry.row_number)
  }
  return [...grouped.entries()]
    .filter(([, rowNumbers]) => rowNumbers.length > 1)
    .map(([id, rowNumbers]) => ({ id, rows: rowNumbers }))
}

function rowMap(tableData) {
  return new Map(tableData.rows.map((entry) => [`${entry.row_number}:${clean(entry.record.id)}`, entry]))
}

function fieldHash(value) {
  return {
    sha256: createHash('sha256').update(String(value ?? '')).digest('hex'),
    length: String(value ?? '').length,
  }
}

function diffTables(before, after, sheet) {
  const result = []
  const beforeMap = rowMap(before)
  const afterMap = rowMap(after)
  const keys = [...new Set([...beforeMap.keys(), ...afterMap.keys()])].sort()

  for (const key of keys) {
    const left = beforeMap.get(key)
    const right = afterMap.get(key)
    if (!left) {
      result.push({ sheet, change: 'added', row: right.row_number, id: clean(right.record.id) })
      continue
    }
    if (!right) {
      result.push({ sheet, change: 'removed', row: left.row_number, id: clean(left.record.id) })
      continue
    }

    const fields = [...new Set([...Object.keys(left.record), ...Object.keys(right.record)])]
      .filter((field) => String(left.record[field] ?? '') !== String(right.record[field] ?? ''))
      .map((field) => ({
        field,
        before: fieldHash(left.record[field]),
        after: fieldHash(right.record[field]),
      }))

    if (fields.length) result.push({ sheet, change: 'changed', row: right.row_number, id: clean(right.record.id), fields })
  }

  return result
}

function requiredSingle(rows, id) {
  const matches = rows.filter((entry) => clean(entry.record.id) === id)
  if (matches.length !== 1) throw new Error(`${id} must exist exactly once; found ${matches.length}`)
  return matches[0]
}

function verifyTaskV3State(templateTable) {
  const opening = requiredSingle(templateTable.rows, 'tmpl-rr-opening-checklist-v3').record
  const quick = requiredSingle(templateTable.rows, 'tmpl-rr-toilet-quick-v3').record
  const full = requiredSingle(templateTable.rows, 'tmpl-rr-toilet-full-v3').record
  const legacy = requiredSingle(templateTable.rows, 'tmpl-rr-toilet-morning-v3').record

  if (!activeTemplate(opening)) throw new Error('Opening Preparation Check is not active')
  if (!activeTemplate(quick)) throw new Error('Toilet Quick Check is not active')
  if (!activeTemplate(full)) throw new Error('Toilet Full Cleaning is not active')
  if (activeTemplate(legacy)) throw new Error('Legacy Morning Toilet Cleaning is still active')
  if (clean(quick.period).toUpperCase() !== 'DAILY') throw new Error('Toilet Quick Check period is not DAILY')
  if (clean(full.period).toUpperCase() !== 'NIGHT') throw new Error('Toilet Full Cleaning period is not NIGHT')

  return {
    opening: { row: requiredSingle(templateTable.rows, opening.id).row_number, version: Number(opening.version || 0) },
    toilet_quick: { row: requiredSingle(templateTable.rows, quick.id).row_number, version: Number(quick.version || 0), period: clean(quick.period), due_time: clean(quick.due_time) },
    toilet_full: { row: requiredSingle(templateTable.rows, full.id).row_number, version: Number(full.version || 0), period: clean(full.period), due_time: clean(full.due_time) },
    legacy_toilet: { row: requiredSingle(templateTable.rows, legacy.id).row_number, active: activeTemplate(legacy) },
  }
}

async function snapshot(token, spreadsheetId) {
  const [templatesRaw, photosRaw] = await Promise.all([
    googleValues(token, spreadsheetId, 'TaskTemplates'),
    googleValues(token, spreadsheetId, 'TaskTemplatePhotos'),
  ])
  const templates = table(templatesRaw)
  const photos = table(photosRaw)
  return {
    captured_at: new Date().toISOString(),
    templates,
    photos,
    hashes: {
      task_templates_raw: hash(templates.values),
      task_template_photos_raw: hash(photos.values),
      combined: hash({ templates: templates.values, photos: photos.values }),
    },
    counts: {
      task_templates_rows: templates.rows.length,
      active_task_templates: templates.rows.filter((entry) => activeTemplate(entry.record)).length,
      task_template_photo_rows: photos.rows.length,
      active_task_template_photos: photos.rows.filter((entry) => activePhoto(entry.record)).length,
    },
    duplicates: {
      active_task_template_ids: duplicates(templates.rows, activeTemplate),
      active_task_template_photo_ids: duplicates(photos.rows, activePhoto),
    },
    task_v3: verifyTaskV3State(templates),
  }
}

function publicSnapshot(value) {
  return {
    captured_at: value.captured_at,
    hashes: value.hashes,
    counts: value.counts,
    duplicates: value.duplicates,
    task_v3: value.task_v3,
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) return usage()

  const env = await loadEnv()
  const spreadsheetId = required(env, 'GOOGLE_MASTER_SPREADSHEET_ID')
  const token = await accessToken(env)

  console.log(`Reading TaskTemplates and TaskTemplatePhotos directly from Google Sheets for ${args.outlet} ...`)
  const first = await snapshot(token, spreadsheetId)
  console.log(`First source SHA-256: ${first.hashes.combined}`)
  console.log(`Active templates: ${first.counts.active_task_templates}`)
  console.log(`Template photos: ${first.counts.active_task_template_photos}`)

  if (first.duplicates.active_task_template_ids.length || first.duplicates.active_task_template_photo_ids.length) {
    console.log('Duplicate active IDs detected in the first snapshot.')
  }

  if (args.waitSeconds > 0) {
    console.log(`Waiting ${args.waitSeconds} seconds before the second direct read ...`)
    await new Promise((resolve) => setTimeout(resolve, args.waitSeconds * 1000))
  }

  const second = await snapshot(token, spreadsheetId)
  const changes = [
    ...diffTables(first.templates, second.templates, 'TaskTemplates'),
    ...diffTables(first.photos, second.photos, 'TaskTemplatePhotos'),
  ]
  const stableSource = first.hashes.combined === second.hashes.combined && changes.length === 0
  const duplicateFree = !second.duplicates.active_task_template_ids.length && !second.duplicates.active_task_template_photo_ids.length

  let expected = null
  if (args.expectedReport) {
    const expectedPath = path.resolve(args.expectedReport)
    const sourceReport = JSON.parse(await fs.readFile(expectedPath, 'utf8'))
    expected = {
      path: expectedPath,
      source_pack_version: clean(sourceReport.source_pack_version),
      draft_version: clean(sourceReport.draft_version),
      tasks_module: sourceReport.draft_manifest?.modules?.tasks || null,
      total_package_bytes: Number(sourceReport.total_package_bytes || 0),
    }
  }

  const report = {
    schema: 'stupiaks-task-package-source-stability-audit-v1',
    generated_at: new Date().toISOString(),
    outlet_id: args.outlet,
    writes_performed: false,
    wait_seconds: args.waitSeconds,
    stable_source: stableSource,
    duplicate_free: duplicateFree,
    first: publicSnapshot(first),
    second: publicSnapshot(second),
    changes,
    expected_prepare_media: expected,
  }

  await fs.mkdir(reportDir, { recursive: true })
  const safeTime = report.generated_at.replaceAll(':', '-').replaceAll('.', '-')
  const reportPath = path.join(reportDir, `${args.outlet}-task-source-stability-${safeTime}.json`)
  await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')

  console.log(`Second source SHA-256: ${second.hashes.combined}`)
  console.log(`Changes during audit: ${changes.length}`)
  console.log(`Duplicate active template IDs: ${second.duplicates.active_task_template_ids.length}`)
  console.log(`Duplicate active photo IDs: ${second.duplicates.active_task_template_photo_ids.length}`)
  console.log(`Report: ${reportPath}`)
  console.log('No Google Sheet rows were changed.')

  if (!duplicateFree) throw new Error('Duplicate active TaskTemplate or TaskTemplatePhoto IDs must be resolved before packaging')
  if (!stableSource) throw new Error('Task package source changed during the stability audit')
  console.log('\n✅ Task package source stability audit passed')
}

main().catch((error) => {
  console.error(`\n❌ ${error.message}`)
  process.exitCode = 1
})
