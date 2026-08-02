import {
  assertCreatePermission,
  assertDeletePermission,
  assertOutletAccess,
  assertUpdatePermission,
  assignedOutletIds,
} from './permissions.js'
import { getSchema } from './schema.js'

const DEFAULT_TIME_ZONE = 'Asia/Kuala_Lumpur'
const LABEL_MUTATION_ENTITIES = new Set(['PrinterProfile', 'FoodLabel', 'LabelPrintLog'])

export function now() {
  return new Date().toISOString()
}

export function parseJson(value, fallback = null) {
  try { return JSON.parse(String(value || '')) } catch { return fallback }
}

export function asBoolean(value) {
  return value === true || String(value || '').toLowerCase() === 'true'
}

export function asNumber(value) {
  const number = Number(value)
  return Number.isFinite(number) ? number : 0
}

function numberVersion(value, fallback = 0) {
  const version = Number(value)
  return Number.isInteger(version) && version >= 0 ? version : fallback
}

function database(env) {
  if (!env.OPS_DB?.prepare) {
    const error = new Error('D1 database is not configured for Label runtime')
    error.status = 503
    error.code = 'label_d1_unavailable'
    throw error
  }
  return env.OPS_DB
}

export function resolveOutletId(user, requested = '') {
  const value = String(requested || '').trim()
  if (user.role === 'manager' || user.role === 'owner') {
    return value || user.outlet_id || assignedOutletIds(user)[0] || ''
  }
  const allowed = assignedOutletIds(user)
  const target = value || user.outlet_id || allowed[0] || ''
  if (target) assertOutletAccess(user, target)
  return target
}

function businessDate(record = {}) {
  for (const field of ['prep_date', 'printed_at', 'created_date', 'updated_date']) {
    const value = String(record[field] || '').trim()
    if (value) return value.slice(0, 10)
  }
  return ''
}

function statusFor(entity, record, deletedAt = '') {
  if (deletedAt) return 'deleted'
  if (entity === 'PrinterProfile') return asBoolean(record.enabled) ? 'active' : 'inactive'
  if (entity === 'LabelPrintLog') return String(record.print_action || 'print')
  return 'active'
}

function rowRecord(row) {
  if (!row) return null
  return {
    ...(parseJson(row.payload_json, {}) || {}),
    __realtime: {
      entity: row.entity,
      entity_id: row.entity_id,
      outlet_id: row.outlet_id,
      version: Number(row.version || 0),
      created_at: row.created_at || '',
      updated_at: row.updated_at || '',
      deleted_at: row.deleted_at || '',
    },
  }
}

export function withoutRealtime(record) {
  if (!record || typeof record !== 'object') return record
  const { __realtime, ...plain } = record
  return plain
}

export async function findD1Record(env, entity, entityId, { includeDeleted = false } = {}) {
  const clause = includeDeleted ? '' : " AND deleted_at = ''"
  const row = await database(env).prepare(
    `SELECT * FROM ops_records WHERE entity = ? AND entity_id = ?${clause} LIMIT 1`,
  ).bind(entity, entityId).first()
  return rowRecord(row)
}

export async function listD1Rows(env, entity, {
  outletId = '', includeDeleted = false, limit = 5000,
} = {}) {
  const clauses = ['entity = ?']
  const bindings = [entity]
  if (outletId) {
    clauses.push('outlet_id = ?')
    bindings.push(outletId)
  }
  if (!includeDeleted) clauses.push("deleted_at = ''")
  bindings.push(Math.max(1, Math.min(Number(limit) || 5000, 5000)))
  const response = await database(env).prepare(`
    SELECT * FROM ops_records
    WHERE ${clauses.join(' AND ')}
    ORDER BY updated_at DESC
    LIMIT ?
  `).bind(...bindings).all()
  return (response.results || []).map(rowRecord)
}

export function matchesFilter(record, filter = {}) {
  return Object.entries(filter || {}).every(([field, expected]) => {
    if (expected === undefined) return true
    const actual = record?.[field]
    if (Array.isArray(expected)) return expected.map(String).includes(String(actual ?? ''))
    if (expected && typeof expected === 'object') {
      if (Array.isArray(expected.$in) && !expected.$in.map(String).includes(String(actual ?? ''))) return false
      if (Object.prototype.hasOwnProperty.call(expected, '$ne') && String(actual ?? '') === String(expected.$ne ?? '')) return false
      if (Object.prototype.hasOwnProperty.call(expected, '$eq') && String(actual ?? '') !== String(expected.$eq ?? '')) return false
      return true
    }
    return String(actual ?? '') === String(expected ?? '')
  })
}

function cleanPayload(entity, payload = {}) {
  const schema = getSchema(entity)
  const allowed = new Set(schema.headers)
  return Object.fromEntries(Object.entries(payload || {}).filter(([key]) => allowed.has(key)))
}

function buildRecord(entity, payload, existing, user, outletId, entityId, operation, timestamp) {
  const schema = getSchema(entity)
  const allowed = new Set(schema.headers)
  const record = { ...(withoutRealtime(existing) || {}), ...cleanPayload(entity, payload) }
  const idField = schema.idField || 'id'
  record[idField] = entityId
  if (allowed.has('id')) record.id = entityId
  if (allowed.has('outlet_id')) record.outlet_id = outletId
  if (!existing) {
    if (allowed.has('created_date') && !record.created_date) record.created_date = timestamp
    if (allowed.has('created_at') && !record.created_at) record.created_at = timestamp
    if (allowed.has('created_by') && !record.created_by) record.created_by = user.email
  }
  if (allowed.has('updated_date')) record.updated_date = timestamp
  if (allowed.has('updated_at')) record.updated_at = timestamp
  if (allowed.has('updated_by')) record.updated_by = user.email
  if (allowed.has('version')) record.version = numberVersion(existing?.__realtime?.version ?? existing?.version, 0) + 1
  if (allowed.has('deleted_at')) record.deleted_at = operation === 'delete' ? timestamp : ''
  return record
}

async function findMutation(env, mutationId) {
  const row = await database(env).prepare(
    'SELECT result_json FROM ops_mutations WHERE mutation_id = ? LIMIT 1',
  ).bind(mutationId).first()
  const result = parseJson(row?.result_json, null)
  return result ? { ...result, replayed: true } : null
}

export function requestMutationId(request, body, prefix) {
  const supplied = String(body?.mutation_id || request.headers.get('X-ChefOps-Mutation-Id') || '').trim()
  return (supplied || `${prefix}:${crypto.randomUUID()}`).slice(0, 150)
}

async function enqueueMirror(env, message) {
  if (!env.SHEET_SYNC_QUEUE?.send) return false
  try {
    await env.SHEET_SYNC_QUEUE.send(message)
    await database(env).prepare(
      "UPDATE sheet_sync_outbox SET status = 'queued', queued_at = ?, last_error = '' WHERE mutation_id = ?",
    ).bind(now(), message.mutation_id).run()
    return true
  } catch (error) {
    console.error('Unable to enqueue Label Sheet mirror', message.mutation_id, error)
    return false
  }
}

export async function mutateLabelRecord(request, env, user, {
  entity, entityId, outletId, operation = 'upsert', payload = {},
  expectedVersion = null, mutationId = '',
}) {
  if (!LABEL_MUTATION_ENTITIES.has(entity)) {
    const error = new Error(`Label D1 mutation does not support ${entity}`)
    error.status = 400
    error.code = 'label_entity_not_supported'
    throw error
  }

  const id = String(entityId || payload.id || '').trim() || crypto.randomUUID()
  const targetOutlet = resolveOutletId(user, outletId || payload.outlet_id)
  if (!targetOutlet) {
    const error = new Error('Outlet is required')
    error.status = 400
    error.code = 'label_outlet_required'
    throw error
  }
  assertOutletAccess(user, targetOutlet)

  const op = String(operation || 'upsert').toLowerCase()
  const requestId = String(mutationId || requestMutationId(request, payload, `label-${entity.toLowerCase()}-${op}`)).slice(0, 150)
  const replay = await findMutation(env, requestId)
  if (replay) return replay

  const existing = await findD1Record(env, entity, id, { includeDeleted: true })
  if (op === 'create' && existing && !existing.__realtime?.deleted_at) {
    const error = new Error(`${entity} record already exists`)
    error.status = 409
    error.code = 'label_record_exists'
    throw error
  }
  if (['update', 'delete'].includes(op) && !existing) {
    const error = new Error(`${entity} record was not found in D1`)
    error.status = 404
    error.code = 'label_record_not_found'
    throw error
  }
  if (expectedVersion != null && Number(expectedVersion) !== Number(existing?.__realtime?.version || 0)) {
    const error = new Error('This record changed on another device. Refresh and retry.')
    error.status = 409
    error.code = 'label_version_conflict'
    throw error
  }

  if (op === 'delete') assertDeletePermission(user, entity, existing || payload)
  else if (existing) assertUpdatePermission(user, entity, withoutRealtime(existing), payload)
  else assertCreatePermission(user, entity)

  const timestamp = now()
  const record = buildRecord(entity, payload, existing, user, targetOutlet, id, op, timestamp)
  const version = numberVersion(existing?.__realtime?.version, 0) + 1
  const deletedAt = op === 'delete' ? timestamp : ''
  const result = {
    ok: true, replayed: false, mutation_id: requestId, entity,
    entity_id: id, outlet_id: targetOutlet, version, record,
    sync_status: 'pending', committed_at: timestamp,
  }
  const mirrorMessage = {
    mutation_id: requestId, entity, entity_id: id, outlet_id: targetOutlet,
    operation: op, record, version, committed_at: timestamp,
  }
  const db = database(env)
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
      entity, id, targetOutlet, businessDate(record), statusFor(entity, record, deletedAt),
      JSON.stringify(record), version, existing?.__realtime?.created_at || timestamp,
      existing?.created_by || user.email, timestamp, user.email, deletedAt,
    ),
    db.prepare(`
      INSERT INTO ops_mutations (
        mutation_id, outlet_id, entity, entity_id, operation, actor_email,
        actor_name, requested_at, committed_at, result_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      requestId, targetOutlet, entity, id, op, user.email,
      user.full_name || user.email, timestamp, timestamp, JSON.stringify(result),
    ),
    db.prepare(`
      INSERT INTO sheet_sync_outbox (
        mutation_id, entity, entity_id, outlet_id, operation, payload_json,
        status, attempts, next_attempt_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?)
    `).bind(
      requestId, entity, id, targetOutlet, op, JSON.stringify(mirrorMessage), timestamp,
    ),
  ]

  try {
    await db.batch(statements)
  } catch (error) {
    const concurrentReplay = await findMutation(env, requestId)
    if (concurrentReplay) return concurrentReplay
    throw error
  }
  const mirrorJob = enqueueMirror(env, mirrorMessage)
  if (env.__CHEFOPS_CTX?.waitUntil) env.__CHEFOPS_CTX.waitUntil(mirrorJob)
  else await mirrorJob
  return result
}

export async function d1LabelCatalog(env, { summaryOnly = false } = {}) {
  const [productRows, ruleRows] = await Promise.all([
    listD1Rows(env, 'LabelProduct', { limit: 5000 }),
    listD1Rows(env, 'LabelRule', { limit: 5000 }),
  ])
  const products = productRows.map(withoutRealtime)
    .filter((row) => row.productId && asBoolean(row.enabled))
    .map((row) => ({
      productId: String(row.productId),
      productName: String(row.productName || row.displayName || row.productId),
      displayName: String(row.displayName || row.productName || row.productId),
      category: String(row.category || ''), sku: String(row.sku || ''),
      productBarcode: String(row.productBarcode || ''),
      alternateBarcodes: String(row.alternateBarcodes || ''),
      defaultLabelTitle: String(row.defaultLabelTitle || row.displayName || row.productName || ''),
      note: String(row.note || ''),
    }))
  const rules = ruleRows.map(withoutRealtime)
    .filter((row) => row.ruleId && asBoolean(row.enabled))
    .map((row, index) => ({
      ruleId: String(row.ruleId),
      ruleKey: `${String(row.ruleId)}::${String(row.action || '')}::${String(row.storageCondition || '')}::${index + 1}`,
      productId: String(row.productId || ''), productName: String(row.productName || ''),
      action: String(row.action || ''), storageCondition: String(row.storageCondition || ''),
      durationMinutes: asNumber(row.durationMinutes),
      manualExpiryRequired: asBoolean(row.manualExpiryRequired),
      requiresQuantity: asBoolean(row.requiresQuantity),
      quantityLabel: String(row.quantityLabel || ''), quantityUnit: String(row.quantityUnit || ''),
      showQuantityOnLabel: asBoolean(row.showQuantityOnLabel), note: String(row.note || ''),
      requiresSource: asBoolean(row.requiresSource),
      allowedSourceActions: String(row.allowedSourceActions || ''),
      sourceAllowedOutlets: String(row.sourceAllowedOutlets || ''),
      sourceExpiryMode: String(row.sourceExpiryMode || ''),
      sourceProductId: String(row.sourceProductId || ''),
      sourceProductName: String(row.sourceProductName || ''),
      outputProductId: String(row.outputProductId || ''),
      outputProductName: String(row.outputProductName || ''),
      sourceUsageMode: String(row.sourceUsageMode || ''),
      sourceCapacity: asNumber(row.sourceCapacity),
      consumePerLabel: asNumber(row.consumePerLabel || 1),
      sourceUnit: String(row.sourceUnit || row.quantityUnit || ''),
    }))
  if (!products.length || !rules.length) {
    const error = new Error('Label catalog is not available in D1')
    error.status = 503
    error.code = 'label_catalog_d1_empty'
    throw error
  }
  const summary = {
    productCount: products.length,
    ruleCount: rules.length,
    actions: [...new Set(rules.map((row) => row.action).filter(Boolean))].sort(),
    storageConditions: [...new Set(rules.map((row) => row.storageCondition).filter(Boolean))].sort(),
  }
  const source = {
    spreadsheetId: 'd1:LabelProduct+LabelRule',
    productSheet: 'LabelProduct', rulesSheet: 'LabelRule',
    timeZone: String(env.LABEL_TIME_ZONE || DEFAULT_TIME_ZONE),
    status: 'connected', storage: 'd1',
  }
  return { source, summary, ...(summaryOnly ? {} : { products, rules }) }
}
