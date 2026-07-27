import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const reportDir = path.join(os.homedir(), '.stupiaks-ops-data-packages', 'reports')
const configPath = path.join(root, 'config', 'task-sample-photos-v4.json')
const DEFAULT_FOLDER_ID = '1XUuFdzIyXNwYw-q2E5P7sW44EFLLVyPG'
const SHEET = 'TaskTemplatePhotos'
const ACTOR = 'task-sample-photo-v4@stupiaks-ops'
const ACCEPTED_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp'])
const REQUIRED_HEADERS = [
  'id', 'outlet_id', 'created_date', 'created_by', 'updated_date', 'updated_by',
  'deleted_at', 'version', 'template_id', 'display_order', 'photo_type',
  'drive_file_id', 'file_name', 'file_url', 'caption', 'enabled',
]

function clean(value = '') {
  return String(value ?? '').trim()
}

function bool(value) {
  return value === true || ['true', 'yes', '1'].includes(clean(value).toLowerCase())
}

function parseArgs(argv) {
  const result = {
    outlet: 'RR-KCH',
    folderId: '',
    apply: false,
    report: '',
  }

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (value === '--outlet') result.outlet = clean(argv[++index])
    else if (value === '--folder-id') result.folderId = clean(argv[++index])
    else if (value === '--report') result.report = clean(argv[++index])
    else if (value === '--apply') result.apply = true
    else if (value === '--help' || value === '-h') result.help = true
    else throw new Error(`Unknown argument: ${value}`)
  }

  return result
}

function usage() {
  console.log(`
RR-KCH V4 Task Sample Photo Importer

Dry run:
  node scripts/import-task-sample-photos-v4.mjs

Apply after all required files are present:
  node scripts/import-task-sample-photos-v4.mjs --apply

Files must be JPG, JPEG, PNG or WEBP. The filename without extension must
exactly match a slot ID from config/task-sample-photos-v4.json.

Dry run never writes Google Sheet rows. Apply creates a local backup, checks
for concurrent changes, writes TaskTemplatePhotos, then reads it back to verify.
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
    result[key] = value.replaceAll('\\n', '\n')
  }
  return result
}

async function loadEnv() {
  const result = {}
  for (const candidate of [path.join(root, '.dev.vars'), path.join(root, 'worker', '.dev.vars')]) {
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
  if (!response.ok || !data.access_token) {
    throw new Error(data.error_description || data.error || 'Unable to refresh Google access token')
  }
  return data.access_token
}

async function googleJson(token, url, options = {}) {
  const headers = new Headers(options.headers || {})
  headers.set('Authorization', `Bearer ${token}`)
  const response = await fetch(url, { ...options, headers, cache: 'no-store' })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(`Google API ${response.status}: ${JSON.stringify(data).slice(0, 800)}`)
  return data
}

async function listFolderFiles(token, folderId) {
  const files = []
  let pageToken = ''

  do {
    const url = new URL('https://www.googleapis.com/drive/v3/files')
    url.searchParams.set('q', `'${folderId.replaceAll("'", "\\'")}' in parents and trashed=false`)
    url.searchParams.set('fields', 'nextPageToken,files(id,name,mimeType,size,modifiedTime,md5Checksum)')
    url.searchParams.set('pageSize', '1000')
    url.searchParams.set('supportsAllDrives', 'true')
    url.searchParams.set('includeItemsFromAllDrives', 'true')
    if (pageToken) url.searchParams.set('pageToken', pageToken)

    const data = await googleJson(token, url)
    files.push(...(data.files || []))
    pageToken = clean(data.nextPageToken)
  } while (pageToken)

  return files
    .filter((file) => ACCEPTED_EXTENSIONS.has(path.extname(clean(file.name)).toLowerCase()))
    .map((file) => ({
      id: clean(file.id),
      name: clean(file.name),
      stem: path.basename(clean(file.name), path.extname(clean(file.name))),
      mime_type: clean(file.mimeType),
      bytes: Number(file.size || 0),
      modified_time: clean(file.modifiedTime),
      md5: clean(file.md5Checksum),
    }))
    .sort((left, right) => left.name.localeCompare(right.name))
}

async function readSheet(token, spreadsheetId) {
  const range = encodeURIComponent(`'${SHEET}'!A:ZZ`)
  const data = await googleJson(token, `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${range}`)
  return normalizeValues(data.values || [])
}

function normalizeValues(values) {
  return (values || []).map((row) => {
    const next = [...row]
    while (next.length && clean(next.at(-1)) === '') next.pop()
    return next.map((value) => value ?? '')
  })
}

function parseTable(values) {
  const headers = (values[0] || []).map(clean)
  const missingHeaders = REQUIRED_HEADERS.filter((header) => !headers.includes(header))
  if (missingHeaders.length) throw new Error(`${SHEET} is missing headers: ${missingHeaders.join(', ')}`)

  const rows = values.slice(1).map((cells, index) => ({
    row: index + 2,
    record: Object.fromEntries(headers.map((header, column) => [header, cells[column] ?? ''])),
  }))
  return { headers, rows }
}

function sha256(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function duplicateIds(rows) {
  const seen = new Map()
  for (const entry of rows) {
    const id = clean(entry.record.id)
    if (!id) continue
    if (!seen.has(id)) seen.set(id, [])
    seen.get(id).push(entry.row)
  }
  return [...seen.entries()]
    .filter(([, locations]) => locations.length > 1)
    .map(([id, locations]) => ({ id, rows: locations }))
}

function indexFiles(files) {
  const byStem = new Map()
  for (const file of files) {
    if (!byStem.has(file.stem)) byStem.set(file.stem, [])
    byStem.get(file.stem).push(file)
  }
  return byStem
}

function caption(slot) {
  return `${slot.label_cn} / ${slot.label_en}`
}

function desiredRecord(slot, file, current, outletId, now) {
  return {
    ...(current || {}),
    id: slot.id,
    outlet_id: outletId,
    created_date: clean(current?.created_date) || now,
    created_by: clean(current?.created_by) || ACTOR,
    updated_date: now,
    updated_by: ACTOR,
    deleted_at: '',
    version: Math.max(1, Number(current?.version || 0) + (current ? 1 : 0)),
    template_id: slot.template_id,
    display_order: Number(slot.display_order || 0),
    photo_type: slot.photo_group_id,
    drive_file_id: file.id,
    file_name: file.name,
    file_url: '',
    caption: caption(slot),
    enabled: true,
  }
}

function comparable(record = {}) {
  return {
    id: clean(record.id),
    outlet_id: clean(record.outlet_id),
    template_id: clean(record.template_id),
    display_order: Number(record.display_order || 0),
    photo_type: clean(record.photo_type),
    drive_file_id: clean(record.drive_file_id),
    file_name: clean(record.file_name),
    file_url: clean(record.file_url),
    caption: clean(record.caption),
    enabled: bool(record.enabled),
    deleted_at: clean(record.deleted_at),
  }
}

function buildPlan(config, files, table, outletId) {
  const fileIndex = indexFiles(files)
  const slotIds = new Set(config.slots.map((slot) => slot.id))
  const existingIndex = new Map(table.rows.map((entry) => [clean(entry.record.id), entry]))
  const missing = []
  const duplicates = []
  const changes = []
  const resolved = []
  const now = new Date().toISOString()

  for (const slot of config.slots) {
    const matches = fileIndex.get(slot.id) || []
    if (!matches.length) {
      missing.push({ ...slot, expected_filename: `${slot.id}.jpg` })
      continue
    }
    if (matches.length > 1) {
      duplicates.push({ slot_id: slot.id, files: matches.map((file) => file.name) })
      continue
    }

    const file = matches[0]
    const existing = existingIndex.get(slot.id)
    const desired = desiredRecord(slot, file, existing?.record, outletId, now)
    const action = !existing
      ? 'append'
      : sha256(comparable(existing.record)) === sha256(comparable(desired))
        ? 'unchanged'
        : 'update'

    resolved.push({ slot, file, existing, desired, action })
    changes.push({
      id: slot.id,
      action,
      template_id: slot.template_id,
      photo_group_id: slot.photo_group_id,
      file_name: file.name,
      drive_file_id: file.id,
    })
  }

  const unknown = files
    .filter((file) => !slotIds.has(file.stem))
    .map((file) => ({ file_name: file.name, drive_file_id: file.id }))

  return { missing, duplicates, unknown, changes, resolved }
}

function finalValues(table, plan) {
  const records = table.rows.map((entry) => ({ ...entry.record }))
  const index = new Map(records.map((record, position) => [clean(record.id), position]))

  for (const item of plan.resolved) {
    if (item.action === 'unchanged') continue
    const position = index.get(item.slot.id)
    if (position === undefined) {
      index.set(item.slot.id, records.length)
      records.push(item.desired)
    } else {
      records[position] = item.desired
    }
  }

  return [
    table.headers,
    ...records.map((record) => table.headers.map((header) => record[header] ?? '')),
  ]
}

async function writeSheet(token, spreadsheetId, values) {
  const lastColumn = columnName(values[0].length)
  const range = encodeURIComponent(`'${SHEET}'!A1:${lastColumn}${values.length}`)
  return googleJson(token, `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${range}?valueInputOption=RAW`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ majorDimension: 'ROWS', values }),
  })
}

function columnName(count) {
  let value = Number(count || 0)
  let result = ''
  while (value > 0) {
    value -= 1
    result = String.fromCharCode(65 + (value % 26)) + result
    value = Math.floor(value / 26)
  }
  return result
}

function verifyApplied(config, table, plan, outletId) {
  const byId = new Map(table.rows.map((entry) => [clean(entry.record.id), entry.record]))
  const errors = []

  for (const item of plan.resolved) {
    const record = byId.get(item.slot.id)
    if (!record) {
      errors.push(`${item.slot.id}: row missing`)
      continue
    }
    const expected = comparable(item.desired)
    const actual = comparable(record)
    if (sha256(actual) !== sha256(expected)) errors.push(`${item.slot.id}: verification mismatch`)
    if (actual.outlet_id !== outletId) errors.push(`${item.slot.id}: wrong outlet`)
  }

  const configured = config.slots.filter((slot) => byId.has(slot.id)).length
  if (configured !== config.slots.length) errors.push(`Configured sample rows ${configured}/${config.slots.length}`)
  if (errors.length) throw new Error(`Sample photo write verification failed: ${errors.join('; ')}`)
  return { configured_slots: configured, required_slots: config.slots.length }
}

function defaultReportPath(outletId, apply) {
  const time = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')
  const mode = apply ? 'apply' : 'dry-run'
  return path.join(reportDir, `${outletId}-task-sample-photos-v4-${mode}-${time}.json`)
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) return usage()

  const config = JSON.parse(await fs.readFile(configPath, 'utf8'))
  if (config.schema !== 'stupiaks-task-sample-photo-slots-v4') throw new Error('Invalid sample photo slot config schema')
  if (clean(config.outlet_id) !== args.outlet) throw new Error('Sample photo config outlet does not match --outlet')
  if (!Array.isArray(config.slots) || config.slots.length !== 15) throw new Error('Exactly 15 V4 sample photo slots are required')
  const duplicateSlotIds = config.slots.filter((slot, index, rows) => rows.findIndex((item) => item.id === slot.id) !== index)
  if (duplicateSlotIds.length) throw new Error(`Duplicate slot IDs: ${duplicateSlotIds.map((slot) => slot.id).join(', ')}`)

  const env = await loadEnv()
  const spreadsheetId = required(env, 'GOOGLE_MASTER_SPREADSHEET_ID')
  const folderId = args.folderId || clean(env.GOOGLE_TASK_SAMPLE_PHOTO_FOLDER_ID) || DEFAULT_FOLDER_ID
  const token = await accessToken(env)
  const reportPath = args.report ? path.resolve(args.report) : defaultReportPath(args.outlet, args.apply)

  console.log(`Scanning RR-KCH Task Sample Photos folder: ${folderId}`)
  const [files, sourceValues] = await Promise.all([
    listFolderFiles(token, folderId),
    readSheet(token, spreadsheetId),
  ])
  const table = parseTable(sourceValues)
  const duplicatesInSheet = duplicateIds(table.rows)
  if (duplicatesInSheet.length) throw new Error(`Duplicate TaskTemplatePhoto IDs: ${duplicatesInSheet.map((item) => item.id).join(', ')}`)

  const sourceSha256 = sha256(sourceValues)
  const folderSha256 = sha256(files)
  const plan = buildPlan(config, files, table, args.outlet)
  const report = {
    schema: 'stupiaks-task-sample-photo-v4-import-report-v1',
    generated_at: new Date().toISOString(),
    outlet_id: args.outlet,
    mode: args.apply ? 'apply' : 'dry-run',
    writes_performed: false,
    spreadsheet_id: spreadsheetId,
    folder_id: folderId,
    source_sha256: sourceSha256,
    folder_sha256: folderSha256,
    required_slots: config.slots.length,
    matched_slots: plan.resolved.length,
    missing_slots: plan.missing,
    duplicate_files: plan.duplicates,
    unknown_files: plan.unknown,
    changes: plan.changes,
    backup_path: '',
    verification_passed: false,
  }

  console.log(`Required slots: ${config.slots.length}`)
  console.log(`Matched slots: ${plan.resolved.length}`)
  console.log(`Missing slots: ${plan.missing.length}`)
  console.log(`Duplicate filenames: ${plan.duplicates.length}`)

  for (const missing of plan.missing) {
    console.log(`- MISSING ${missing.expected_filename} · ${missing.label_cn} / ${missing.label_en}`)
    console.log(`  ${missing.required_angle_cn}`)
    console.log(`  ${missing.required_angle_en}`)
  }
  for (const duplicate of plan.duplicates) console.log(`- DUPLICATE ${duplicate.slot_id}: ${duplicate.files.join(', ')}`)
  for (const unknown of plan.unknown) console.log(`- IGNORED ${unknown.file_name}`)

  if (!args.apply) {
    await writeJson(reportPath, report)
    console.log(`\nDry run report: ${reportPath}`)
    console.log('No Google Sheet rows were changed.')
    return
  }

  if (plan.missing.length || plan.duplicates.length) {
    await writeJson(reportPath, report)
    throw new Error('Apply is blocked until all 15 exact filenames exist with no duplicates')
  }

  const backupPath = path.join(
    reportDir,
    `${args.outlet}-task-template-photos-backup-${new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')}.json`,
  )
  await writeJson(backupPath, {
    schema: 'stupiaks-task-template-photos-backup-v1',
    generated_at: new Date().toISOString(),
    spreadsheet_id: spreadsheetId,
    sheet: SHEET,
    source_sha256: sourceSha256,
    values: sourceValues,
  })
  report.backup_path = backupPath
  console.log(`Backup: ${backupPath}`)

  const [latestFiles, latestValues] = await Promise.all([
    listFolderFiles(token, folderId),
    readSheet(token, spreadsheetId),
  ])
  if (sha256(latestFiles) !== folderSha256) throw new Error('Drive folder changed after preflight. Run the importer again.')
  if (sha256(latestValues) !== sourceSha256) throw new Error('TaskTemplatePhotos changed after backup. Run the importer again.')

  const final = finalValues(table, plan)
  await writeSheet(token, spreadsheetId, final)
  const verifiedTable = parseTable(await readSheet(token, spreadsheetId))
  const verification = verifyApplied(config, verifiedTable, plan, args.outlet)

  report.writes_performed = true
  report.verification_passed = true
  report.final_sha256 = sha256([verifiedTable.headers, ...verifiedTable.rows.map((entry) => verifiedTable.headers.map((header) => entry.record[header] ?? ''))])
  report.verification = verification
  await writeJson(reportPath, report)

  console.log('\n✅ RR-KCH V4 Task Sample Photos applied and verified')
  console.log(`Configured: ${verification.configured_slots}/${verification.required_slots}`)
  console.log(`Report: ${reportPath}`)
}

main().catch((error) => {
  console.error(`\n❌ ${error.message}`)
  process.exitCode = 1
})
