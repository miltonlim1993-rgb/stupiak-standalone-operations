import { getCurrentUser } from './auth.js'
import { errorResponse, json, readJson } from './http.js'
import {
  assertCreatePermission,
  assertDeletePermission,
  assertReadPermission,
  assertUpdatePermission,
} from './permissions.js'
import {
  findDirectoryRecord,
  listDirectoryRecords,
  saveDirectoryRecord,
} from './d1-directory-store.js'

const DIRECTORY_ENTITIES = new Set(['User', 'Outlet'])

function parseJson(value, fallback = {}) {
  try { return JSON.parse(String(value || '')) } catch { return fallback }
}

function comparable(value) {
  if (value === null || value === undefined) return ''
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  return String(value)
}

function orderedComparison(left, right) {
  const a = Number(left)
  const b = Number(right)
  if (comparable(left) !== '' && comparable(right) !== '' && Number.isFinite(a) && Number.isFinite(b)) return a - b
  return comparable(left).localeCompare(comparable(right), undefined, { numeric: true, sensitivity: 'base' })
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

function visibleRows(rows, filter = {}) {
  return (rows || []).filter((row) => (
    !String(row?.deleted_at || row?.__realtime?.deleted_at || '').trim()
    && Object.entries(filter || {}).every(([key, expected]) => matchesExpected(row?.[key], expected))
  ))
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

function entityRoute(pathname) {
  const match = pathname.match(/^\/api\/entities\/(User|Outlet)(?:\/([^/]+))?$/)
  if (!match) return null
  return {
    entity: match[1],
    id: match[2] ? decodeURIComponent(match[2]) : '',
  }
}

async function listEntity(request, env, url, entity) {
  const user = await getCurrentUser(request, env)
  assertReadPermission(user, entity)
  const filter = parseJson(url.searchParams.get('filter'), {}) || {}
  const sort = url.searchParams.get('sort') || ''
  const limit = Math.max(1, Math.min(Number(url.searchParams.get('limit') || 100), 5000))
  const rows = await listDirectoryRecords(env, entity, { includeDeleted: false, limit: 5000 })
  return json(request, env, sortRows(visibleRows(rows, filter), sort).slice(0, limit))
}

async function createEntity(request, env, entity) {
  const user = await getCurrentUser(request, env)
  assertCreatePermission(user, entity)
  const payload = await readJson(request)
  const id = String(payload.id || crypto.randomUUID())
  const record = await saveDirectoryRecord(env, entity, id, payload, {
    actorEmail: user.email,
    operation: 'create',
  })
  return json(request, env, record, 201)
}

async function updateEntity(request, env, entity, id) {
  const user = await getCurrentUser(request, env)
  const existing = await findDirectoryRecord(env, entity, id)
  if (!existing) {
    const error = new Error(`${entity} record not found in D1`)
    error.status = 404
    error.code = 'directory_record_not_found'
    throw error
  }
  const patch = await readJson(request)
  assertUpdatePermission(user, entity, existing, patch)
  const record = await saveDirectoryRecord(env, entity, id, { ...existing, ...patch, __realtime: undefined }, {
    actorEmail: user.email,
    operation: 'update',
  })
  return json(request, env, record)
}

async function deleteEntity(request, env, entity, id) {
  const user = await getCurrentUser(request, env)
  const existing = await findDirectoryRecord(env, entity, id)
  if (!existing) {
    const error = new Error(`${entity} record not found in D1`)
    error.status = 404
    error.code = 'directory_record_not_found'
    throw error
  }
  assertDeletePermission(user, entity, existing)
  const record = await saveDirectoryRecord(env, entity, id, { ...existing, __realtime: undefined }, {
    actorEmail: user.email,
    operation: 'delete',
  })
  return json(request, env, record)
}

async function updateUserAccess(request, env, userId) {
  const actor = await getCurrentUser(request, env)
  const existing = await findDirectoryRecord(env, 'User', userId)
  if (!existing) {
    const error = new Error('User record not found in D1')
    error.status = 404
    error.code = 'directory_user_not_found'
    throw error
  }
  const body = await readJson(request)
  const assigned = Array.isArray(body.assigned_outlet_ids)
    ? body.assigned_outlet_ids.map(String).map((value) => value.trim()).filter(Boolean)
    : []
  const patch = {
    role: String(body.role || existing.role || 'staff'),
    status: String(body.status || existing.status || 'pending'),
    outlet_id: String(body.primary_outlet_id || assigned[0] || existing.outlet_id || ''),
    outlet_ids: JSON.stringify(assigned.length ? assigned : [body.primary_outlet_id || existing.outlet_id].filter(Boolean)),
  }
  assertUpdatePermission(actor, 'User', existing, patch)
  const record = await saveDirectoryRecord(env, 'User', userId, { ...existing, ...patch, __realtime: undefined }, {
    actorEmail: actor.email,
    operation: 'update',
  })
  return json(request, env, { ok: true, user: record })
}

export async function handleD1DirectoryApi(request, env, url) {
  const route = entityRoute(url.pathname)
  const accessMatch = url.pathname.match(/^\/api\/users\/([^/]+)\/access$/)
  if (!route && !accessMatch) return null

  try {
    if (accessMatch && request.method === 'POST') {
      return await updateUserAccess(request, env, decodeURIComponent(accessMatch[1]))
    }
    if (!route || !DIRECTORY_ENTITIES.has(route.entity)) return null
    if (!route.id && request.method === 'GET') return await listEntity(request, env, url, route.entity)
    if (!route.id && request.method === 'POST') return await createEntity(request, env, route.entity)
    if (route.id && request.method === 'PATCH') return await updateEntity(request, env, route.entity, route.id)
    if (route.id && request.method === 'DELETE') return await deleteEntity(request, env, route.entity, route.id)

    const error = new Error('Method not allowed')
    error.status = 405
    error.code = 'method_not_allowed'
    throw error
  } catch (error) {
    return errorResponse(request, env, error)
  }
}
