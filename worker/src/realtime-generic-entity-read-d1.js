import { getCurrentUser } from './auth.js'
import { errorResponse, json } from './http.js'
import { assertReadPermission, scopeFilter } from './permissions.js'
import { getSchema } from './schema.js'

const D1_GENERIC_READ_ENTITIES = new Set([
  'Task',
  'TaskPhoto',
  'UrgentIssue',
  'StockCount',
  'CloseUp',
  'FoodLabel',
  'Attendance',
  'Receipt',
  'TrainingAssignment',
  'TrainingProgress',
  'TrainingAcknowledgement',
  'TrainingAttempt',
  'AuditLog',
])

function parseJson(value, fallback = null) {
  try { return JSON.parse(String(value || '')) } catch { return fallback }
}

function comparable(value) {
  if (value === null || value === undefined) return ''
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  return String(value)
}

function orderedComparison(left, right) {
  const leftNumber = Number(left)
  const rightNumber = Number(right)
  if (
    comparable(left) !== ''
    && comparable(right) !== ''
    && Number.isFinite(leftNumber)
    && Number.isFinite(rightNumber)
  ) return leftNumber - rightNumber
  return comparable(left).localeCompare(comparable(right))
}

function matchesFilter(record, filter = {}) {
  return Object.entries(filter || {}).every(([field, expected]) => {
    if (expected === undefined) return true
    const actual = record?.[field]
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
      if (Object.prototype.hasOwnProperty.call(expected, '$contains')) {
        return comparable(actual).toLowerCase().includes(comparable(expected.$contains).toLowerCase())
      }
      return true
    }
    return comparable(actual) === comparable(expected)
  })
}

function sortedRows(rows, sort = '') {
  const fields = String(sort || '').split(',').map((value) => value.trim()).filter(Boolean)
  if (!fields.length) return rows
  return [...rows].sort((left, right) => {
    for (const fieldSpec of fields) {
      const descending = fieldSpec.startsWith('-')
      const field = descending ? fieldSpec.slice(1) : fieldSpec
      const comparison = orderedComparison(left?.[field], right?.[field])
      if (comparison === 0) continue
      return descending ? -comparison : comparison
    }
    return 0
  })
}

function recordFromRow(row) {
  const payload = parseJson(row?.payload_json, {}) || {}
  return {
    ...payload,
    __realtime: {
      entity: row.entity,
      entity_id: row.entity_id,
      outlet_id: row.outlet_id,
      version: Number(row.version || 0),
      updated_at: row.updated_at || '',
      deleted_at: row.deleted_at || '',
    },
  }
}

function auditRecordFromMutation(row) {
  const committedAt = String(row?.committed_at || row?.requested_at || '')
  return {
    id: String(row?.mutation_id || ''),
    outlet_id: String(row?.outlet_id || ''),
    created_date: committedAt,
    created_by: String(row?.actor_email || ''),
    updated_date: committedAt,
    updated_by: String(row?.actor_email || ''),
    deleted_at: '',
    version: 1,
    actor_sub: '',
    actor_email: String(row?.actor_email || ''),
    actor_name: String(row?.actor_name || row?.actor_email || ''),
    action: String(row?.operation || ''),
    entity: String(row?.entity || ''),
    entity_id: String(row?.entity_id || ''),
    summary: `${String(row?.operation || 'mutation')} ${String(row?.entity || '')}`.trim(),
    payload_json: String(row?.result_json || '{}'),
    __realtime: {
      entity: 'AuditLog',
      entity_id: String(row?.mutation_id || ''),
      outlet_id: String(row?.outlet_id || ''),
      version: 1,
      updated_at: committedAt,
      deleted_at: '',
      source: 'ops_mutations',
    },
  }
}

function requestedEntity(pathname) {
  const match = pathname.match(/^\/api\/entities\/([^/]+)$/)
  if (!match) return ''
  const entity = decodeURIComponent(match[1])
  return D1_GENERIC_READ_ENTITIES.has(entity) ? entity : ''
}

function requestedLimit(url) {
  return Math.max(1, Math.min(Number(url.searchParams.get('limit') || 100), 5000))
}

async function loadAuditRows(env, scopedFilter) {
  const clauses = ['1 = 1']
  const bindings = []
  const outlet = scopedFilter?.outlet_id
  if (typeof outlet === 'string' && outlet) {
    clauses.push('outlet_id = ?')
    bindings.push(outlet)
  } else if (outlet && typeof outlet === 'object' && Array.isArray(outlet.$in) && outlet.$in.length) {
    const values = outlet.$in.map(String).filter(Boolean).slice(0, 100)
    if (values.length) {
      clauses.push(`outlet_id IN (${values.map(() => '?').join(',')})`)
      bindings.push(...values)
    }
  }

  const response = await env.OPS_DB.prepare(`
    SELECT mutation_id, outlet_id, entity, entity_id, operation,
           actor_email, actor_name, requested_at, committed_at, result_json
    FROM ops_mutations
    WHERE ${clauses.join(' AND ')}
    ORDER BY committed_at DESC
    LIMIT 5000
  `).bind(...bindings).all()
  return (response.results || []).map(auditRecordFromMutation)
}

async function loadRows(env, entity, scopedFilter) {
  if (!env.OPS_DB?.prepare) {
    const error = new Error('Canonical D1 database is unavailable')
    error.status = 503
    error.code = 'realtime_database_unavailable'
    throw error
  }

  if (entity === 'AuditLog') return loadAuditRows(env, scopedFilter)

  const clauses = ["entity = ?", "deleted_at = ''"]
  const bindings = [entity]
  const outlet = scopedFilter?.outlet_id
  if (typeof outlet === 'string' && outlet) {
    clauses.push('outlet_id = ?')
    bindings.push(outlet)
  } else if (outlet && typeof outlet === 'object' && Array.isArray(outlet.$in) && outlet.$in.length) {
    const values = outlet.$in.map(String).filter(Boolean).slice(0, 100)
    if (values.length) {
      clauses.push(`outlet_id IN (${values.map(() => '?').join(',')})`)
      bindings.push(...values)
    }
  }

  const response = await env.OPS_DB.prepare(`
    SELECT entity, entity_id, outlet_id, business_date, status, payload_json,
           version, created_at, updated_at, deleted_at
    FROM ops_records
    WHERE ${clauses.join(' AND ')}
    ORDER BY updated_at DESC
    LIMIT 5000
  `).bind(...bindings).all()
  return (response.results || []).map(recordFromRow)
}

export async function handleD1GenericRealtimeEntityRead(request, env, url) {
  if (request.method !== 'GET') return null
  const entity = requestedEntity(url.pathname)
  if (!entity) return null

  try {
    const user = await getCurrentUser(request, env)
    assertReadPermission(user, entity)
    getSchema(entity)

    const requestedFilter = parseJson(url.searchParams.get('filter'), {}) || {}
    const filter = scopeFilter(user, entity, requestedFilter)
    const year = String(url.searchParams.get('year') || '').trim()
    const schema = getSchema(entity)
    const partitionField = String(schema.partitionField || '')
    const limit = requestedLimit(url)
    const sort = String(url.searchParams.get('sort') || '')

    let rows = await loadRows(env, entity, filter)
    rows = rows.filter((row) => matchesFilter(row, filter))
    if (year && partitionField) {
      rows = rows.filter((row) => String(row?.[partitionField] || '').slice(0, 4) === year)
    }
    rows = sortedRows(rows, sort).slice(0, limit)

    const response = json(request, env, rows)
    const headers = new Headers(response.headers)
    headers.set('X-ChefOps-Entity-Read-Path', entity === 'AuditLog' ? 'd1-mutation-journal-v1' : 'd1-only-v1')
    headers.set('Cache-Control', 'no-store')
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    })
  } catch (error) {
    return errorResponse(request, env, error)
  }
}

export const D1_GENERIC_REALTIME_READ_ENTITIES = Object.freeze([...D1_GENERIC_READ_ENTITIES])
