import { sessionPayload } from './auth.js'
import { errorResponse, json, readJson } from './http.js'
import { assertLocalSessionVersion } from './local-auth-store.js'
import { assignedOutletIds } from './permissions.js'

const CONTRACT = 'statvara-cash-close-v1'
const EXPECTED_ENTITY = 'CashExpectedBasis'
const CLOSE_ENTITY = 'CloseUp'
const ALLOWED_PHASES = new Set(['night'])
const DENOMINATIONS = new Set(['100', '50', '20', '10', '5', '1', '0.5', '0.2', '0.1', '0.05'])
const MUTATION_ID_LIMIT = 160
const SIGNATURE_WINDOW_MS = 5 * 60 * 1000

function now() {
  return new Date().toISOString()
}

function fail(message, code, status = 400, details) {
  const error = new Error(message)
  error.code = code
  error.status = status
  if (details) error.details = details
  throw error
}

function parseJson(value, fallback = null) {
  try { return JSON.parse(String(value || '')) } catch { return fallback }
}

function database(env) {
  if (!env.OPS_DB?.prepare) fail('Cash Close D1 database is unavailable', 'cash_close_database_unavailable', 503)
  return env.OPS_DB
}

function normalizedText(value, field, { required = true, max = 200 } = {}) {
  const text = String(value || '').trim()
  if (required && !text) fail(`${field} is required`, `cash_close_${field}_required`)
  if (text.length > max) fail(`${field} is too long`, `cash_close_${field}_invalid`)
  return text
}

function requireDate(value) {
  const text = normalizedText(value, 'business_date')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) fail('business_date must use YYYY-MM-DD', 'cash_close_business_date_invalid')
  return text
}

function requirePhase(value) {
  const phase = normalizedText(value, 'shift_id').toLowerCase()
  if (!ALLOWED_PHASES.has(phase)) {
    fail('The authoritative cash-close contract currently applies to the night/closing phase', 'cash_close_phase_not_supported')
  }
  return phase
}

function parseCents(value, field, { allowNegative = false } = {}) {
  const text = String(value ?? '').trim()
  if (!/^-?(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(text)) {
    fail(`${field} must be a plain monetary value with at most two decimal places`, 'cash_close_money_invalid')
  }
  const negative = text.startsWith('-')
  if (negative && !allowNegative) fail(`${field} cannot be negative`, 'cash_close_money_negative')
  const unsigned = negative ? text.slice(1) : text
  const [whole, fraction = ''] = unsigned.split('.')
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, '0'))
  if (!Number.isSafeInteger(cents)) fail(`${field} is outside the supported range`, 'cash_close_money_invalid')
  return negative ? -cents : cents
}

function money(cents) {
  const absolute = Math.abs(Number(cents || 0))
  const value = `${Math.floor(absolute / 100)}.${String(absolute % 100).padStart(2, '0')}`
  return Number(cents || 0) < 0 ? `-${value}` : value
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]))
  }
  return value
}

async function sha256(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(value || '')))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

async function fingerprint(action, body) {
  const canonical = stableValue(Object.fromEntries(
    Object.entries(body || {}).filter(([key]) => !['mutation_id', 'requested_at'].includes(key)),
  ))
  return sha256(`${CONTRACT}\n${action}\n${JSON.stringify(canonical)}`)
}

function constantTimeEqual(left, right) {
  const a = String(left || '').toLowerCase()
  const b = String(right || '').toLowerCase()
  if (!a || !b || a.length !== b.length) return false
  let mismatch = 0
  for (let index = 0; index < a.length; index += 1) mismatch |= a.charCodeAt(index) ^ b.charCodeAt(index)
  return mismatch === 0
}

async function hmacHex(secret, value) {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  )
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value))
  return [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

async function verifyExpectedBridge(request, env, rawBody) {
  const secret = String(env.CASH_EXPECTED_BRIDGE_SECRET || '')
  if (secret.length < 32) fail('Cash expected-value bridge is not configured', 'cash_expected_bridge_unavailable', 503)
  const timestamp = String(request.headers.get('X-Statvara-Cash-Timestamp') || '')
  const signature = String(request.headers.get('X-Statvara-Cash-Signature') || '')
  const parsed = Date.parse(timestamp)
  if (!Number.isFinite(parsed) || Math.abs(Date.now() - parsed) > SIGNATURE_WINDOW_MS) {
    fail('Cash expected-value signature timestamp is missing, invalid or expired', 'cash_expected_signature_expired', 401)
  }
  const expected = await hmacHex(secret, `${timestamp}.${rawBody}`)
  if (!constantTimeEqual(expected, signature)) fail('Cash expected-value signature is invalid', 'cash_expected_signature_invalid', 401)
}

function explicitCapabilities(user) {
  if (Array.isArray(user?.capabilities)) return new Set(user.capabilities.map(String))
  const raw = user?.capabilities_json
  if (raw === undefined || raw === null || raw === '') return null
  const parsed = typeof raw === 'string' ? parseJson(raw, []) : raw
  return new Set(Array.isArray(parsed) ? parsed.map(String) : [])
}

function capabilities(user) {
  const explicit = explicitCapabilities(user)
  if (explicit) return explicit
  const role = String(user?.role || '').toLowerCase()
  const values = new Set()
  if (['staff', 'leader', 'supervisor', 'manager', 'owner'].includes(role)) values.add('cash_close.submit')
  if (['supervisor', 'manager', 'owner'].includes(role)) {
    values.add('cash_close.review')
    values.add('cash_close.correct')
  }
  return values
}

async function freshHuman(request, env, capability) {
  const payload = await sessionPayload(request, env)
  if (!payload?.sub) fail('Authentication required', 'auth_required', 401)
  const authMethod = String(payload.auth_method || 'google')
  const userId = String(payload.uid || (authMethod === 'local' ? payload.sub : '') || '').trim()
  const googleSub = userId ? '' : String(payload.sub || '')
  const email = String(payload.email || '').trim().toLowerCase()
  let row = null
  if (userId) {
    row = await database(env).prepare(`
      SELECT * FROM ops_records
      WHERE entity = 'User' AND entity_id = ? AND deleted_at = ''
      LIMIT 1
    `).bind(userId).first()
  } else if (googleSub) {
    row = await database(env).prepare(`
      SELECT * FROM ops_records
      WHERE entity = 'User' AND json_extract(payload_json, '$.google_sub') = ? AND deleted_at = ''
      ORDER BY updated_at DESC LIMIT 1
    `).bind(googleSub).first()
  }
  if (!row && email) {
    row = await database(env).prepare(`
      SELECT * FROM ops_records
      WHERE entity = 'User' AND lower(json_extract(payload_json, '$.email')) = ? AND deleted_at = ''
      ORDER BY updated_at DESC LIMIT 1
    `).bind(email).first()
  }
  const user = row ? (parseJson(row.payload_json, {}) || {}) : null
  if (!user || String(user.status || '').toLowerCase() !== 'active') {
    fail('User account is inactive', 'user_inactive', 403)
  }
  if (authMethod === 'local') await assertLocalSessionVersion(env, user.id, Number(payload.sv || 0))
  if (String(user.principal_type || 'human').toLowerCase() !== 'human') {
    fail('A human principal is required for cash custody and review', 'cash_close_human_required', 403)
  }
  if (!capabilities(user).has(capability)) {
    fail(`Current principal lacks ${capability}`, 'cash_close_capability_required', 403, { capability })
  }
  return user
}

function requireAssignedOutlet(user, requested) {
  const outletId = normalizedText(requested, 'outlet_id')
  if (!assignedOutletIds(user).includes(outletId)) {
    fail('This outlet is not assigned to the current principal', 'wrong_outlet', 403)
  }
  return outletId
}

function rejectUnsupportedScope(body) {
  for (const field of ['company_id', 'tenant_id', 'cash_drawer_id', 'terminal_id']) {
    if (String(body?.[field] || '').trim()) {
      fail(`${field} is not a supported LOOP-029 scope dimension`, 'cash_close_scope_dimension_unsupported')
    }
  }
}

function requireMutationId(request, body) {
  const id = String(body?.mutation_id || request.headers.get('X-ChefOps-Mutation-Id') || '').trim()
  if (!id || id.length > MUTATION_ID_LIMIT) fail('A stable mutation_id is required', 'cash_close_mutation_id_required')
  return id
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
      updated_at: row.updated_at || '',
      deleted_at: row.deleted_at || '',
    },
  }
}

async function findRecord(db, entity, id) {
  const row = await db.prepare(
    'SELECT * FROM ops_records WHERE entity = ? AND entity_id = ? AND deleted_at = \'\' LIMIT 1',
  ).bind(entity, id).first()
  return { row, record: rowRecord(row) }
}

async function findMutation(db, mutationId, requestFingerprint) {
  const row = await db.prepare(
    'SELECT result_json FROM ops_mutations WHERE mutation_id = ? LIMIT 1',
  ).bind(mutationId).first()
  if (!row) return null
  const result = parseJson(row.result_json, {}) || {}
  if (!constantTimeEqual(result.request_fingerprint, requestFingerprint)) {
    fail('mutation_id was already used with a different request body', 'cash_close_mutation_fingerprint_mismatch', 409)
  }
  return { ...result, replayed: true }
}

async function latestExpected(db, outletId, businessDate, shiftId) {
  const row = await db.prepare(`
    SELECT * FROM ops_records
    WHERE entity = ? AND outlet_id = ? AND business_date = ? AND status = 'accepted_external'
      AND json_extract(payload_json, '$.shift_id') = ? AND deleted_at = ''
    ORDER BY json_extract(payload_json, '$.observed_at') DESC, updated_at DESC
    LIMIT 1
  `).bind(EXPECTED_ENTITY, outletId, businessDate, shiftId).first()
  return rowRecord(row)
}

async function logicalCloseRows(db, logicalKey) {
  const result = await db.prepare(`
    SELECT r.*,
      COALESCE((SELECT o.status FROM sheet_sync_outbox o
        WHERE o.entity = r.entity AND o.entity_id = r.entity_id
        ORDER BY o.id DESC LIMIT 1), 'pending') AS mirror_status,
      COALESCE((SELECT o.attempts FROM sheet_sync_outbox o
        WHERE o.entity = r.entity AND o.entity_id = r.entity_id
        ORDER BY o.id DESC LIMIT 1), 0) AS mirror_attempts,
      COALESCE((SELECT o.last_error FROM sheet_sync_outbox o
        WHERE o.entity = r.entity AND o.entity_id = r.entity_id
        ORDER BY o.id DESC LIMIT 1), '') AS mirror_error
    FROM ops_records r
    WHERE r.entity = ? AND json_extract(r.payload_json, '$.logical_key') = ? AND r.deleted_at = ''
    ORDER BY CAST(json_extract(r.payload_json, '$.correction_sequence') AS INTEGER) DESC, r.created_at DESC
  `).bind(CLOSE_ENTITY, logicalKey).all()
  return (result.results || []).map((row) => ({
    ...rowRecord(row),
    mirror: {
      role: 'asynchronous_mirror_only',
      status: row.mirror_status || 'pending',
      attempts: Number(row.mirror_attempts || 0),
      last_error: row.mirror_error || '',
    },
  }))
}

function normalizeChannels(raw, field) {
  if (raw == null) return { cents: {}, money: {}, totalCents: 0 }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail(`${field} must be an object`, 'cash_close_channels_invalid')
  const cents = {}
  const formatted = {}
  let totalCents = 0
  for (const key of Object.keys(raw).sort()) {
    const code = normalizedText(key, `${field}_code`, { max: 80 })
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(code)) fail(`${field} contains an invalid channel code`, 'cash_close_channel_invalid')
    const value = parseCents(raw[key], `${field}.${code}`)
    cents[code] = value
    formatted[code] = money(value)
    totalCents += value
    if (!Number.isSafeInteger(totalCents)) fail(`${field} total is outside the supported range`, 'cash_close_money_invalid')
  }
  return { cents, money: formatted, totalCents }
}

function normalizeDenominations(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    fail('denominations must be an object of denomination to quantity', 'cash_close_denominations_required')
  }
  const quantities = {}
  let totalCents = 0
  for (const [rawKey, rawQuantity] of Object.entries(raw)) {
    const key = String(rawKey).trim()
    if (!DENOMINATIONS.has(key)) fail(`Unsupported denomination: ${key}`, 'cash_close_denomination_unsupported')
    const quantityText = String(rawQuantity ?? '').trim()
    if (!/^(?:0|[1-9]\d*)$/.test(quantityText)) fail('Denomination quantities must be non-negative integers', 'cash_close_denomination_quantity_invalid')
    const quantity = Number(quantityText)
    const denominationCents = parseCents(key, `denomination.${key}`)
    if (!Number.isSafeInteger(quantity) || !Number.isSafeInteger(denominationCents * quantity)) {
      fail('Denomination quantity is outside the supported range', 'cash_close_denomination_quantity_invalid')
    }
    quantities[key] = quantity
    totalCents += denominationCents * quantity
  }
  if (!Object.keys(quantities).length) fail('At least one denomination quantity is required', 'cash_close_denominations_required')
  return { quantities, totalCents }
}

async function countIdentity({ outletId, businessDate, shiftId, actor, denominations, channels }) {
  return sha256(JSON.stringify(stableValue({
    contract: CONTRACT,
    outlet_id: outletId,
    business_date: businessDate,
    shift_id: shiftId,
    custodian_user_id: actor.id,
    denominations,
    actual_channels: channels,
  })))
}

function mirrorMessage(mutationId, entity, entityId, outletId, operation, record, version, timestamp) {
  return {
    mutation_id: mutationId,
    entity,
    entity_id: entityId,
    outlet_id: outletId,
    operation,
    record,
    version,
    committed_at: timestamp,
    authority: 'cloudflare_d1',
    destination_role: 'asynchronous_mirror_only',
  }
}

async function enqueueMirror(env, message) {
  if (!env.SHEET_SYNC_QUEUE?.send) return false
  try {
    await env.SHEET_SYNC_QUEUE.send(message)
    await env.OPS_DB.prepare(
      "UPDATE sheet_sync_outbox SET status = 'queued', queued_at = ?, last_error = '' WHERE mutation_id = ?",
    ).bind(now(), message.mutation_id).run()
    return true
  } catch (error) {
    console.error('Cash Close Sheet mirror enqueue failed', message.mutation_id, error)
    return false
  }
}

function scheduleMirror(env, message) {
  const promise = enqueueMirror(env, message)
  if (env.__CHEFOPS_CTX?.waitUntil) env.__CHEFOPS_CTX.waitUntil(promise)
  else promise.catch(() => undefined)
}

async function insertRecord(env, user, {
  entity, entityId, outletId, businessDate, status, record, mutationId,
  operation, requestFingerprint, requestedAt,
}) {
  const db = database(env)
  const timestamp = now()
  const version = 1
  const result = {
    ok: true,
    replayed: false,
    mutation_id: mutationId,
    request_fingerprint: requestFingerprint,
    entity,
    entity_id: entityId,
    outlet_id: outletId,
    version,
    record,
    committed_at: timestamp,
  }
  const message = mirrorMessage(mutationId, entity, entityId, outletId, operation, record, version, timestamp)
  await db.batch([
    db.prepare(`
      INSERT INTO ops_records (
        entity, entity_id, outlet_id, business_date, status, payload_json,
        version, created_at, created_by, updated_at, updated_by, deleted_at
      ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, '')
    `).bind(entity, entityId, outletId, businessDate, status, JSON.stringify(record), timestamp, user.email, timestamp, user.email),
    db.prepare(`
      INSERT INTO ops_mutations (
        mutation_id, outlet_id, entity, entity_id, operation, actor_email,
        actor_name, requested_at, committed_at, result_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(mutationId, outletId, entity, entityId, operation, user.email, user.full_name || user.email, requestedAt || timestamp, timestamp, JSON.stringify(result)),
    db.prepare(`
      INSERT INTO sheet_sync_outbox (
        mutation_id, entity, entity_id, outlet_id, operation, payload_json,
        status, attempts, next_attempt_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?)
    `).bind(mutationId, entity, entityId, outletId, operation, JSON.stringify(message), timestamp),
  ])
  scheduleMirror(env, message)
  return result
}

async function updateRecord(env, user, existingRow, record, {
  status, mutationId, operation, requestFingerprint, requestedAt,
}) {
  const db = database(env)
  const timestamp = now()
  const version = Number(existingRow.version || 0) + 1
  const entity = existingRow.entity
  const entityId = existingRow.entity_id
  const outletId = existingRow.outlet_id
  const result = {
    ok: true,
    replayed: false,
    mutation_id: mutationId,
    request_fingerprint: requestFingerprint,
    entity,
    entity_id: entityId,
    outlet_id: outletId,
    version,
    record,
    committed_at: timestamp,
  }
  const message = mirrorMessage(mutationId, entity, entityId, outletId, operation, record, version, timestamp)
  await db.batch([
    db.prepare(`
      UPDATE ops_records SET status = ?, payload_json = ?, version = ?, updated_at = ?, updated_by = ?
      WHERE entity = ? AND entity_id = ? AND version = ? AND deleted_at = ''
    `).bind(status, JSON.stringify(record), version, timestamp, user.email, entity, entityId, Number(existingRow.version || 0)),
    db.prepare(`
      INSERT INTO ops_mutations (
        mutation_id, outlet_id, entity, entity_id, operation, actor_email,
        actor_name, requested_at, committed_at, result_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(mutationId, outletId, entity, entityId, operation, user.email, user.full_name || user.email, requestedAt || timestamp, timestamp, JSON.stringify(result)),
    db.prepare(`
      INSERT INTO sheet_sync_outbox (
        mutation_id, entity, entity_id, outlet_id, operation, payload_json,
        status, attempts, next_attempt_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?)
    `).bind(mutationId, entity, entityId, outletId, operation, JSON.stringify(message), timestamp),
  ])
  scheduleMirror(env, message)
  return result
}

async function importExpected(request, env) {
  const rawBody = await request.text()
  await verifyExpectedBridge(request, env, rawBody)
  let body
  try { body = JSON.parse(rawBody) } catch { fail('Invalid JSON request body', 'invalid_json') }
  rejectUnsupportedScope(body)
  const mutationId = requireMutationId(request, body)
  const requestFingerprint = await fingerprint('expected_import', body)
  const db = database(env)
  const replay = await findMutation(db, mutationId, requestFingerprint)
  if (replay) return replay

  if (String(body.provider || '').toLowerCase() !== 'feedme') {
    fail('Only the signed FeedMe expected source is accepted for LOOP-029', 'cash_expected_provider_invalid')
  }
  const outletId = normalizedText(body.outlet_id, 'outlet_id')
  const businessDate = requireDate(body.business_date)
  const shiftId = requirePhase(body.shift_id || 'night')
  const expectedCashCents = parseCents(body.expected_cash, 'expected_cash')
  const channels = normalizeChannels(body.expected_channels || {}, 'expected_channels')
  const observedAt = normalizedText(body.observed_at, 'observed_at')
  if (!Number.isFinite(Date.parse(observedAt))) fail('observed_at must be an ISO timestamp', 'cash_expected_observed_at_invalid')
  const source = {
    provider: 'feedme',
    business_id: normalizedText(body.business_id, 'business_id'),
    report_id: normalizedText(body.report_id, 'report_id'),
    outlet_external_id: normalizedText(body.outlet_external_id, 'outlet_external_id'),
    snapshot_id: normalizedText(body.snapshot_id, 'snapshot_id'),
    source_version: normalizedText(body.source_version, 'source_version'),
    watermark: normalizedText(body.watermark, 'watermark'),
    observed_at: observedAt,
  }
  const sourceDigest = await sha256(JSON.stringify(stableValue({
    contract: CONTRACT,
    outlet_id: outletId,
    business_date: businessDate,
    shift_id: shiftId,
    expected_cash: money(expectedCashCents),
    expected_channels: channels.money,
    source,
  })))
  const entityId = `cash-basis-${sourceDigest.slice(0, 40)}`
  const record = {
    id: entityId,
    authority_contract: CONTRACT,
    authority_role: 'external_input',
    provider: 'feedme',
    outlet_id: outletId,
    business_date: businessDate,
    shift_id: shiftId,
    expected_cash: money(expectedCashCents),
    expected_channels: channels.money,
    expected_channels_total: money(channels.totalCents),
    source_identity: source,
    source_digest: sourceDigest,
    observed_at: observedAt,
    imported_at: now(),
    imported_by_principal: 'feedme-expected-bridge',
    status: 'accepted_external',
  }
  return insertRecord(env, { email: 'feedme-expected-bridge', full_name: 'FeedMe Expected Bridge' }, {
    entity: EXPECTED_ENTITY,
    entityId,
    outletId,
    businessDate,
    status: 'accepted_external',
    record,
    mutationId,
    operation: 'expected_import',
    requestFingerprint,
    requestedAt: body.requested_at,
  })
}

async function submitClose(request, env) {
  const body = await readJson(request)
  rejectUnsupportedScope(body)
  const user = await freshHuman(request, env, 'cash_close.submit')
  const outletId = requireAssignedOutlet(user, body.outlet_id)
  const businessDate = requireDate(body.business_date)
  const shiftId = requirePhase(body.shift_id || 'night')
  if (body.custodian_user_id && String(body.custodian_user_id) !== String(user.id)) {
    fail('Custodian identity is established by the authenticated principal', 'cash_close_custodian_forged', 403)
  }
  for (const field of ['expected_cash', 'actual_cash', 'cash_variance', 'variance', 'actual_total', 'total_variance', 'status']) {
    if (body[field] !== undefined) fail(`${field} is server managed`, 'cash_close_server_managed_field')
  }
  const mutationId = requireMutationId(request, body)
  const requestFingerprint = await fingerprint('submit', body)
  const db = database(env)
  const replay = await findMutation(db, mutationId, requestFingerprint)
  if (replay) return replay

  const expectedBasisId = normalizedText(body.expected_basis_id, 'expected_basis_id')
  const { row: expectedRow, record: expected } = await findRecord(db, EXPECTED_ENTITY, expectedBasisId)
  if (!expectedRow || expected?.authority_role !== 'external_input' || expected?.provider !== 'feedme') {
    fail('Expected basis is not an accepted FeedMe external snapshot', 'cash_close_expected_basis_invalid', 409)
  }
  if (expected.outlet_id !== outletId || expected.business_date !== businessDate || expected.shift_id !== shiftId) {
    fail('Expected basis does not match this outlet/date/phase', 'cash_close_expected_basis_scope_mismatch', 409)
  }
  const latest = await latestExpected(db, outletId, businessDate, shiftId)
  if (!latest || latest.id !== expectedBasisId) {
    fail('Expected basis changed before server acceptance; refresh and recount/review the current source', 'cash_close_expected_basis_stale', 409)
  }
  if (body.expected_basis_digest && body.expected_basis_digest !== expected.source_digest) {
    fail('Expected basis digest does not match D1', 'cash_close_expected_basis_digest_mismatch', 409)
  }

  const denominations = normalizeDenominations(body.denominations)
  const actualChannels = normalizeChannels(body.actual_channels || {}, 'actual_channels')
  const expectedCashCents = parseCents(expected.expected_cash, 'expected.expected_cash')
  const cashVarianceCents = denominations.totalCents - expectedCashCents
  const expectedChannelsTotalCents = parseCents(expected.expected_channels_total, 'expected.expected_channels_total')
  const paymentVarianceCents = actualChannels.totalCents - expectedChannelsTotalCents
  const totalVarianceCents = cashVarianceCents + paymentVarianceCents
  const varianceReason = normalizedText(body.variance_reason, 'variance_reason', {
    required: totalVarianceCents !== 0,
    max: 1000,
  })
  const logicalKey = `${outletId}|${businessDate}|${shiftId}`
  const existingRows = await logicalCloseRows(db, logicalKey)
  if (existingRows.length) fail('A Close Up already exists for this outlet/date/phase', 'cash_close_duplicate', 409)
  const logicalDigest = await sha256(`${CONTRACT}\n${logicalKey}`)
  const entityId = `cash-close-${logicalDigest.slice(0, 40)}`
  const submittedAt = now()
  const identity = await countIdentity({
    outletId, businessDate, shiftId, actor: user,
    denominations: denominations.quantities,
    channels: actualChannels.money,
  })
  const record = {
    id: entityId,
    authority_contract: CONTRACT,
    authority_role: 'authoritative_operational_truth',
    logical_key: logicalKey,
    root_close_id: entityId,
    correction_of_id: '',
    correction_sequence: 0,
    outlet_id: outletId,
    business_date: businessDate,
    shift_id: shiftId,
    shift_name: 'Night / Closing',
    expected_basis_id: expected.id,
    expected_basis_digest: expected.source_digest,
    expected_source_identity: expected.source_identity,
    expected_cash: expected.expected_cash,
    expected_channels: expected.expected_channels,
    expected_channels_total: expected.expected_channels_total,
    count_identity: identity,
    denominations: denominations.quantities,
    denominations_json: JSON.stringify(denominations.quantities),
    actual_cash: money(denominations.totalCents),
    actual_channels: actualChannels.money,
    payments_json: JSON.stringify({ amounts: actualChannels.money }),
    payment_total: money(denominations.totalCents + actualChannels.totalCents),
    cash_variance: money(cashVarianceCents),
    payment_variance: money(paymentVarianceCents),
    total_variance: money(totalVarianceCents),
    variance_reason: varianceReason,
    custody: {
      custodian_user_id: String(user.id || ''),
      custodian_email: String(user.email || ''),
      custodian_name: String(user.full_name || user.email || ''),
      established_from: 'acceptance_time_authenticated_principal',
    },
    submitted_by_user_id: String(user.id || ''),
    submitted_by_email: String(user.email || ''),
    submitted_by_name: String(user.full_name || user.email || ''),
    submitted_at: submittedAt,
    review: null,
    completed_at: '',
    status: 'submitted',
  }
  return insertRecord(env, user, {
    entity: CLOSE_ENTITY,
    entityId,
    outletId,
    businessDate,
    status: 'submitted',
    record,
    mutationId,
    operation: 'cash_close_submit',
    requestFingerprint,
    requestedAt: body.requested_at,
  })
}

async function reviewClose(request, env) {
  const body = await readJson(request)
  rejectUnsupportedScope(body)
  const user = await freshHuman(request, env, 'cash_close.review')
  const mutationId = requireMutationId(request, body)
  const requestFingerprint = await fingerprint('review', body)
  const db = database(env)
  const replay = await findMutation(db, mutationId, requestFingerprint)
  if (replay) return replay
  const closeId = normalizedText(body.close_id, 'close_id')
  const { row, record } = await findRecord(db, CLOSE_ENTITY, closeId)
  if (!row || record?.authority_contract !== CONTRACT) fail('Authoritative Close Up was not found', 'cash_close_not_found', 404)
  requireAssignedOutlet(user, record.outlet_id)
  if (record.status !== 'submitted') fail('Only a submitted Close Up may be reviewed', 'cash_close_lifecycle_conflict', 409)
  if (String(record.submitted_by_user_id || '') === String(user.id || '') || String(record.submitted_by_email || '') === String(user.email || '')) {
    fail('Submitter cannot perform the independent Close Up review', 'cash_close_reviewer_conflict', 403)
  }
  const decision = normalizedText(body.decision, 'decision').toLowerCase()
  if (!['accept', 'reject'].includes(decision)) fail('decision must be accept or reject', 'cash_close_review_decision_invalid')
  const reason = normalizedText(body.reason, 'reason', {
    required: decision === 'reject' || record.total_variance !== '0.00',
    max: 1000,
  })
  const latest = await latestExpected(db, record.outlet_id, record.business_date, record.shift_id)
  const expectedDrift = Boolean(latest && latest.id !== record.expected_basis_id)
  if (expectedDrift && decision === 'accept' && body.acknowledge_expected_drift !== true) {
    fail('FeedMe expected basis changed; reviewer acknowledgement and reason are required', 'cash_close_expected_basis_changed', 409, {
      submitted_basis_id: record.expected_basis_id,
      latest_basis_id: latest.id,
    })
  }
  const reviewedAt = now()
  const status = decision === 'accept' ? 'completed' : 'rejected'
  const next = {
    ...record,
    __realtime: undefined,
    review: {
      decision,
      reason,
      reviewer_user_id: String(user.id || ''),
      reviewer_email: String(user.email || ''),
      reviewer_name: String(user.full_name || user.email || ''),
      reviewed_at: reviewedAt,
      expected_drift_detected: expectedDrift,
      expected_drift_acknowledged: expectedDrift && body.acknowledge_expected_drift === true,
      latest_expected_basis_id: latest?.id || record.expected_basis_id,
    },
    completed_at: decision === 'accept' ? reviewedAt : '',
    status,
  }
  return updateRecord(env, user, row, next, {
    status,
    mutationId,
    operation: `cash_close_${decision}`,
    requestFingerprint,
    requestedAt: body.requested_at,
  })
}

async function correctClose(request, env) {
  const body = await readJson(request)
  rejectUnsupportedScope(body)
  const user = await freshHuman(request, env, 'cash_close.correct')
  const mutationId = requireMutationId(request, body)
  const requestFingerprint = await fingerprint('correct', body)
  const db = database(env)
  const replay = await findMutation(db, mutationId, requestFingerprint)
  if (replay) return replay
  const originalId = normalizedText(body.original_close_id, 'original_close_id')
  const { record: original } = await findRecord(db, CLOSE_ENTITY, originalId)
  if (!original || original.authority_contract !== CONTRACT) fail('Original Close Up was not found', 'cash_close_not_found', 404)
  requireAssignedOutlet(user, original.outlet_id)
  if (original.status !== 'completed') fail('Only a completed Close Up may be corrected', 'cash_close_correction_lifecycle_conflict', 409)
  const rows = await logicalCloseRows(db, original.logical_key)
  const current = rows.find((item) => item.status === 'completed') || original
  if (current.id !== original.id) fail('A newer authoritative correction already exists', 'cash_close_correction_superseded', 409)
  if (rows.some((item) => item.status === 'submitted')) fail('A correction is already awaiting review', 'cash_close_correction_pending', 409)
  if (body.custodian_user_id && String(body.custodian_user_id) !== String(user.id)) {
    fail('Correction actor identity is established by the authenticated principal', 'cash_close_custodian_forged', 403)
  }
  for (const field of ['expected_cash', 'actual_cash', 'cash_variance', 'variance', 'actual_total', 'total_variance', 'status']) {
    if (body[field] !== undefined) fail(`${field} is server managed`, 'cash_close_server_managed_field')
  }
  const reason = normalizedText(body.correction_reason, 'correction_reason', { max: 1000 })
  const expectedBasisId = normalizedText(body.expected_basis_id, 'expected_basis_id')
  const { record: expected } = await findRecord(db, EXPECTED_ENTITY, expectedBasisId)
  if (!expected || expected.outlet_id !== original.outlet_id || expected.business_date !== original.business_date || expected.shift_id !== original.shift_id) {
    fail('Correction expected basis does not match the original scope', 'cash_close_expected_basis_scope_mismatch', 409)
  }
  const latest = await latestExpected(db, original.outlet_id, original.business_date, original.shift_id)
  if (!latest || latest.id !== expectedBasisId) fail('Correction must use the latest accepted expected basis', 'cash_close_expected_basis_stale', 409)
  const denominations = normalizeDenominations(body.denominations)
  const actualChannels = normalizeChannels(body.actual_channels || {}, 'actual_channels')
  const expectedCashCents = parseCents(expected.expected_cash, 'expected.expected_cash')
  const expectedChannelsTotalCents = parseCents(expected.expected_channels_total, 'expected.expected_channels_total')
  const cashVarianceCents = denominations.totalCents - expectedCashCents
  const paymentVarianceCents = actualChannels.totalCents - expectedChannelsTotalCents
  const totalVarianceCents = cashVarianceCents + paymentVarianceCents
  const varianceReason = normalizedText(body.variance_reason, 'variance_reason', {
    required: totalVarianceCents !== 0,
    max: 1000,
  })
  const sequence = Math.max(0, ...rows.map((item) => Number(item.correction_sequence || 0))) + 1
  const entityId = `cash-close-correction-${await sha256(`${original.logical_key}\n${sequence}\n${mutationId}`).then((value) => value.slice(0, 40))}`
  const submittedAt = now()
  const identity = await countIdentity({
    outletId: original.outlet_id,
    businessDate: original.business_date,
    shiftId: original.shift_id,
    actor: user,
    denominations: denominations.quantities,
    channels: actualChannels.money,
  })
  const record = {
    ...original,
    __realtime: undefined,
    id: entityId,
    root_close_id: original.root_close_id || original.id,
    correction_of_id: original.id,
    correction_sequence: sequence,
    correction_reason: reason,
    corrected_by_user_id: String(user.id || ''),
    corrected_by_email: String(user.email || ''),
    corrected_by_name: String(user.full_name || user.email || ''),
    corrected_at: submittedAt,
    expected_basis_id: expected.id,
    expected_basis_digest: expected.source_digest,
    expected_source_identity: expected.source_identity,
    expected_cash: expected.expected_cash,
    expected_channels: expected.expected_channels,
    expected_channels_total: expected.expected_channels_total,
    count_identity: identity,
    denominations: denominations.quantities,
    denominations_json: JSON.stringify(denominations.quantities),
    actual_cash: money(denominations.totalCents),
    actual_channels: actualChannels.money,
    payments_json: JSON.stringify({ amounts: actualChannels.money }),
    payment_total: money(denominations.totalCents + actualChannels.totalCents),
    cash_variance: money(cashVarianceCents),
    payment_variance: money(paymentVarianceCents),
    total_variance: money(totalVarianceCents),
    variance_reason: varianceReason,
    custody: {
      custodian_user_id: String(user.id || ''),
      custodian_email: String(user.email || ''),
      custodian_name: String(user.full_name || user.email || ''),
      established_from: 'acceptance_time_authenticated_principal',
    },
    submitted_by_user_id: String(user.id || ''),
    submitted_by_email: String(user.email || ''),
    submitted_by_name: String(user.full_name || user.email || ''),
    submitted_at: submittedAt,
    review: null,
    completed_at: '',
    status: 'submitted',
  }
  return insertRecord(env, user, {
    entity: CLOSE_ENTITY,
    entityId,
    outletId: original.outlet_id,
    businessDate: original.business_date,
    status: 'submitted',
    record,
    mutationId,
    operation: 'cash_close_correction_submit',
    requestFingerprint,
    requestedAt: body.requested_at,
  })
}

async function readContext(request, env, url) {
  const user = await freshHuman(request, env, 'cash_close.submit')
  rejectUnsupportedScope(Object.fromEntries(url.searchParams))
  const outletId = requireAssignedOutlet(user, url.searchParams.get('outlet_id'))
  const businessDate = requireDate(url.searchParams.get('business_date'))
  const shiftId = requirePhase(url.searchParams.get('shift_id') || 'night')
  const db = database(env)
  const logicalKey = `${outletId}|${businessDate}|${shiftId}`
  const [expected, history] = await Promise.all([
    latestExpected(db, outletId, businessDate, shiftId),
    logicalCloseRows(db, logicalKey),
  ])
  const current = history.find((record) => record.status === 'completed') || history[0] || null
  return {
    ok: true,
    authority: 'cloudflare_d1',
    authority_contract: CONTRACT,
    scope: { outlet_id: outletId, business_date: businessDate, shift_id: shiftId },
    expected_basis: expected,
    current_close: current,
    history,
    expected_drift: Boolean(current && expected && current.expected_basis_id !== expected.id),
    completion: current?.status === 'completed' ? {
      complete: true,
      fact: 'submitted_close_retains_actuals_expected_provenance_variance_review_and_correction_history',
      close_id: current.id,
    } : { complete: false },
    mirror_role: 'asynchronous_mirror_only',
  }
}

export async function handleCashCloseApi(request, env, url) {
  if (!url.pathname.startsWith('/api/cash-close')) return null
  try {
    if (url.pathname === '/api/cash-close/expected' && request.method === 'POST') {
      return json(request, env, await importExpected(request, env), 202)
    }
    if (url.pathname === '/api/cash-close/context' && request.method === 'GET') {
      return json(request, env, await readContext(request, env, url))
    }
    if (url.pathname === '/api/cash-close/submit' && request.method === 'POST') {
      return json(request, env, await submitClose(request, env), 201)
    }
    if (url.pathname === '/api/cash-close/review' && request.method === 'POST') {
      return json(request, env, await reviewClose(request, env))
    }
    if (url.pathname === '/api/cash-close/correct' && request.method === 'POST') {
      return json(request, env, await correctClose(request, env), 201)
    }
    fail('Cash Close endpoint or method is not supported', 'cash_close_route_not_found', 404)
  } catch (error) {
    return errorResponse(request, env, error)
  }
}

export const cashCloseDomain = {
  CONTRACT,
  DENOMINATIONS,
  fingerprint,
  money,
  normalizeChannels,
  normalizeDenominations,
  parseCents,
}
