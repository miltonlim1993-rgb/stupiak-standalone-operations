import { getSchema } from './schema.js'

function parseJson(value, fallback = null) {
  try { return JSON.parse(String(value || '')) } catch { return fallback }
}

function database(env) {
  if (!env.OPS_DB?.prepare) {
    const error = new Error('OPS D1 database is not configured')
    error.status = 503
    error.code = 'ops_database_unavailable'
    throw error
  }
  return env.OPS_DB
}

function firstAssignedOutlet(record = {}) {
  const direct = String(record.outlet_id || '').trim()
  if (direct) return direct
  const raw = String(record.outlet_ids || '').trim()
  if (!raw) return ''
  if (raw.startsWith('[')) {
    try {
      const values = JSON.parse(raw)
      if (Array.isArray(values)) return String(values[0] || '').trim()
    } catch {}
  }
  return String(raw.split(',')[0] || '').replace(/[\[\]"]/g, '').trim()
}

function partitionFor(entity, entityId, record) {
  if (entity === 'Outlet') return String(entityId || record.id || 'global')
  return firstAssignedOutlet(record) || 'global'
}

function normalizeRecord(entity, raw, entityId, actorEmail) {
  const schema = getSchema(entity)
  const allowed = new Set(schema.headers)
  const timestamp = new Date().toISOString()
  const record = Object.fromEntries(
    Object.entries(raw || {}).filter(([key]) => allowed.has(key)),
  )
  const idField = schema.idField || 'id'
  record[idField] = entityId
  if (allowed.has('id')) record.id = entityId
  if (allowed.has('created_date') && !record.created_date) record.created_date = timestamp
  if (allowed.has('created_at') && !record.created_at) record.created_at = timestamp
  if (allowed.has('created_by') && !record.created_by) record.created_by = actorEmail
  if (allowed.has('updated_date') && !record.updated_date) record.updated_date = record.created_date || timestamp
  if (allowed.has('updated_at') && !record.updated_at) record.updated_at = record.created_at || timestamp
  if (allowed.has('updated_by') && !record.updated_by) record.updated_by = record.created_by || actorEmail
  if (allowed.has('deleted_at') && record.deleted_at == null) record.deleted_at = ''
  if (allowed.has('version')) record.version = Math.max(1, Number(record.version || 1))
  return record
}

async function cacheImportedUser(env, user) {
  if (!env.APP_DATA_PACKS?.put || !user) return
  const payload = JSON.stringify({ user, cachedAt: Date.now() })
  const writes = []
  if (user.google_sub) {
    writes.push(env.APP_DATA_PACKS.put(
      `auth:user:sub:${String(user.google_sub).trim()}`,
      payload,
      { expirationTtl: 7 * 24 * 60 * 60 },
    ))
  }
  if (user.email) {
    writes.push(env.APP_DATA_PACKS.put(
      `auth:user:email:${String(user.email).trim().toLowerCase()}`,
      payload,
      { expirationTtl: 7 * 24 * 60 * 60 },
    ))
  }
  await Promise.all(writes)
}

export async function directoryCounts(env) {
  const row = await database(env).prepare(`
    SELECT
      SUM(CASE WHEN entity = 'User' AND deleted_at = '' THEN 1 ELSE 0 END) AS users,
      SUM(CASE WHEN entity = 'Outlet' AND deleted_at = '' THEN 1 ELSE 0 END) AS outlets,
      SUM(CASE WHEN entity = 'User' AND deleted_at = ''
        AND lower(json_extract(payload_json, '$.status')) = 'active'
        THEN 1 ELSE 0 END) AS active_users
    FROM ops_records
    WHERE entity IN ('User', 'Outlet')
  `).first()
  return {
    users: Number(row?.users || 0),
    outlets: Number(row?.outlets || 0),
    active_users: Number(row?.active_users || 0),
  }
}

export async function importDirectorySnapshot(env, entityValue, rows = [], {
  actorEmail = 'directory-migration@chefops.local',
} = {}) {
  const entity = String(entityValue || '').trim()
  if (!['User', 'Outlet'].includes(entity)) {
    const error = new Error(`Unsupported directory entity: ${entity || 'missing'}`)
    error.status = 400
    error.code = 'directory_entity_invalid'
    throw error
  }

  const db = database(env)
  const schema = getSchema(entity)
  const idField = schema.idField || 'id'
  const normalized = []
  const seenIds = new Set()

  for (const raw of rows || []) {
    const entityId = String(raw?.[idField] || raw?.id || '').trim()
    if (!entityId || seenIds.has(entityId)) continue
    seenIds.add(entityId)
    const record = normalizeRecord(entity, raw, entityId, actorEmail)
    const createdAt = String(record.created_at || record.created_date || new Date().toISOString())
    const updatedAt = String(record.updated_at || record.updated_date || createdAt)
    const createdBy = String(record.created_by || actorEmail)
    const updatedBy = String(record.updated_by || createdBy)
    const deletedAt = String(record.deleted_at || '')
    const version = Math.max(1, Number(record.version || 1))
    normalized.push({
      entityId,
      record,
      partition: partitionFor(entity, entityId, record),
      createdAt,
      updatedAt,
      createdBy,
      updatedBy,
      deletedAt,
      version,
    })
  }

  for (let index = 0; index < normalized.length; index += 50) {
    const chunk = normalized.slice(index, index + 50)
    const statements = chunk.map((item) => db.prepare(`
      INSERT INTO ops_records (
        entity, entity_id, outlet_id, business_date, status, payload_json,
        version, created_at, created_by, updated_at, updated_by, deleted_at
      ) VALUES (?, ?, ?, '', ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(entity, entity_id) DO UPDATE SET
        outlet_id = excluded.outlet_id,
        status = excluded.status,
        payload_json = excluded.payload_json,
        version = excluded.version,
        updated_at = excluded.updated_at,
        updated_by = excluded.updated_by,
        deleted_at = excluded.deleted_at
    `).bind(
      entity,
      item.entityId,
      item.partition,
      String(item.record.status || ''),
      JSON.stringify(item.record),
      item.version,
      item.createdAt,
      item.createdBy,
      item.updatedAt,
      item.updatedBy,
      item.deletedAt,
    ))
    if (statements.length) await db.batch(statements)
  }

  if (entity === 'User') {
    for (const item of normalized) {
      if (!item.deletedAt) await cacheImportedUser(env, item.record)
    }
  }

  return {
    entity,
    imported: normalized.length,
    active: entity === 'User'
      ? normalized.filter(({ record, deletedAt }) => !deletedAt && String(record.status || '').toLowerCase() === 'active').length
      : normalized.filter(({ deletedAt }) => !deletedAt).length,
  }
}

export function decodeDirectoryRecord(row) {
  if (!row) return null
  return parseJson(row.payload_json, {}) || {}
}
