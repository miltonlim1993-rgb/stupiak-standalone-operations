import { getCurrentUser } from './auth.js'
import { errorResponse, json, readJson } from './http.js'
import {
  assertCreatePermission,
  assertDeletePermission,
  assertOutletAccess,
  assertReadPermission,
  assertUpdatePermission,
} from './permissions.js'
import { getSchema } from './schema.js'
import { syncCloseUpToSalesTemplate } from './closeup-sync.js'
import { appendRecord, ensureEntitySheet, listRecords, updateRecordFlexible } from './sheets.js'

const REALTIME_ENTITIES = new Set([
  'Task',
  'TaskPhoto',
  'UrgentIssue',
  'StockCount',
  'CloseUp',
  'FoodLabel',
  'LabelPrintLog',
  'Attendance',
  'Receipt',
  'Notification',
  'TrainingAssignment',
  'TrainingProgress',
  'TrainingAcknowledgement',
  'TrainingAttempt',
])

const OPERATIONS = new Set(['create', 'upsert', 'update', 'delete'])
const MAX_READ_LIMIT = 5000
const LEGACY_SEED_TIMEOUT_MS = 4500
const LEGACY_SEED_INFLIGHT = new Map()

function now() {
  return new Date().toISOString()
}

function parseJson(value, fallback = null) {
  try { return JSON.parse(String(value || '')) } catch { return fallback }
}

function numberVersion(value, fallback = 0) {
  const version = Number(value)
  return Number.isInteger(version) && version >= 0 ? version : fallback
}

function unavailable(message, code) {
  const error = new Error(message)
  error.status = 503
  error.code = code
  return error
}

function database(env) {
  if (!env.OPS_DB?.prepare) {
    throw unavailable('Realtime D1 database is not configured', 'realtime_database_unavailable')
  }
  return env.OPS_DB
}

function requireEntity(value) {
  const entity = String(value || '').trim()
  if (!REALTIME_ENTITIES.has(entity)) {
    const error = new Error(`Entity is not enabled for realtime storage: ${entity || 'missing'}`)
    error.status = 400
    error.code = 'realtime_entity_not_enabled'
    throw error
  }
  getSchema(entity)
  return entity
}

function requireOutlet(value) {
  const outletId = String(value || '').trim()
  if (!outletId) {
    const error = new Error('Outlet is required for realtime records')
    error.status = 400
    error.code = 'realtime_outlet_required'
    throw error
  }
  return outletId
}

function requireOperation(value) {
  const operation = String(value || 'upsert').trim().toLowerCase()
  if (!OPERATIONS.has(operation)) {
    const error = new Error('Operation must be create, upsert, update or delete')
    error.status = 400
    error.code = 'realtime_operation_invalid'
    throw error
  }
  return operation
}

function eventPrefix(entity) {
  return String(entity).replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase()
}

function businessDate(record = {}) {
  for (const field of [
    'business_date', 'count_date', 'receipt_date', 'prep_date', 'date',
    'due_date', 'completed_date', 'submitted_at', 'created_date', 'updated_date',
  ]) {
    const value = String(record[field] || '').trim()
    if (value) return value.slice(0, 10)
  }
  return ''
}

function yearForRecord(entity, record) {
  const schema = getSchema(entity)
  if (schema.storage !== 'operations') return undefined
  const value = schema.partitionField ? record[schema.partitionField] : ''
  const year = Number(String(value || '').slice(0, 4))
  return Number.isInteger(year) && year >= 2000 ? year : undefined
}

function buildRecord(entity, payload, existingRow, user, outletId, entityId, operation, timestamp) {
  const schema = getSchema(entity)
  const allowed = new Set(schema.headers)
  const existing = existingRow ? (parseJson(existingRow.payload_json, {}) || {}) : {}
  const clean = Object.fromEntries(
    Object.entries(payload || {}).filter(([key]) => allowed.has(key)),
  )
  const record = { ...existing, ...clean }
  const idField = schema.idField || 'id'

  record[idField] = entityId
  if (allowed.has('id')) record.id = entityId
  if (allowed.has('outlet_id')) record.outlet_id = outletId

  if (!existingRow) {
    if (allowed.has('created_date') && !record.created_date) record.created_date = timestamp
    if (allowed.has('created_at') && !record.created_at) record.created_at = timestamp
    if (allowed.has('created_by') && !record.created_by) record.created_by = user.email
  }

  if (allowed.has('updated_date')) record.updated_date = timestamp
  if (allowed.has('updated_at')) record.updated_at = timestamp
  if (allowed.has('updated_by')) record.updated_by = user.email
  if (allowed.has('version')) record.version = numberVersion(existingRow?.version, 0) + 1
  if (allowed.has('deleted_at')) record.deleted_at = operation === 'delete' ? timestamp : ''
  return record
}

async function findMutation(db, mutationId) {
  const row = await db.prepare(
    'SELECT result_json FROM ops_mutations WHERE mutation_id = ? LIMIT 1',
  ).bind(mutationId).first()
  const result = row?.result_json ? parseJson(row.result_json, null) : null
  return result ? { ...result, replayed: true } : null
}

async function findRealtimeRecord(db, entity, entityId) {
  return db.prepare(
    'SELECT * FROM ops_records WHERE entity = ? AND entity_id = ? LIMIT 1',
  ).bind(entity, entityId).first()
}

async function markQueued(env, mutationId) {
  if (!env.OPS_DB?.prepare) return
  await env.OPS_DB.prepare(
    "UPDATE sheet_sync_outbox SET status = 'queued', queued_at = ?, last_error = '' WHERE mutation_id = ?",
  ).bind(now(), mutationId).run()
}

async function enqueueMirror(env, message) {
  if (!env.SHEET_SYNC_QUEUE?.send) return false
  try {
    await env.SHEET_SYNC_QUEUE.send(message)
    await markQueued(env, message.mutation_id)
    return true
  } catch (error) {
    console.error('Unable to enqueue Sheet mirror', message.mutation_id, error)
    return false
  }
}

async function broadcastCanonicalEvent(env, outletId, event) {
  if (!env.OUTLET_REALTIME?.getByName) return
  try {
    const stub = env.OUTLET_REALTIME.getByName(String(outletId || 'global'))
    await stub.fetch('https://chefops-realtime.internal/broadcast', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-ChefOps-Realtime-Internal': '1',
      },
      body: JSON.stringify(event),
    })
  } catch (error) {
    console.error('Unable to broadcast canonical realtime event', event?.mutation_id, error)
  }
}

async function applyMutation(env, user, body) {
  const db = database(env)
  const mutationId = String(body.mutation_id || '').trim()
  if (!mutationId || mutationId.length > 160) {
    const error = new Error('A valid mutation_id is required')
    error.status = 400
    error.code = 'realtime_mutation_id_required'
    throw error
  }

  const replay = await findMutation(db, mutationId)
  if (replay) return replay

  const entity = requireEntity(body.entity)
  const operation = requireOperation(body.operation)
  const outletId = requireOutlet(body.outlet_id || body.payload?.outlet_id || user.outlet_id)
  assertOutletAccess(user, outletId)

  const schema = getSchema(entity)
  const idField = schema.idField || 'id'
  const entityId = String(body.entity_id || body.payload?.[idField] || body.payload?.id || '').trim() || crypto.randomUUID()
  const existing = await findRealtimeRecord(db, entity, entityId)
  const existingRecord = existing ? (parseJson(existing.payload_json, {}) || {}) : null

  if (operation === 'create' && existing && !existing.deleted_at) {
    const error = new Error(`${entity} record already exists`)
    error.status = 409
    error.code = 'realtime_record_exists'
    throw error
  }
  if (['update', 'delete'].includes(operation) && !existing) {
    const error = new Error(`${entity} record is not in D1 yet`)
    error.status = 404
    error.code = 'realtime_record_not_found'
    throw error
  }

  const expectedVersion = body.expected_version == null ? null : numberVersion(body.expected_version, -1)
  if (expectedVersion != null && expectedVersion !== numberVersion(existing?.version, 0)) {
    const error = new Error('This record changed on another device. Refresh and retry.')
    error.status = 409
    error.code = 'realtime_version_conflict'
    error.current_version = numberVersion(existing?.version, 0)
    throw error
  }

  if (operation === 'delete') assertDeletePermission(user, entity, existingRecord || body.payload || {})
  else if (existing) assertUpdatePermission(user, entity, existingRecord, body.payload || {})
  else assertCreatePermission(user, entity)

  const timestamp = now()
  const record = buildRecord(entity, body.payload, existing, user, outletId, entityId, operation, timestamp)
  const version = numberVersion(existing?.version, 0) + 1
  const deletedAt = operation === 'delete' ? timestamp : ''
  const eventAction = operation === 'delete' ? 'deleted' : (existing ? 'updated' : 'created')
  const event = {
    id: crypto.randomUUID(),
    type: `${eventPrefix(entity)}.${eventAction}`,
    mutation_id: mutationId,
    entity,
    entity_id: entityId,
    outlet_id: outletId,
    version,
    record,
    occurred_at: timestamp,
    actor: {
      id: user.id || '',
      email: user.email,
      name: user.full_name || user.email,
      role: user.role,
    },
  }
  const result = {
    ok: true,
    replayed: false,
    mutation_id: mutationId,
    entity,
    entity_id: entityId,
    outlet_id: outletId,
    version,
    record,
    event,
    sync_status: 'pending',
    committed_at: timestamp,
  }
  const mirrorMessage = {
    mutation_id: mutationId,
    entity,
    entity_id: entityId,
    outlet_id: outletId,
    operation,
    record,
    version,
    committed_at: timestamp,
  }

  const statements = [
    db.prepare(`
      INSERT INTO ops_records (
        entity, entity_id, outlet_id, business_date, status, payload_json,
        version, created_at, created_by, updated_at, updated_by, deleted_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(entity, entity_id) DO UPDATE SET
        outlet_id = excluded.outlet_id,
        business_date = excluded.business_date,
        status = excluded.status,
        payload_json = excluded.payload_json,
        version = excluded.version,
        updated_at = excluded.updated_at,
        updated_by = excluded.updated_by,
        deleted_at = excluded.deleted_at
    `).bind(
      entity,
      entityId,
      outletId,
      businessDate(record),
      String(record.status || ''),
      JSON.stringify(record),
      version,
      existing?.created_at || timestamp,
      existing?.created_by || user.email,
      timestamp,
      user.email,
      deletedAt,
    ),
    db.prepare(`
      INSERT INTO ops_mutations (
        mutation_id, outlet_id, entity, entity_id, operation, actor_email,
        actor_name, requested_at, committed_at, result_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      mutationId,
      outletId,
      entity,
      entityId,
      operation,
      user.email,
      user.full_name || user.email,
      String(body.requested_at || timestamp),
      timestamp,
      JSON.stringify(result),
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
      outletId,
      operation,
      JSON.stringify(mirrorMessage),
      timestamp,
    ),
  ]

  try {
    await db.batch(statements)
  } catch (error) {
    const concurrentReplay = await findMutation(db, mutationId)
    if (concurrentReplay) return concurrentReplay
    throw error
  }

  await Promise.all([
    enqueueMirror(env, mirrorMessage),
    broadcastCanonicalEvent(env, outletId, event),
  ])
  return result
}

async function listRecordsFromD1(env, entity, outletId, options = {}) {
  const db = database(env)
  const clauses = ['r.entity = ?', 'r.outlet_id = ?']
  const bindings = [entity, outletId]
  if (options.since) {
    clauses.push('r.updated_at > ?')
    bindings.push(String(options.since))
  }
  if (!options.includeDeleted) clauses.push("r.deleted_at = ''")
  const limit = Math.max(1, Math.min(Number(options.limit) || 100, MAX_READ_LIMIT))
  bindings.push(limit)

  const response = await db.prepare(`
    SELECT r.*,
      COALESCE((SELECT o.status FROM sheet_sync_outbox o
        WHERE o.entity = r.entity AND o.entity_id = r.entity_id
        ORDER BY o.id DESC LIMIT 1), 'synced') AS sync_status,
      COALESCE((SELECT o.attempts FROM sheet_sync_outbox o
        WHERE o.entity = r.entity AND o.entity_id = r.entity_id
        ORDER BY o.id DESC LIMIT 1), 0) AS sync_attempts,
      COALESCE((SELECT o.last_error FROM sheet_sync_outbox o
        WHERE o.entity = r.entity AND o.entity_id = r.entity_id
        ORDER BY o.id DESC LIMIT 1), '') AS last_sync_error
    FROM ops_records r
    WHERE ${clauses.join(' AND ')}
    ORDER BY r.updated_at DESC
    LIMIT ?
  `).bind(...bindings).all()

  return (response.results || []).map((row) => ({
    ...(parseJson(row.payload_json, {}) || {}),
    __realtime: {
      entity: row.entity,
      entity_id: row.entity_id,
      outlet_id: row.outlet_id,
      version: Number(row.version || 0),
      updated_at: row.updated_at,
      deleted_at: row.deleted_at || '',
      sync_status: row.sync_status || 'synced',
      sync_attempts: Number(row.sync_attempts || 0),
      last_sync_error: row.last_sync_error || '',
    },
  }))
}

async function digestText(value) {
  const bytes = new TextEncoder().encode(String(value || ''))
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

function timeoutAfter(ms) {
  return new Promise((_, reject) => {
    const error = new Error('Legacy Sheet hydration timed out')
    error.code = 'legacy_seed_timeout'
    setTimeout(() => reject(error), ms)
  })
}

async function seedMarkerKey(entity, outletId, options) {
  const fingerprint = await digestText(JSON.stringify({
    filter: options.filter || {},
    sort: options.sort || '',
    year: options.year || '',
    limit: options.limit || '',
  }))
  return `realtime:legacy-seed:${entity}:${outletId}:${fingerprint.slice(0, 24)}`
}

async function readSeedMarker(env, key) {
  if (!env.APP_DATA_PACKS?.get) return null
  try { return await env.APP_DATA_PACKS.get(key, 'json') } catch { return null }
}

async function writeSeedMarker(env, key, value, ttl) {
  if (!env.APP_DATA_PACKS?.put) return
  try {
    await env.APP_DATA_PACKS.put(key, JSON.stringify(value), { expirationTtl: Math.max(60, ttl) })
  } catch (error) {
    console.error('Unable to store realtime legacy seed marker', error)
  }
}

async function persistLegacyRows(env, entity, outletId, rows) {
  const db = database(env)
  const schema = getSchema(entity)
  const idField = schema.idField || 'id'
  let seeded = 0
  const statements = []
  const timestamp = now()

  for (const row of rows || []) {
    const entityId = String(row?.[idField] || row?.id || '').trim()
    if (!entityId) continue
    const createdAt = String(row.created_at || row.created_date || timestamp)
    const updatedAt = String(row.updated_at || row.updated_date || createdAt || timestamp)
    const createdBy = String(row.created_by || row.user_email || row.submitted_by_email || 'legacy-sheet')
    const updatedBy = String(row.updated_by || createdBy)
    const deletedAt = String(row.deleted_at || '')
    const version = Math.max(1, numberVersion(row.version, 1))
    const normalized = { ...row }
    if (schema.headers.includes('outlet_id')) normalized.outlet_id = outletId

    statements.push(db.prepare(`
      INSERT INTO ops_records (
        entity, entity_id, outlet_id, business_date, status, payload_json,
        version, created_at, created_by, updated_at, updated_by, deleted_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(entity, entity_id) DO NOTHING
    `).bind(
      entity,
      entityId,
      outletId,
      businessDate(normalized),
      String(normalized.status || ''),
      JSON.stringify(normalized),
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
    if (chunk.length) {
      await db.batch(chunk)
      seeded += chunk.length
    }
  }
  return seeded
}

async function seedLegacyRecords(env, entity, outletId, options = {}) {
  const markerKey = await seedMarkerKey(entity, outletId, options)
  const marker = await readSeedMarker(env, markerKey)
  if (marker?.status === 'empty' || marker?.status === 'failed') {
    return { seeded: 0, skipped: true, error_code: marker.error_code || '' }
  }
  if (LEGACY_SEED_INFLIGHT.has(markerKey)) return LEGACY_SEED_INFLIGHT.get(markerKey)

  const task = (async () => {
    const filter = { ...(options.filter || {}), outlet_id: outletId }
    try {
      const rows = await Promise.race([
        listRecords(env, entity, {
          filter,
          sort: options.sort || '',
          limit: Math.max(1, Math.min(Number(options.limit) || MAX_READ_LIMIT, MAX_READ_LIMIT)),
          year: options.year || undefined,
        }),
        timeoutAfter(LEGACY_SEED_TIMEOUT_MS),
      ])
      const seeded = await persistLegacyRows(env, entity, outletId, rows || [])
      await writeSeedMarker(env, markerKey, {
        status: seeded ? 'seeded' : 'empty',
        seeded,
        checked_at: now(),
      }, seeded ? 86400 : 600)
      return { seeded, skipped: false, error_code: '' }
    } catch (error) {
      const errorCode = String(error?.code || 'legacy_seed_unavailable')
      console.error('Legacy realtime hydration unavailable', entity, outletId, error)
      await writeSeedMarker(env, markerKey, {
        status: 'failed',
        error_code: errorCode,
        checked_at: now(),
      }, 120)
      return { seeded: 0, skipped: false, error_code: errorCode }
    }
  })()

  LEGACY_SEED_INFLIGHT.set(markerKey, task)
  try { return await task } finally { if (LEGACY_SEED_INFLIGHT.get(markerKey) === task) LEGACY_SEED_INFLIGHT.delete(markerKey) }
}

async function mirrorToSheets(env, message) {
  const entity = requireEntity(message.entity)
  const schema = getSchema(entity)
  const record = message.record || {}
  const entityId = String(message.entity_id || record[schema.idField || 'id'] || '').trim()
  const year = yearForRecord(entity, record)
  await ensureEntitySheet(env, entity, { year })

  try {
    await updateRecordFlexible(env, entity, entityId, record, {
      year,
      requiredFields: schema.headers,
    })
  } catch (error) {
    if (error?.code !== 'record_not_found') throw error
    if (message.operation !== 'delete') await appendRecord(env, entity, record, { year })
  }
}

async function applyCloseUpSyncPatch(env, message, patch) {
  if (!env.OPS_DB?.prepare || !patch || typeof patch !== 'object') return
  const row = await env.OPS_DB.prepare(
    "SELECT payload_json FROM ops_records WHERE entity = 'CloseUp' AND entity_id = ? LIMIT 1",
  ).bind(message.entity_id).first()
  if (!row) return
  const current = parseJson(row.payload_json, {}) || {}
  const next = { ...current, ...patch }
  await env.OPS_DB.prepare(`
    UPDATE ops_records
    SET payload_json = ?, status = ?, updated_at = ?
    WHERE entity = 'CloseUp' AND entity_id = ?
  `).bind(
    JSON.stringify(next),
    String(next.status || ''),
    now(),
    message.entity_id,
  ).run()
}

async function setOutboxSuccess(env, mutationId) {
  if (!env.OPS_DB?.prepare) return
  const timestamp = now()
  await env.OPS_DB.prepare(`
    UPDATE sheet_sync_outbox
    SET status = 'synced', attempts = attempts + 1, last_attempt_at = ?,
        synced_at = ?, last_error = ''
    WHERE mutation_id = ?
  `).bind(timestamp, timestamp, mutationId).run()
}

async function setOutboxFailure(env, mutationId, error) {
  if (!env.OPS_DB?.prepare) return
  const timestamp = now()
  const retryAt = new Date(Date.now() + 5 * 60_000).toISOString()
  await env.OPS_DB.prepare(`
    UPDATE sheet_sync_outbox
    SET status = 'pending', attempts = attempts + 1, last_attempt_at = ?,
        next_attempt_at = ?, last_error = ?
    WHERE mutation_id = ?
  `).bind(timestamp, retryAt, String(error?.message || error).slice(0, 1000), mutationId).run()
}

export async function processSheetMirrorQueue(batch, env) {
  for (const message of batch.messages || []) {
    const body = message.body || {}
    try {
      await mirrorToSheets(env, body)
      if (body.entity === 'CloseUp' && body.operation !== 'delete') {
        const syncPatch = await syncCloseUpToSalesTemplate(env, body.record || {})
        await applyCloseUpSyncPatch(env, body, syncPatch)
      }
      await setOutboxSuccess(env, body.mutation_id)
      message.ack()
    } catch (error) {
      console.error('Sheet mirror failed', body.mutation_id, error)
      await setOutboxFailure(env, body.mutation_id, error)
      message.retry()
    }
  }
}

export async function flushPendingSheetMirrors(env, limit = 50) {
  if (!env.OPS_DB?.prepare || !env.SHEET_SYNC_QUEUE?.send) return { queued: 0 }
  const response = await env.OPS_DB.prepare(`
    SELECT payload_json FROM sheet_sync_outbox
    WHERE status = 'pending' AND next_attempt_at <= ?
    ORDER BY id ASC LIMIT ?
  `).bind(now(), Math.max(1, Math.min(Number(limit) || 50, 100))).all()

  let queued = 0
  for (const row of response.results || []) {
    const message = parseJson(row.payload_json, null)
    if (message && await enqueueMirror(env, message)) queued += 1
  }
  return { queued }
}

function managerOnly(user) {
  if (!['owner', 'manager'].includes(String(user.role || '').toLowerCase())) {
    const error = new Error('Manager access required')
    error.status = 403
    error.code = 'manager_required'
    throw error
  }
}

export async function handleRealtimeDataApi(request, env, url) {
  const dataRoute = url.pathname === '/api/realtime/mutations'
    || url.pathname === '/api/realtime/records'
    || url.pathname.startsWith('/api/realtime/data/')
  if (!dataRoute) return null

  try {
    if (url.pathname === '/api/realtime/data/status' && request.method === 'GET') {
      const user = await getCurrentUser(request, env)
      return json(request, env, {
        ok: true,
        revision: 'realtime-d1-primary-v2',
        database: Boolean(env.OPS_DB?.prepare),
        outlet_websocket: Boolean(env.OUTLET_REALTIME?.getByName),
        sheet_queue: Boolean(env.SHEET_SYNC_QUEUE?.send),
        user_email: user.email,
      })
    }

    if (url.pathname === '/api/realtime/mutations' && request.method === 'POST') {
      const user = await getCurrentUser(request, env)
      const result = await applyMutation(env, user, await readJson(request))
      return json(request, env, result, result.replayed ? 200 : 201)
    }

    if (url.pathname === '/api/realtime/records' && request.method === 'GET') {
      const user = await getCurrentUser(request, env)
      const entity = requireEntity(url.searchParams.get('entity'))
      const outletId = requireOutlet(url.searchParams.get('outlet_id') || user.outlet_id)
      assertReadPermission(user, entity)
      assertOutletAccess(user, outletId)
      const options = {
        since: url.searchParams.get('since') || '',
        includeDeleted: url.searchParams.get('include_deleted') === '1',
        limit: url.searchParams.get('limit') || 100,
        filter: parseJson(url.searchParams.get('filter'), {}) || {},
        sort: url.searchParams.get('sort') || '',
        year: url.searchParams.get('year') || undefined,
      }
      let records = await listRecordsFromD1(env, entity, outletId, options)
      let source = records.length ? 'd1' : 'd1-empty'
      let legacyErrorCode = ''

      if (!records.length && url.searchParams.get('legacy_seed') !== '0') {
        const seeded = await seedLegacyRecords(env, entity, outletId, options)
        legacyErrorCode = seeded.error_code || ''
        if (seeded.seeded) {
          records = await listRecordsFromD1(env, entity, outletId, options)
          source = records.length ? 'legacy-seeded-d1' : 'd1-empty'
        }
      }

      return json(request, env, {
        records,
        count: records.length,
        source,
        legacy_error_code: legacyErrorCode,
        server_time: now(),
      })
    }

    if (url.pathname === '/api/realtime/data/sync/retry' && request.method === 'POST') {
      const user = await getCurrentUser(request, env)
      managerOnly(user)
      return json(request, env, { ok: true, ...(await flushPendingSheetMirrors(env, 100)) }, 202)
    }

    const error = new Error('Realtime data endpoint not found')
    error.status = 404
    error.code = 'realtime_data_not_found'
    throw error
  } catch (error) {
    return errorResponse(request, env, error)
  }
}
