const IDEMPOTENCY_TTL_MS = 7 * 24 * 60 * 60 * 1000

function now() {
  return new Date().toISOString()
}

function requireDb(env) {
  if (!env.OPS_DB?.prepare) {
    const error = new Error('OPS live database is not configured')
    error.status = 503
    error.code = 'live_database_unavailable'
    throw error
  }
  return env.OPS_DB
}

function parseJson(value, fallback = null) {
  try { return JSON.parse(String(value || '')) } catch { return fallback }
}

function recordId(record = {}) {
  return String(record.id || record.record_id || record.task_id || record.issue_id || '').trim()
}

function recordOutlet(record = {}) {
  return String(record.outlet_id || record.outletId || '').trim()
}

function recordStatus(record = {}) {
  return String(record.status || record.sync_status || '').trim()
}

export function liveStoreConfigured(env) {
  return Boolean(env.OPS_DB?.prepare)
}

export async function getIdempotentMutation(env, mutationId) {
  if (!mutationId || !liveStoreConfigured(env)) return null
  const row = await env.OPS_DB.prepare(
    `SELECT response_json, expires_at
       FROM mutation_idempotency
      WHERE mutation_id = ?1
      LIMIT 1`,
  ).bind(String(mutationId)).first()
  if (!row) return null
  if (Date.parse(row.expires_at || '') <= Date.now()) {
    await env.OPS_DB.prepare('DELETE FROM mutation_idempotency WHERE mutation_id = ?1')
      .bind(String(mutationId)).run()
    return null
  }
  return parseJson(row.response_json)
}

export async function commitLiveMutation(env, {
  mutationId,
  entity,
  operation,
  record,
  response = null,
  source = 'api',
} = {}) {
  const db = requireDb(env)
  const id = recordId(record)
  const entityName = String(entity || '').trim()
  const mutation = String(mutationId || crypto.randomUUID()).trim()
  if (!entityName || !id) {
    const error = new Error('Live mutation requires entity and record id')
    error.status = 400
    error.code = 'invalid_live_mutation'
    throw error
  }

  const timestamp = now()
  const deletedAt = operation === 'delete'
    ? (String(record.deleted_at || '').trim() || timestamp)
    : String(record.deleted_at || '').trim()
  const nextRecord = {
    ...record,
    id,
    deleted_at: deletedAt,
    updated_date: record.updated_date || timestamp,
  }
  const version = Math.max(1, Number(nextRecord.version || 1))
  const payloadJson = JSON.stringify(nextRecord)
  const responseJson = JSON.stringify(response ?? nextRecord)
  const expiresAt = new Date(Date.now() + IDEMPOTENCY_TTL_MS).toISOString()

  await db.batch([
    db.prepare(
      `INSERT INTO workspace_records (
         entity, record_id, outlet_id, version, status, data_json,
         created_at, updated_at, deleted_at, source
       ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
       ON CONFLICT(entity, record_id) DO UPDATE SET
         outlet_id = excluded.outlet_id,
         version = excluded.version,
         status = excluded.status,
         data_json = excluded.data_json,
         updated_at = excluded.updated_at,
         deleted_at = excluded.deleted_at,
         source = excluded.source`,
    ).bind(
      entityName,
      id,
      recordOutlet(nextRecord),
      version,
      recordStatus(nextRecord),
      payloadJson,
      String(nextRecord.created_date || nextRecord.created_at || timestamp),
      timestamp,
      deletedAt,
      String(source || 'api'),
    ),
    db.prepare(
      `INSERT INTO mutation_idempotency (
         mutation_id, entity, record_id, operation, response_json, created_at, expires_at
       ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
       ON CONFLICT(mutation_id) DO NOTHING`,
    ).bind(mutation, entityName, id, String(operation || 'upsert'), responseJson, timestamp, expiresAt),
    db.prepare(
      `INSERT INTO sheet_sync_outbox (
         mutation_id, entity, record_id, outlet_id, operation, payload_json,
         status, attempts, next_attempt_at, created_at, updated_at
       ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'pending', 0, ?7, ?7, ?7)
       ON CONFLICT(mutation_id) DO NOTHING`,
    ).bind(
      mutation,
      entityName,
      id,
      recordOutlet(nextRecord),
      String(operation || 'upsert'),
      payloadJson,
      timestamp,
    ),
  ])

  if (env.SHEET_SYNC_QUEUE?.send) {
    await env.SHEET_SYNC_QUEUE.send({
      mutation_id: mutation,
      entity: entityName,
      record_id: id,
      outlet_id: recordOutlet(nextRecord),
      operation: String(operation || 'upsert'),
    }).catch((error) => console.error('Unable to enqueue Sheet sync mutation', mutation, error))
  }

  return { mutation_id: mutation, record: nextRecord, response: response ?? nextRecord }
}

export async function findLiveRecord(env, entity, id, { includeDeleted = false } = {}) {
  if (!liveStoreConfigured(env)) return null
  const row = await env.OPS_DB.prepare(
    `SELECT data_json, deleted_at
       FROM workspace_records
      WHERE entity = ?1 AND record_id = ?2
      LIMIT 1`,
  ).bind(String(entity), String(id)).first()
  if (!row || (!includeDeleted && row.deleted_at)) return null
  return parseJson(row.data_json)
}

export async function listLiveRecords(env, entity, {
  outletId = '',
  includeDeleted = false,
  limit = 500,
  after = '',
} = {}) {
  if (!liveStoreConfigured(env)) return null
  const clauses = ['entity = ?1']
  const values = [String(entity)]
  if (outletId) {
    clauses.push(`outlet_id = ?${values.length + 1}`)
    values.push(String(outletId))
  }
  if (!includeDeleted) clauses.push(`deleted_at = ''`)
  if (after) {
    clauses.push(`updated_at > ?${values.length + 1}`)
    values.push(String(after))
  }
  values.push(Math.min(5000, Math.max(1, Number(limit || 500))))
  const result = await env.OPS_DB.prepare(
    `SELECT data_json
       FROM workspace_records
      WHERE ${clauses.join(' AND ')}
      ORDER BY updated_at DESC
      LIMIT ?${values.length}`,
  ).bind(...values).all()
  return (result.results || []).map((row) => parseJson(row.data_json)).filter(Boolean)
}

export async function pendingSheetSyncRows(env, limit = 50) {
  if (!liveStoreConfigured(env)) return []
  const result = await env.OPS_DB.prepare(
    `SELECT *
       FROM sheet_sync_outbox
      WHERE status IN ('pending', 'retry')
        AND next_attempt_at <= ?1
      ORDER BY id ASC
      LIMIT ?2`,
  ).bind(now(), Math.min(200, Math.max(1, Number(limit || 50)))).all()
  return result.results || []
}

export async function markSheetSyncResult(env, id, { ok, error = '' } = {}) {
  if (!liveStoreConfigured(env)) return
  const timestamp = now()
  if (ok) {
    await env.OPS_DB.prepare(
      `UPDATE sheet_sync_outbox
          SET status = 'synced', synced_at = ?1, updated_at = ?1, last_error = ''
        WHERE id = ?2`,
    ).bind(timestamp, Number(id)).run()
    return
  }
  const current = await env.OPS_DB.prepare(
    'SELECT attempts FROM sheet_sync_outbox WHERE id = ?1 LIMIT 1',
  ).bind(Number(id)).first()
  const attempts = Number(current?.attempts || 0) + 1
  const delaySeconds = Math.min(3600, Math.max(5, 2 ** Math.min(attempts, 10)))
  const nextAttempt = new Date(Date.now() + delaySeconds * 1000).toISOString()
  await env.OPS_DB.prepare(
    `UPDATE sheet_sync_outbox
        SET status = 'retry', attempts = ?1, next_attempt_at = ?2,
            last_error = ?3, updated_at = ?4
      WHERE id = ?5`,
  ).bind(attempts, nextAttempt, String(error || '').slice(0, 2000), timestamp, Number(id)).run()
}
