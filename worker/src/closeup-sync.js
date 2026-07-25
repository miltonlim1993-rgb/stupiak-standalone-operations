import { googleFetch } from './google.js'

const APP_VERSION = '4.3.0-ops-insights-data-gate'
const DEFAULT_REGISTRY_SHEET = 'Outlet Reports'
const RELATION_SHEET = '_RelationDaily'
const LOG_SHEET = '_CashShiftLog'

const REGISTRY_HEADERS = [
  'Active', 'FeedMe Outlet ID', 'Outlet Code', 'Outlet Name', 'Year',
  'Report Spreadsheet ID', 'Report URL', 'Outlet Folder ID', 'Site Key',
  'Updated At', 'Source',
]

const LOG_HEADERS = [
  'Event ID', 'Saved At', 'Business Date', 'Outlet', 'Phase', 'Sequence',
  'Opening / Counted Total', 'Outgoing Total', 'Incoming Total', 'Variance',
  'From Staff', 'To Staff', 'Counted By', 'Cash Breakdown', 'Outgoing Breakdown',
  'Incoming Breakdown', 'Denominations JSON', 'Remark', 'Source',
  'Source Version', 'Payments JSON',
]

const PAYMENT_HEADERS = [
  { aliases: ['duitnow', 'duitnowqr', 'duitnowcard', 'qr'], header: 'DuitNow/Card Actual' },
  { aliases: ['sarawakpay', 'spay', 'spayglobal'], header: 'SPay Actual' },
  { aliases: ['payandgo', 'paygo'], header: 'Pay & Go Actual' },
  { aliases: ['grabdineout'], header: 'Grab Dine Out Actual' },
  { aliases: ['grabfood', 'gf'], header: 'GF Actual' },
  { aliases: ['shopeefood'], header: 'Shopee Food Actual' },
  { aliases: ['foodpanda'], header: 'Foodpanda Actual' },
]

function text(value) {
  return value === null || value === undefined ? '' : String(value).trim()
}

function number(value) {
  const parsed = Number(value || 0)
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 0
}

function json(value, fallback = {}) {
  try {
    const parsed = JSON.parse(String(value || ''))
    return parsed && typeof parsed === 'object' ? parsed : fallback
  } catch {
    return fallback
  }
}

function normalized(value) {
  return text(value).toLowerCase().replace(/[^a-z0-9]+/g, '')
}

function active(value) {
  if (value === true || value === 1) return true
  if (value === false || value === 0) return false
  return !['', 'false', 'no', 'n', '0', 'inactive', 'disabled'].includes(text(value).toLowerCase())
}

function a1(sheet, range) {
  return `'${String(sheet).replaceAll("'", "''")}'!${range}`
}

function valuesUrl(spreadsheetId, range, suffix = '') {
  return `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}${suffix}`
}

function extractId(value) {
  const raw = text(value)
  const match = raw.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/) || raw.match(/^([a-zA-Z0-9_-]{20,})$/)
  return match ? match[1] : ''
}

function extractFolderId(value) {
  const raw = text(value)
  const match = raw.match(/\/folders\/([a-zA-Z0-9_-]+)/) || raw.match(/^([a-zA-Z0-9_-]{20,})$/)
  return match ? match[1] : ''
}

function columnName(indexOneBased) {
  let value = Number(indexOneBased)
  let result = ''
  while (value > 0) {
    value -= 1
    result = String.fromCharCode(65 + (value % 26)) + result
    value = Math.floor(value / 26)
  }
  return result
}

function dateKey(value) {
  const raw = text(value)
  let match = raw.match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (match) return `${match[1]}-${match[2]}-${match[3]}`
  match = raw.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})$/)
  if (match) return `${match[3]}-${String(match[2]).padStart(2, '0')}-${String(match[1]).padStart(2, '0')}`
  return raw
}

function phaseFor(record) {
  const shift = normalized(record.shift_id || record.shift_name)
  if (shift.includes('morning') || shift.includes('opening')) return 'opening'
  if (shift.includes('handover')) return 'handover'
  return 'closing'
}

function amountMap(record) {
  const payload = json(record.payments_json, {})
  const amounts = payload.amounts && typeof payload.amounts === 'object' ? payload.amounts : payload
  const result = new Map()
  Object.entries(amounts || {}).forEach(([key, value]) => result.set(normalized(key), number(value)))
  return result
}

function paymentValue(amounts, aliases) {
  for (const alias of aliases) if (amounts.has(alias)) return amounts.get(alias)
  for (const [key, value] of amounts.entries()) {
    if (aliases.some((alias) => key.includes(alias) || alias.includes(key))) return value
  }
  return 0
}

function paymentEntries(record) {
  const payload = json(record.payments_json, {})
  const amounts = payload.amounts && typeof payload.amounts === 'object' ? payload.amounts : payload
  const methods = Array.isArray(payload.methods) ? payload.methods : []
  const byCode = new Map(methods.map((item) => [normalized(item.code), item]))
  return Object.entries(amounts || {}).map(([code, raw]) => {
    const item = byCode.get(normalized(code)) || {}
    return {
      id: text(code),
      code: text(code),
      name: text(item.name || code),
      category: text(item.category),
      actual: number(raw),
      remark: '',
    }
  })
}

function denominationEntriesFromValue(value) {
  const source = typeof value === 'string' ? json(value, {}) : (value || {})
  const values = source.denominations && typeof source.denominations === 'object' ? source.denominations : source
  const order = [100, 50, 20, 10, 5, 1, 0.5, 0.2, 0.1, 0.05]
  return order.map((denomination) => {
    const candidates = [
      String(denomination),
      `rm${String(denomination).replace('.', '_')}`,
      `RM${denomination}`,
      String(denomination).replace('.', '_'),
    ].map(normalized)
    let count = 0
    for (const [key, raw] of Object.entries(values || {})) {
      if (candidates.includes(normalized(key))) {
        count = number(raw)
        break
      }
    }
    return { denomination, count, amount: denomination * count }
  })
}

function cashBreakdownFromValue(value) {
  return denominationEntriesFromValue(value)
    .filter((item) => item.count > 0)
    .map((item) => `RM${item.denomination.toFixed(item.denomination < 1 ? 2 : 0)} x ${item.count} = RM${item.amount.toFixed(2)}`)
    .join(' | ')
}

function cashBreakdown(record) {
  return cashBreakdownFromValue(record.denominations_json)
}

function denominationPayload(record) {
  const standard = json(record.denominations_json, {})
  const outgoing = json(record.outgoing_denominations_json, {})
  const incoming = json(record.incoming_denominations_json, {})
  const standardValues = standard.denominations && typeof standard.denominations === 'object' ? standard.denominations : standard
  const outgoingValues = outgoing.denominations && typeof outgoing.denominations === 'object' ? outgoing.denominations : outgoing
  const incomingValues = incoming.denominations && typeof incoming.denominations === 'object' ? incoming.denominations : incoming
  return {
    denominations: standardValues || {},
    otherCash: 0,
    outgoingDenominations: outgoingValues || {},
    outgoingOtherCash: 0,
    incomingDenominations: incomingValues || {},
    incomingOtherCash: 0,
  }
}

function registrySettings(env) {
  const spreadsheetId = extractId(
    env.SALES_REPORT_REGISTRY_SPREADSHEET_ID ||
    env.CASH_REGISTRY_SPREADSHEET_ID ||
    env.SALES_TEMPLATE_SPREADSHEET_ID,
  )
  if (!spreadsheetId) {
    const error = new Error('Sales report registry spreadsheet is not configured')
    error.code = 'sales_registry_not_configured'
    throw error
  }
  return {
    spreadsheetId,
    sheetName: text(env.SALES_REPORT_REGISTRY_SHEET_NAME || env.CASH_REGISTRY_SHEET_NAME || DEFAULT_REGISTRY_SHEET),
    templateId: extractId(env.SALES_REPORT_TEMPLATE_SPREADSHEET_ID),
    defaultFolderId: extractFolderId(env.SALES_REPORT_DEFAULT_FOLDER_ID),
  }
}

async function readRegistry(env, settings) {
  const response = await googleFetch(
    env,
    valuesUrl(settings.spreadsheetId, a1(settings.sheetName, 'A1:K5000')),
  )
  const data = await response.json()
  const values = data.values || []
  const headers = values[0] || []
  const headerMap = new Map(headers.map((header, index) => [text(header), index]))
  for (const header of REGISTRY_HEADERS) {
    if (!headerMap.has(header)) {
      const error = new Error(`Sales report registry is missing column: ${header}`)
      error.code = 'sales_registry_invalid'
      throw error
    }
  }
  const rows = values.slice(1).map((row, index) => {
    const item = { rowNumber: index + 2 }
    headers.forEach((header, column) => { item[text(header)] = row[column] ?? '' })
    return item
  })
  return { headers, headerMap, rows }
}

function outletRefs(record, env) {
  const configured = json(env.SALES_REPORT_OUTLET_REFS_JSON, {})
  const item = configured[text(record.outlet_id)] || configured[normalized(record.outlet_id)] || {}
  return new Set([
    record.outlet_id,
    record.outlet_name,
    item.feedmeOutletId,
    item.outletCode,
    item.outletName,
    item.siteKey,
  ].map(normalized).filter(Boolean))
}

function matchesOutlet(item, refs) {
  return ['FeedMe Outlet ID', 'Outlet Code', 'Outlet Name', 'Site Key']
    .some((header) => refs.has(normalized(item[header])))
}

async function copyYearlyReport(env, settings, base, record, year) {
  if (!settings.templateId) {
    const error = new Error(`No report is registered for ${record.outlet_id} in ${year}, and SALES_REPORT_TEMPLATE_SPREADSHEET_ID is not configured`)
    error.code = 'sales_year_report_missing'
    throw error
  }
  const folderId = extractFolderId(base?.['Outlet Folder ID']) || settings.defaultFolderId
  const outletCode = text(base?.['Outlet Code'] || record.outlet_id)
  const outletName = text(base?.['Outlet Name'] || record.outlet_name || outletCode)
  const feedmeOutletId = text(base?.['FeedMe Outlet ID'])
  const siteKey = text(base?.['Site Key'] || outletCode)
  const name = `${outletName || outletCode} Sales ${year}`
  const body = { name }
  if (folderId) body.parents = [folderId]

  const response = await googleFetch(
    env,
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(settings.templateId)}/copy?supportsAllDrives=true&fields=id,name,webViewLink`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
  )
  const copied = await response.json()
  const values = [[
    true,
    feedmeOutletId,
    outletCode,
    outletName,
    year,
    copied.id,
    copied.webViewLink || `https://docs.google.com/spreadsheets/d/${copied.id}/edit`,
    folderId,
    siteKey,
    new Date().toISOString(),
    'ChefOps yearly report auto-create',
  ]]

  await googleFetch(
    env,
    valuesUrl(
      settings.spreadsheetId,
      a1(settings.sheetName, 'A:K'),
      '?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS',
    ) + ':append',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ majorDimension: 'ROWS', values }),
    },
  )

  return {
    spreadsheetId: copied.id,
    spreadsheetName: copied.name || name,
    spreadsheetUrl: copied.webViewLink || `https://docs.google.com/spreadsheets/d/${copied.id}/edit`,
    relationOutlet: outletName || outletCode,
    outletCode,
    outletName,
    feedmeOutletId,
    siteKey,
    folderId,
    year,
    registrySpreadsheetId: settings.spreadsheetId,
    registrySheetName: settings.sheetName,
    createdYearFile: true,
  }
}

async function resolveYearlyReport(env, record) {
  const settings = registrySettings(env)
  const registry = await readRegistry(env, settings)
  const refs = outletRefs(record, env)
  const year = Number(text(record.business_date).slice(0, 4))
  const matching = registry.rows.filter((item) => matchesOutlet(item, refs))
  const exact = matching.filter((item) => active(item.Active) && Number(item.Year) === year)

  if (exact.length > 1) {
    const error = new Error(`More than one active yearly report is registered for ${record.outlet_id} in ${year}`)
    error.code = 'sales_registry_duplicate'
    throw error
  }
  if (!exact.length) {
    const latest = matching.sort((a, b) => Number(b.Year || 0) - Number(a.Year || 0))[0] || null
    return copyYearlyReport(env, settings, latest, record, year)
  }

  const item = exact[0]
  const spreadsheetId = extractId(item['Report Spreadsheet ID'] || item['Report URL'])
  if (!spreadsheetId) {
    const error = new Error(`Registry row ${item.rowNumber} has no Report Spreadsheet ID`)
    error.code = 'sales_registry_target_missing'
    throw error
  }
  return {
    spreadsheetId,
    spreadsheetName: '',
    spreadsheetUrl: text(item['Report URL']) || `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`,
    relationOutlet: text(item['Outlet Name'] || item['Outlet Code'] || record.outlet_id),
    outletCode: text(item['Outlet Code'] || record.outlet_id),
    outletName: text(item['Outlet Name']),
    feedmeOutletId: text(item['FeedMe Outlet ID']),
    siteKey: text(item['Site Key']),
    folderId: extractFolderId(item['Outlet Folder ID']),
    year,
    registrySpreadsheetId: settings.spreadsheetId,
    registrySheetName: settings.sheetName,
    registryRowNumber: item.rowNumber,
    createdYearFile: false,
  }
}

async function readRelation(env, spreadsheetId) {
  const response = await googleFetch(
    env,
    valuesUrl(spreadsheetId, a1(RELATION_SHEET, 'A1:BD5000')),
  )
  const data = await response.json()
  const values = data.values || []
  const headers = values[0] || []
  const headerMap = new Map(headers.map((header, index) => [text(header), index]))
  if (!headerMap.has('Business Date') || !headerMap.has('Outlet')) {
    const error = new Error('Yearly sales report is missing Business Date or Outlet in _RelationDaily')
    error.code = 'sales_report_invalid_relation'
    throw error
  }
  return { headers, headerMap, rows: values.slice(1) }
}

function findRelationRow(relation, businessDate, relationOutlet, outletCode) {
  const dateIndex = relation.headerMap.get('Business Date')
  const outletIndex = relation.headerMap.get('Outlet')
  const accepted = new Set([relationOutlet, outletCode].map(normalized).filter(Boolean))
  for (let index = 0; index < relation.rows.length; index += 1) {
    const row = relation.rows[index]
    if (dateKey(row[dateIndex]) !== dateKey(businessDate)) continue
    const rowOutlet = normalized(row[outletIndex])
    if (!rowOutlet || accepted.has(rowOutlet)) return index + 2
  }
  return 0
}

async function ensureRelationRow(env, target, relation, record) {
  const existing = findRelationRow(relation, record.business_date, target.relationOutlet, target.outletCode)
  if (existing) return existing
  const rowNumber = relation.rows.length + 2
  const row = Array(Math.max(relation.headers.length, 56)).fill('')
  row[relation.headerMap.get('Business Date')] = record.business_date
  row[relation.headerMap.get('Outlet')] = target.relationOutlet
  await googleFetch(
    env,
    valuesUrl(target.spreadsheetId, a1(RELATION_SHEET, `A${rowNumber}:BD${rowNumber}`), '?valueInputOption=USER_ENTERED'),
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ majorDimension: 'ROWS', values: [row] }),
    },
  )
  return rowNumber
}

function updateCell(updates, relation, rowNumber, header, value) {
  const index = relation.headerMap.get(header)
  if (index === undefined) return
  updates.push({
    range: a1(RELATION_SHEET, `${columnName(index + 1)}${rowNumber}`),
    majorDimension: 'ROWS',
    values: [[value === null || value === undefined ? '' : value]],
  })
}

async function writeRelation(env, target, relation, rowNumber, record) {
  const updates = []
  const phase = phaseFor(record)
  const submittedAt = text(record.submitted_at || record.updated_date || new Date().toISOString())
  updateCell(updates, relation, rowNumber, 'Business Date', record.business_date)
  updateCell(updates, relation, rowNumber, 'Outlet', target.relationOutlet)

  if (phase === 'opening') {
    updateCell(updates, relation, rowNumber, 'Opening Count', number(record.actual_cash))
    updateCell(updates, relation, rowNumber, 'Morning Staff', text(record.submitted_by_name || record.submitted_by_email || record.created_by))
  } else if (phase === 'handover') {
    updateCell(updates, relation, rowNumber, 'Handover Out', number(record.outgoing_cash))
    updateCell(updates, relation, rowNumber, 'Handover In', number(record.incoming_cash || record.actual_cash))
    updateCell(updates, relation, rowNumber, 'From Staff', text(record.from_staff))
    updateCell(updates, relation, rowNumber, 'To Staff', text(record.to_staff))
    const amounts = amountMap(record)
    PAYMENT_HEADERS.forEach((mapping) => updateCell(updates, relation, rowNumber, mapping.header, paymentValue(amounts, mapping.aliases)))
  } else if (phase === 'closing') {
    updateCell(updates, relation, rowNumber, 'Night Closing Actual', number(record.actual_cash))
    updateCell(updates, relation, rowNumber, 'Prepared By', text(record.submitted_by_name || record.submitted_by_email || record.created_by))
    updateCell(updates, relation, rowNumber, 'Cash Breakdown', cashBreakdown(record))
    if (relation.headerMap.has('Close Up Note')) updateCell(updates, relation, rowNumber, 'Close Up Note', text(record.notes))
    else updateCell(updates, relation, rowNumber, 'Daily Remark', text(record.notes))
    const amounts = amountMap(record)
    PAYMENT_HEADERS.forEach((mapping) => updateCell(updates, relation, rowNumber, mapping.header, paymentValue(amounts, mapping.aliases)))
  }

  updateCell(updates, relation, rowNumber, 'Submitted At', submittedAt)
  updateCell(updates, relation, rowNumber, 'Source Saved At', submittedAt)
  if (!updates.length) throw new Error('No compatible yearly sales report columns were found')

  await googleFetch(
    env,
    `https://sheets.googleapis.com/v4/spreadsheets/${target.spreadsheetId}/values:batchUpdate`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ valueInputOption: 'USER_ENTERED', data: updates }),
    },
  )
  return { phase, updatedCells: updates.length }
}

async function ensureLogSheet(env, spreadsheetId) {
  const metadataResponse = await googleFetch(
    env,
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}?fields=sheets(properties(sheetId,title,hidden,gridProperties(rowCount,columnCount)))`,
  )
  const metadata = await metadataResponse.json()
  let sheet = (metadata.sheets || []).find((item) => item.properties?.title === LOG_SHEET)
  if (!sheet) {
    const addResponse = await googleFetch(
      env,
      `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}:batchUpdate`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requests: [{ addSheet: { properties: { title: LOG_SHEET, hidden: true, gridProperties: { columnCount: LOG_HEADERS.length, rowCount: 2000 } } } }] }),
      },
    )
    const added = await addResponse.json()
    sheet = { properties: added.replies?.[0]?.addSheet?.properties || { title: LOG_SHEET } }
  }

  await googleFetch(
    env,
    valuesUrl(spreadsheetId, a1(LOG_SHEET, `A1:${columnName(LOG_HEADERS.length)}1`), '?valueInputOption=RAW'),
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ majorDimension: 'ROWS', values: [LOG_HEADERS] }),
    },
  )
  return sheet
}

async function readLog(env, spreadsheetId) {
  await ensureLogSheet(env, spreadsheetId)
  const response = await googleFetch(
    env,
    valuesUrl(spreadsheetId, a1(LOG_SHEET, `A1:${columnName(LOG_HEADERS.length)}5000`)),
  )
  const data = await response.json()
  const values = data.values || []
  return { headers: values[0] || LOG_HEADERS, rows: values.slice(1) }
}

function nextSequence(log, businessDate, outlet) {
  let max = 0
  log.rows.forEach((row) => {
    if (dateKey(row[2]) === dateKey(businessDate) && normalized(row[3]) === normalized(outlet)) {
      max = Math.max(max, Number(row[5] || 0))
    }
  })
  return max + 1
}

async function writeLog(env, target, record) {
  const log = await readLog(env, target.spreadsheetId)
  const existingIndex = log.rows.findIndex((row) => text(row[0]) === text(record.id))
  const rowNumber = existingIndex >= 0 ? existingIndex + 2 : log.rows.length + 2
  const sequence = existingIndex >= 0
    ? Number(log.rows[existingIndex][5] || 1)
    : Number(record.handover_sequence || 0) || nextSequence(log, record.business_date, target.relationOutlet)
  const phase = phaseFor(record)
  const savedAt = text(record.submitted_at || record.updated_date || new Date().toISOString())
  const isHandover = phase === 'handover'
  const row = [
    text(record.id),
    savedAt,
    record.business_date,
    target.relationOutlet,
    phase,
    sequence,
    isHandover ? '' : number(record.actual_cash),
    isHandover ? number(record.outgoing_cash) : '',
    isHandover ? number(record.incoming_cash || record.actual_cash) : '',
    isHandover ? number(record.handover_variance || (number(record.incoming_cash) - number(record.outgoing_cash))) : '',
    isHandover ? text(record.from_staff) : '',
    isHandover ? text(record.to_staff) : '',
    text(record.submitted_by_name || record.submitted_by_email || record.created_by),
    isHandover ? '' : cashBreakdown(record),
    isHandover ? cashBreakdownFromValue(record.outgoing_denominations_json) : '',
    isHandover ? cashBreakdownFromValue(record.incoming_denominations_json) : '',
    JSON.stringify(denominationPayload(record)),
    text(record.notes),
    'chefops-close-up',
    APP_VERSION,
    JSON.stringify(paymentEntries(record)),
  ]

  await googleFetch(
    env,
    valuesUrl(target.spreadsheetId, a1(LOG_SHEET, `A${rowNumber}:${columnName(LOG_HEADERS.length)}${rowNumber}`), '?valueInputOption=USER_ENTERED'),
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ majorDimension: 'ROWS', values: [row] }),
    },
  )
  return { logRowNumber: rowNumber, sequence, logUpdated: existingIndex >= 0 }
}

export async function syncCloseUpToSalesTemplate(env, record) {
  const previousAttempts = Number(record.sync_attempts || 0)
  let target = null
  try {
    target = await resolveYearlyReport(env, record)
    const relation = await readRelation(env, target.spreadsheetId)
    const rowNumber = await ensureRelationRow(env, target, relation, record)
    const relationResult = await writeRelation(env, target, relation, rowNumber, record)
    const logResult = await writeLog(env, target, record)
    const externalKey = `yearly:${target.spreadsheetId}:${target.relationOutlet}|${record.business_date}|${record.shift_id}|${record.id}`
    return {
      sync_status: 'synced',
      sync_attempts: previousAttempts + 1,
      last_sync_at: new Date().toISOString(),
      last_sync_error: '',
      external_sync_key: externalKey,
      external_response_json: JSON.stringify({
        ok: true,
        mode: 'registry-yearly-report',
        version: APP_VERSION,
        registrySpreadsheetId: target.registrySpreadsheetId,
        registrySheetName: target.registrySheetName,
        registryRowNumber: target.registryRowNumber || '',
        spreadsheetId: target.spreadsheetId,
        spreadsheetUrl: target.spreadsheetUrl,
        relationSheet: RELATION_SHEET,
        relationRowNumber: rowNumber,
        logSheet: LOG_SHEET,
        relationOutlet: target.relationOutlet,
        createdYearFile: target.createdYearFile,
        ...relationResult,
        ...logResult,
      }),
    }
  } catch (error) {
    return {
      sync_status: 'pending_retry',
      sync_attempts: previousAttempts + 1,
      last_sync_at: new Date().toISOString(),
      last_sync_error: text(error?.message || error).slice(0, 1000),
      external_sync_key: target
        ? `yearly:${target.spreadsheetId}:${target.relationOutlet}|${record.business_date}|${record.shift_id}|${record.id}`
        : `${record.outlet_id}|${record.business_date}|${record.shift_id}|${record.id}`,
      external_response_json: error?.details ? JSON.stringify(error.details) : '',
    }
  }
}
