import { getCurrentUser } from './auth.js'
import { googleFetch } from './google.js'
import { errorResponse, json } from './http.js'
import { assertOutletAccess, assertReadPermission } from './permissions.js'
import { spreadsheetIdForEntity } from './storage.js'

const MAX_ROWS = 5000
const CANONICAL_OPERATIONS_2026_ID = '1bFkU_tFcuEz6UFFqz7ehw8F1ttY_MkzfmQKkk_pN9xw'

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
      entity: 'Attendance',
      entity_id: row.entity_id,
      outlet_id: row.outlet_id,
      version: Number(row.version || 0),
      updated_at: row.updated_at || '',
      deleted_at: row.deleted_at || '',
      sync_status: 'synced',
    },
  }
}

function matchesExpected(actual, expected) {
  if (expected === undefined || expected === null || expected === '') return true
  if (typeof expected === 'boolean') return Boolean(actual) === expected
  if (expected && typeof expected === 'object' && !Array.isArray(expected)) {
    if ('$in' in expected && !expected.$in.map(String).includes(String(actual ?? ''))) return false
    if ('$ne' in expected && String(actual ?? '') === String(expected.$ne)) return false
    if ('$gte' in expected && String(actual ?? '') < String(expected.$gte)) return false
    if ('$lte' in expected && String(actual ?? '') > String(expected.$lte)) return false
    if ('$gt' in expected && String(actual ?? '') <= String(expected.$gt)) return false
    if ('$lt' in expected && String(actual ?? '') >= String(expected.$lt)) return false
    return true
  }
  return String(actual ?? '') === String(expected)
}

function filterRows(rows, filter = {}, includeDeleted = false) {
  return (rows || []).filter((row) => {
    if (!includeDeleted && String(row.deleted_at || row.__realtime?.deleted_at || '').trim()) return false
    return Object.entries(filter || {}).every(([key, expected]) => matchesExpected(row?.[key], expected))
  })
}

function compareValues(left, right) {
  const a = left ?? ''
  const b = right ?? ''
  if (typeof a === 'number' && typeof b === 'number') return a - b
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' })
}

function sortRows(rows, sort = '') {
  const fields = String(sort || '').split(',').map((value) => value.trim()).filter(Boolean)
  if (!fields.length) return rows
  return [...rows].sort((left, right) => {
    for (const spec of fields) {
      const descending = spec.startsWith('-')
      const field = descending ? spec.slice(1) : spec
      const result = compareValues(left?.[field], right?.[field])
      if (result) return descending ? -result : result
    }
    return 0
  })
}

async function d1Attendance(env, outletId) {
  const response = await env.OPS_DB.prepare(`
    SELECT * FROM ops_records
    WHERE entity = 'Attendance' AND outlet_id = ?
    ORDER BY business_date DESC, updated_at DESC
    LIMIT ?
  `).bind(outletId, MAX_ROWS).all()
  return (response.results || []).map(realtimeRecord)
}

function valuesUrl(spreadsheetId) {
  const range = encodeURIComponent("'Attendance'!A1:P5000")
  return `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${range}?majorDimension=ROWS`
}

function attendanceRows(values, outletId) {
  const headers = (values[0] || []).map((value) => String(value || '').trim())
  if (!headers.includes('id') || !headers.includes('outlet_id') || !headers.includes('date')) return []
  return values.slice(1).flatMap((cells) => {
    const row = Object.fromEntries(headers.map((header, index) => [header, cells[index] ?? '']))
    if (!rowId(row) || String(row.outlet_id || '') !== outletId) return []
    return [{ ...row, deleted_at: '' }]
  })
}

function attendanceSpreadsheetIds(env, year) {
  const ids = []
  try {
    const configured = String(spreadsheetIdForEntity(env, 'Attendance', { year })?.spreadsheetId || '').trim()
    if (configured) ids.push(configured)
  } catch (error) {
    console.error('Configured Attendance spreadsheet could not be resolved', year, error)
  }
  if (Number(year) === 2026) ids.push(CANONICAL_OPERATIONS_2026_ID)
  return [...new Set(ids)]
}

async function readAttendanceSheet(env, outletId, year) {
  const errors = []
  for (const spreadsheetId of attendanceSpreadsheetIds(env, year)) {
    try {
      const response = await googleFetch(env, valuesUrl(spreadsheetId))
      const payload = await response.json()
      const rows = attendanceRows(Array.isArray(payload.values) ? payload.values : [], outletId)
      if (rows.length) return { rows, spreadsheetId }
    } catch (error) {
      errors.push(error)
      console.error('Attendance spreadsheet candidate failed', spreadsheetId, error)
    }
  }
  if (errors.length) throw errors[errors.length - 1]
  return { rows: [], spreadsheetId: '' }
}

async function persistAttendance(env, outletId, rows) {
  const timestamp = now()
  const statements = []
  for (const row of rows || []) {
    const id = rowId(row)
    if (!id) continue
    const createdAt = String(row.created_date || timestamp)
    const updatedAt = String(row.updated_date || createdAt || timestamp)
    const createdBy = String(row.created_by || 'legacy-sheet')
    const updatedBy = String(row.updated_by || createdBy)
    const version = Math.max(1, Number(row.version || 1) || 1)
    const activeRow = { ...row, deleted_at: '' }

    statements.push(env.OPS_DB.prepare(`
      INSERT INTO ops_records (
        entity, entity_id, outlet_id, business_date, status, payload_json,
        version, created_at, created_by, updated_at, updated_by, deleted_at
      ) VALUES ('Attendance', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '')
      ON CONFLICT(entity, entity_id) DO UPDATE SET
        outlet_id = excluded.outlet_id,
        business_date = excluded.business_date,
        status = excluded.status,
        payload_json = excluded.payload_json,
        version = CASE
          WHEN ops_records.version > excluded.version THEN ops_records.version
          ELSE excluded.version
        END,
        created_at = CASE
          WHEN ops_records.created_at <> '' THEN ops_records.created_at
          ELSE excluded.created_at
        END,
        created_by = CASE
          WHEN ops_records.created_by <> '' THEN ops_records.created_by
          ELSE excluded.created_by
        END,
        updated_at = excluded.updated_at,
        updated_by = excluded.updated_by,
        deleted_at = ''
    `).bind(
      id,
      outletId,
      String(row.date || '').slice(0, 10),
      String(row.status || ''),
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

function mergeRows(primary, fallback) {
  const byId = new Map()
  for (const row of fallback || []) {
    const id = rowId(row)
    if (id) byId.set(id, { ...row, deleted_at: '' })
  }
  for (const row of primary || []) {
    const id = rowId(row)
    if (id && !String(row.deleted_at || row.__realtime?.deleted_at || '').trim()) byId.set(id, row)
  }
  return [...byId.values()]
}

export async function handleRealtimeAttendanceRead(request, env, url) {
  if (url.pathname !== '/api/realtime/records' || request.method !== 'GET') return null
  if (String(url.searchParams.get('entity') || '') !== 'Attendance') return null

  try {
    if (!env.OPS_DB?.prepare || !env.OPS_DB?.batch) {
      const error = new Error('Realtime D1 database is not configured')
      error.status = 503
      error.code = 'realtime_database_unavailable'
      throw error
    }

    const user = await getCurrentUser(request, env)
    assertReadPermission(user, 'Attendance')
    const outletId = String(url.searchParams.get('outlet_id') || user.outlet_id || '').trim()
    if (!outletId) {
      const error = new Error('Outlet is required for duty roster records')
      error.status = 400
      error.code = 'realtime_outlet_required'
      throw error
    }
    assertOutletAccess(user, outletId)

    const filter = parseJson(url.searchParams.get('filter'), {}) || {}
    const sort = url.searchParams.get('sort') || ''
    const limit = Math.max(1, Math.min(Number(url.searchParams.get('limit') || 100), MAX_ROWS))
    const year = Number(url.searchParams.get('year') || String(filter.date?.$gte || filter.date || '').slice(0, 4) || new Date().getUTCFullYear())

    let allRows = await d1Attendance(env, outletId)
    let visible = sortRows(filterRows(allRows, filter, false), sort).slice(0, limit)
    let source = visible.length ? 'd1' : 'd1-empty'
    let legacyErrorCode = ''
    let seeded = 0
    let spreadsheetId = ''

    if (!visible.length && url.searchParams.get('legacy_seed') !== '0') {
      try {
        const sheet = await readAttendanceSheet(env, outletId, year)
        spreadsheetId = sheet.spreadsheetId
        seeded = await persistAttendance(env, outletId, sheet.rows)
        allRows = mergeRows(await d1Attendance(env, outletId), sheet.rows)
        visible = sortRows(filterRows(allRows, filter, false), sort).slice(0, limit)
        source = visible.length ? 'attendance-canonical-sheet-d1' : 'd1-empty'
      } catch (error) {
        legacyErrorCode = String(error?.code || 'attendance_hydration_unavailable')
        console.error('Direct Attendance hydration unavailable', outletId, year, error)
      }
    }

    return json(request, env, {
      records: visible,
      count: visible.length,
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