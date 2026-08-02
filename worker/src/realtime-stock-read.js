import { getCurrentUser } from './auth.js'
import { googleFetch } from './google.js'
import { errorResponse, json } from './http.js'
import { assertOutletAccess, assertReadPermission } from './permissions.js'
import { spreadsheetIdForEntity } from './storage.js'

const MAX_ROWS = 5000
const CANONICAL_OPERATIONS_2026_ID = '1bFkU_tFcuEz6UFFqz7ehw8F1ttY_MkzfmQKkk_pN9xw'
const HYDRATE_TIMEOUT_MS = 8000

function now() {
  return new Date().toISOString()
}

function parseJson(value, fallback = null) {
  try { return JSON.parse(String(value || '')) } catch { return fallback }
}

function rowId(row = {}) {
  return String(row.id || '').trim()
}

function realtimeRecord(row) {
  const record = parseJson(row?.payload_json, {}) || {}
  return {
    ...record,
    __realtime: {
      entity: 'StockCount',
      entity_id: row.entity_id,
      outlet_id: row.outlet_id,
      version: Number(row.version || 0),
      updated_at: row.updated_at || '',
      deleted_at: row.deleted_at || '',
      sync_status: 'synced',
    },
  }
}

function comparable(value) {
  if (value === null || value === undefined) return ''
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  return String(value)
}

function orderedComparison(left, right) {
  const numericLeft = Number(left)
  const numericRight = Number(right)
  if (comparable(left) !== '' && comparable(right) !== '' && Number.isFinite(numericLeft) && Number.isFinite(numericRight)) {
    return numericLeft - numericRight
  }
  return comparable(left).localeCompare(comparable(right))
}

function matchesExpected(actual, expected) {
  if (expected === undefined) return true
  if (Array.isArray(expected)) return expected.map(comparable).includes(comparable(actual))
  if (expected && typeof expected === 'object') {
    if (Array.isArray(expected.$in) && !expected.$in.map(comparable).includes(comparable(actual))) return false
    if (Array.isArray(expected.$nin) && expected.$nin.map(comparable).includes(comparable(actual))) return false
    if (Object.prototype.hasOwnProperty.call(expected, '$ne') && comparable(actual) === comparable(expected.$ne)) return false
    if (Object.prototype.hasOwnProperty.call(expected, '$eq') && comparable(actual) !== comparable(expected.$eq)) return false
    if (Object.prototype.hasOwnProperty.call(expected, '$lt') && orderedComparison(actual, expected.$lt) >= 0) return false
    if (Object.prototype.hasOwnProperty.call(expected, '$lte') && orderedComparison(actual, expected.$lte) > 0) return false
    if (Object.prototype.hasOwnProperty.call(expected, '$gt') && orderedComparison(actual, expected.$gt) <= 0) return false
    if (Object.prototype.hasOwnProperty.call(expected, '$gte') && orderedComparison(actual, expected.$gte) < 0) return false
    return true
  }
  return comparable(actual) === comparable(expected)
}

function filterRows(rows, filter = {}, includeDeleted = false) {
  return (rows || []).filter((row) => {
    if (!includeDeleted && String(row.deleted_at || row.__realtime?.deleted_at || '').trim()) return false
    return Object.entries(filter || {}).every(([key, expected]) => matchesExpected(row?.[key], expected))
  })
}

function sortRows(rows, sort = '') {
  const fields = String(sort || '').split(',').map((value) => value.trim()).filter(Boolean)
  if (!fields.length) return rows
  return [...rows].sort((left, right) => {
    for (const spec of fields) {
      const descending = spec.startsWith('-')
      const field = descending ? spec.slice(1) : spec
      const result = orderedComparison(left?.[field], right?.[field])
      if (result) return descending ? -result : result
    }
    return 0
  })
}

async function d1StockCounts(env, outletId) {
  const response = await env.OPS_DB.prepare(`
    SELECT * FROM ops_records
    WHERE entity = 'StockCount' AND outlet_id = ?
    ORDER BY business_date DESC, updated_at DESC
    LIMIT ?
  `).bind(outletId, MAX_ROWS).all()
  return (response.results || []).map(realtimeRecord)
}

function valuesUrl(spreadsheetId) {
  const range = encodeURIComponent("'StockCounts'!A1:W5000")
  return `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${range}?majorDimension=ROWS`
}

function stockRows(values, outletId) {
  const headers = (values[0] || []).map((value) => String(value || '').trim())
  if (!headers.includes('id') || !headers.includes('outlet_id') || !headers.includes('count_date')) return []
  return values.slice(1).flatMap((cells) => {
    const row = Object.fromEntries(headers.map((header, index) => [header, cells[index] ?? '']))
    if (!rowId(row) || String(row.outlet_id || '') !== outletId) return []
    return [{ ...row, deleted_at: '' }]
  })
}

function spreadsheetIds(env, year) {
  const ids = []
  try {
    const configured = String(spreadsheetIdForEntity(env, 'StockCount', { year })?.spreadsheetId || '').trim()
    if (configured) ids.push(configured)
  } catch (error) {
    console.error('Configured StockCounts spreadsheet could not be resolved', year, error)
  }
  if (Number(year) === 2026) ids.push(CANONICAL_OPERATIONS_2026_ID)
  return [...new Set(ids)]
}

function timeoutAfter(ms) {
  return new Promise((_, reject) => {
    const error = new Error('Historical StockCounts hydration timed out')
    error.code = 'stock_history_timeout'
    setTimeout(() => reject(error), ms)
  })
}

async function readStockSheet(env, outletId, year) {
  const errors = []
  for (const spreadsheetId of spreadsheetIds(env, year)) {
    try {
      const response = await Promise.race([
        googleFetch(env, valuesUrl(spreadsheetId)),
        timeoutAfter(HYDRATE_TIMEOUT_MS),
      ])
      const payload = await response.json()
      const rows = stockRows(Array.isArray(payload.values) ? payload.values : [], outletId)
      if (rows.length) return { rows, spreadsheetId }
    } catch (error) {
      errors.push(error)
      console.error('StockCounts spreadsheet candidate failed', spreadsheetId, error)
    }
  }
  if (errors.length) throw errors[errors.length - 1]
  return { rows: [], spreadsheetId: '' }
}

async function persistStockCounts(env, outletId, rows) {
  const timestamp = now()
  const statements = []

  for (const row of rows || []) {
    const id = rowId(row)
    if (!id) continue
    const createdAt = String(row.created_date || timestamp)
    const updatedAt = String(row.updated_date || createdAt || timestamp)
    const createdBy = String(row.created_by || row.counted_by_email || 'legacy-sheet')
    const updatedBy = String(row.updated_by || createdBy)
    const version = Math.max(1, Number(row.version || 1) || 1)
    const activeRow = { ...row, outlet_id: outletId, deleted_at: '' }

    statements.push(env.OPS_DB.prepare(`
      INSERT INTO ops_records (
        entity, entity_id, outlet_id, business_date, status, payload_json,
        version, created_at, created_by, updated_at, updated_by, deleted_at
      ) VALUES ('StockCount', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '')
      ON CONFLICT(entity, entity_id) DO UPDATE SET
        outlet_id = excluded.outlet_id,
        business_date = excluded.business_date,
        status = excluded.status,
        payload_json = excluded.payload_json,
        version = CASE WHEN ops_records.version > excluded.version THEN ops_records.version ELSE excluded.version END,
        updated_at = excluded.updated_at,
        updated_by = excluded.updated_by,
        deleted_at = ''
      WHERE ops_records.deleted_at <> ''
    `).bind(
      id,
      outletId,
      String(row.count_date || '').slice(0, 10),
      String(row.status || 'counted'),
      JSON.stringify(activeRow),
      version,
      createdAt,
      createdBy,
      updatedAt,
      updatedBy,
    ))
  }

  for (let index = 0; index < statements.length; index += 50) {
    const chunk = statements.slice(index, index + 50)
    if (chunk.length) await env.OPS_DB.batch(chunk)
  }
  return statements.length
}

function requestedDate(filter = {}, year) {
  const value = filter?.count_date
  if (typeof value === 'string' && value) return value.slice(0, 10)
  if (value && typeof value === 'object') {
    for (const key of ['$lte', '$lt', '$eq']) {
      if (value[key]) return String(value[key]).slice(0, 10)
    }
  }
  return `${Number(year) || new Date().getUTCFullYear()}-12-31`
}

function needsHistoricalHydration(rows, filter, year) {
  const upperDate = requestedDate(filter, year)
  const active = (rows || []).filter((row) => !String(row.deleted_at || row.__realtime?.deleted_at || '').trim())
  return !active.some((row) => {
    const date = String(row.count_date || '')
    return date && date < upperDate
  })
}

export async function handleRealtimeStockRead(request, env, url) {
  if (url.pathname !== '/api/realtime/records' || request.method !== 'GET') return null
  if (String(url.searchParams.get('entity') || '') !== 'StockCount') return null

  try {
    if (!env.OPS_DB?.prepare || !env.OPS_DB?.batch) {
      const error = new Error('Realtime D1 database is not configured')
      error.status = 503
      error.code = 'realtime_database_unavailable'
      throw error
    }

    const user = await getCurrentUser(request, env)
    assertReadPermission(user, 'StockCount')
    const outletId = String(url.searchParams.get('outlet_id') || user.outlet_id || '').trim()
    if (!outletId) {
      const error = new Error('Outlet is required for stock count records')
      error.status = 400
      error.code = 'realtime_outlet_required'
      throw error
    }
    assertOutletAccess(user, outletId)

    const filter = parseJson(url.searchParams.get('filter'), {}) || {}
    const sort = url.searchParams.get('sort') || ''
    const includeDeleted = url.searchParams.get('include_deleted') === '1'
    const limit = Math.max(1, Math.min(Number(url.searchParams.get('limit') || 100), MAX_ROWS))
    const year = Number(url.searchParams.get('year') || String(filter.count_date?.$lte || filter.count_date || '').slice(0, 4) || new Date().getUTCFullYear())

    let allRows = await d1StockCounts(env, outletId)
    let source = allRows.length ? 'd1' : 'd1-empty'
    let seeded = 0
    let spreadsheetId = ''
    let legacyErrorCode = ''

    if (url.searchParams.get('legacy_seed') !== '0' && needsHistoricalHydration(allRows, filter, year)) {
      try {
        const sheet = await readStockSheet(env, outletId, year)
        spreadsheetId = sheet.spreadsheetId
        seeded = await persistStockCounts(env, outletId, sheet.rows)
        allRows = await d1StockCounts(env, outletId)
        if (sheet.rows.length) source = 'stock-history-sheet-d1'
      } catch (error) {
        legacyErrorCode = String(error?.code || 'stock_history_unavailable')
        console.error('Historical StockCounts hydration unavailable', outletId, year, error)
      }
    }

    const records = sortRows(filterRows(allRows, filter, includeDeleted), sort).slice(0, limit)
    return json(request, env, {
      records,
      count: records.length,
      source,
      seeded,
      spreadsheet_id: spreadsheetId,
      legacy_error_code: legacyErrorCode,
      server_time: now(),
    })
  } catch (error) {
    return errorResponse(request, env, error)
  }
}
