import { getCurrentUser } from './auth.js'
import { googleFetch } from './google.js'
import { errorResponse, json } from './http.js'
import { assertOutletAccess, assertReadPermission } from './permissions.js'
import { spreadsheetIdForEntity } from './storage.js'

const MAX_ROWS = 5000

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
  const range = encodeURIComponent("'Attendance'!A:Q")
  return `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${range}?majorDimension=ROWS`
}

async function readAttendanceSheet(env, outletId, year) {
  const target = spreadsheetIdForEntity(env, 'Attendance', { year })
  const response = await googleFetch(env, valuesUrl(target.spreadsheetId))
  const payload = await response.json()
  const values = Array.isArray(payload.values) ? payload.values : []
  const headers = (values[0] || []).map((value) => String(value || '').trim())
  if (!headers.includes('id') || !headers.includes('outlet_id') || !headers.includes('date')) return []

  return values.slice(1).flatMap((cells) => {
    const row = Object.fromEntries(headers.map((header, index) => [header, cells[index] ?? '']))
    if (!rowId(row) || String(row.outlet_id || '') !== outletId) return []
    return [row]
  })
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
    const deletedAt = String(row.deleted_at || '')
    const version = Math.max(1, Number(row.version || 1) || 1)

    statements.push(env.OPS_DB.prepare(`
      INSERT INTO ops_records (
        entity, entity_id, outlet_id, business_date, status, payload_json,
        version, created_at, created_by, updated_at, updated_by, deleted_at
      ) VALUES ('Attendance', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(entity, entity_id) DO NOTHING
    `).bind(
      id,
      outletId,
      String(row.date || '').slice(0, 10),
      String(row.status || ''),
      JSON.stringify(row),
      version,
      createdAt,
      createdBy,
      updatedAt,
      updatedBy,
      deletedAt,
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
    if (id) byId.set(id, row)
  }
  for (const row of primary || []) {
    const id = rowId(row)
    if (id) byId.set(id, row)
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
    const includeDeleted = url.searchParams.get('include_deleted') === '1'
    const limit = Math.max(1, Math.min(Number(url.searchParams.get('limit') || 100), MAX_ROWS))
    const year = Number(url.searchParams.get('year') || String(filter.date?.$gte || filter.date || '').slice(0, 4) || new Date().getUTCFullYear())

    let allRows = await d1Attendance(env, outletId)
    let visible = sortRows(filterRows(allRows, filter, includeDeleted), sort).slice(0, limit)
    let source = visible.length ? 'd1' : 'd1-empty'
    let legacyErrorCode = ''
    let seeded = 0

    if (!visible.length && url.searchParams.get('legacy_seed') !== '0') {
      try {
        const sheetRows = await readAttendanceSheet(env, outletId, year)
        seeded = await persistAttendance(env, outletId, sheetRows)
        allRows = mergeRows(await d1Attendance(env, outletId), sheetRows)
        visible = sortRows(filterRows(allRows, filter, includeDeleted), sort).slice(0, limit)
        source = visible.length ? 'attendance-sheet-seeded-d1' : 'd1-empty'
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
      legacy_error_code: legacyErrorCode,
      server_time: now(),
    })
  } catch (error) {
    return errorResponse(request, env, error)
  }
}