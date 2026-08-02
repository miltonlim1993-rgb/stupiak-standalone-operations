import { getSchema } from './schema.js'

const DIRECTORY_ENTITIES = new Set(['User', 'Outlet'])
const USER_CACHE_TTL_SECONDS = 7 * 24 * 60 * 60

function now() {
  return new Date().toISOString()
}

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

function requireDirectoryEntity(value) {
  const entity = String(value || '').trim()
  if (!DIRECTORY_ENTITIES.has(entity)) {
    const error = new Error(`Unsupported directory entity: ${entity || 'missing'}`)
    error.status = 400
    error.code = 'directory_entity_invalid'
    throw error
  }
  return entity
}

function recordFromRow(row) {
  if (!row) return null
  return {
    ...(parseJson(row.payload_json, {}) || {}),
    __realtime: {
      entity: row.entity,
      entity_id: row.entity_id,
      outlet_id: row.outlet_id || '',
      version: Number(row.version || 0),
      updated_at: row.updated_at || '',
      deleted_at: row.deleted_at || '',
      sync_status: 'synced',
    },
  }
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

function directoryPartition(entity, entityId, record, existingRow) {
  if (entity === 'Outlet') return String(entityId || record.id || 'global')
  return firstAssignedOutlet(record) || String(existingRow?.outlet_id || '').trim() || 'global'
}

function cleanRecord(entity, payload, existing, entityId, actorEmail, operation) {
  const schema = getSchema(entity)
  const allowed = new Set(schema.headers)
  const clean = Object.fromEntries(Object.entries(payload || {}).filter(([key]) => allowed.has(key)))
  const timestamp = now()
  const record = { ...(existing || {}), ...clean }
  delete record.__realtime
  const idField = schema.idField || 'id'
  record[idField] = entityId
  if (allowed.has('id')) record.id = entityId

  if (!existing) {
    if (allowed.has('created_date') && !record.created_date) record.created_date = timestamp
    if (allowed.has('created_at') && !record.created_at) record.created_at = timestamp
    if (allowed.has('created_by') && !record.created_by) record.created_by = actorEmail
  }
  if (allowed.has('updated_date')) record.updated_date = timestamp
  if (allowed.has('updated_at')) record.updated_at = timestamp
  if (allowed.has('updated_by')) record.updated_by = actorEmail
  if (allowed.has('deleted_at')) record.deleted_at = operation === 'delete' ? timestamp : ''
  if (allowed.has('version')) record.version = Number(existing?.version || 0) + 1
  return record
}

function authKvEntries(user) {
  const payload = JSON.stringify({ user, cachedAt: Date.now() })
  const entries = []
  if (user?.google_sub) entries.push([`auth:user:sub:${String(user.google_sub).trim()}`, payload])
  if (user?.email) entries.push([`auth:user:email:${String(user.email).trim().toLowerCase()}`, payload])
  return entries
}

export async function cacheDirectoryUser(env, user) {
  if (!user || !env.APP_DATA_PACKS?.put) return user
  await Promise.all(authKvEntries(user).map(([key, value]) => (
    env.APP_DATA_PACKS.put(key, value, { expirationTtl: USER_CACHE_TTL_SECONDS })
  ))).catch((error) => console.error('Unable to update D1 directory user cache', error))
  return user
}

export async function findDirectoryRecord(env, entityValue, entityId) {
  const entity = requireDirectoryEntity(entityValue)
  const row = await database(env).prepare(`
    SELECT * FROM ops_records
    WHERE entity = ? AND entity_id = ? AND deleted_at = ''
    LIMIT 1
  `).bind(entity, String(entityId || '').trim()).first()
  return recordFromRow(row)
}

export async function findDirectoryUser(env, { id = '', googleSub = '', email = '' } = {}) {
  const db = database(env)
  if (id) return findDirectoryRecord(env, 'User', id)

  let row = null
  if (googleSub) {
    row = await db.prepare(`
      SELECT * FROM ops_records
      WHERE entity = 'User' AND deleted_at = ''
        AND json_extract(payload_json, '$.google_sub') = ?
      ORDER BY updated_at DESC LIMIT 1
    `).bind(String(googleSub)).first()
  }
  if (!row && email) {
    row = await db.prepare(`
      SELECT * FROM ops_records
      WHERE entity = 'User' AND deleted_at = ''
        AND lower(json_extract(payload_json, '$.email')) = ?
      ORDER BY updated_at DESC LIMIT 1
    `).bind(String(email).trim().toLowerCase()).first()
  }
  return recordFromRow(row)
}

export async function listDirectoryRecords(env, entityValue, { includeDeleted = false, limit = 5000 } = {}) {
  const entity = requireDirectoryEntity(entityValue)
  const deletedClause = includeDeleted ? '' : "AND deleted_at = ''"
  const response = await database(env).prepare(`
    SELECT * FROM ops_records
    WHERE entity = ? ${deletedClause}
    ORDER BY updated_at DESC
    LIMIT ?
  `).bind(entity, Math.max(1, Math.min(Number(limit) || 5000, 5000))).all()
  return (response.results || []).map(recordFromRow)
}

async function queueMirror(env, message) {
  if (!env.SHEET_SYNC_QUEUE?.send) return false
  try {
    await env.SHEET_SYNC_QUEUE.send(message)
    await env.OPS_DB.prepare(`
      UPDATE sheet_sync_outbox
      SET status = 'queued', queued_at = ?, last_error = ''
      WHERE mutation_id = ?
    `).bind(now(), message.mutation_id).run()
    return true
  } catch (error) {
    console.error('Unable to queue D1 directory Sheet mirror', message.mutation_id, error)
    return false
  }
}

export async function saveDirectoryRecord(env, entityValue, entityIdValue, payload, {
  actorEmail = 'system@chefops.local',
  operation = 'upsert',
} = {}) {
  const entity = requireDirectoryEntity(entityValue)
  const entityId = String(entityIdValue || payload?.id || '').trim() || crypto.randomUUID()
  const db = database(env)
  const existingRow = await db.prepare(
    'SELECT * FROM ops_records WHERE entity = ? AND entity_id = ? LIMIT 1',
  ).bind(entity, entityId).first()
  const existing = recordFromRow(existingRow)
  const record = cleanRecord(entity, payload, existing, entityId, actorEmail, operation)
  const timestamp = now()
  const version = Number(existingRow?.version || 0) + 1
  const deletedAt = operation === 'delete' ? timestamp : ''
  const partition = directoryPartition(entity, entityId, record, existingRow)
  const mutationId = `directory:${entity}:${entityId}:${crypto.randomUUID()}`
  const mirrorMessage = {
    mutation_id: mutationId,
    entity,
    entity_id: entityId,
    outlet_id: partition,
    operation,
    record,
    version,
    committed_at: timestamp,
  }

  await db.batch([
    db.prepare(`
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
      entityId,
      partition,
      String(record.status || ''),
      JSON.stringify(record),
      version,
      existingRow?.created_at || timestamp,
      existingRow?.created_by || actorEmail,
      timestamp,
      actorEmail,
      deletedAt,
    ),
    db.prepare(`
      INSERT INTO ops_mutations (
        mutation_id, outlet_id, entity, entity_id, operation, actor_email,
        actor_name, requested_at, committed_at, result_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      mutationId,
      partition,
      entity,
      entityId,
      operation,
      actorEmail,
      actorEmail,
      timestamp,
      timestamp,
      JSON.stringify({ ok: true, entity, entity_id: entityId, version, record }),
    ),
    db.prepare(`
      INSERT INTO sheet_sync_outbox (
        mutation_id, entity, entity_id, outlet_id, operation, payload_json,
        status, attempts, next_attempt_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?)
    `).bind(
      mutationId,
      entity,
      entityId,
      partition,
      operation,
      JSON.stringify(mirrorMessage),
      timestamp,
    ),
  ])

  if (entity === 'User') await cacheDirectoryUser(env, record)
  await queueMirror(env, mirrorMessage)
  return {
    ...record,
    __realtime: {
      entity,
      entity_id: entityId,
      outlet_id: partition,
      version,
      updated_at: timestamp,
      deleted_at: deletedAt,
      sync_status: 'pending',
    },
  }
}
