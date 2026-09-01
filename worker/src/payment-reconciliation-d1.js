import { sessionPayload } from './auth.js'
import { errorResponse, json, readJson } from './http.js'
import { assertLocalSessionVersion } from './local-auth-store.js'
import { assignedOutletIds } from './permissions.js'

const CONTRACT = 'statvara-payment-reconciliation-v1'
const EXPECTED_ENTITY = 'CashExpectedBasis'
const ACTUAL_ENTITY = 'CloseUp'
const RECONCILIATION_ENTITY = 'PaymentReconciliation'
const CASH_CLOSE_CONTRACT = 'statvara-cash-close-v1'
const ALLOWED_PHASES = new Set(['night'])
const MUTATION_ID_LIMIT = 160

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
  if (!env.OPS_DB?.prepare) fail('Payment Reconciliation D1 database is unavailable', 'payment_reconciliation_database_unavailable', 503)
  return env.OPS_DB
}

function normalizedText(value, field, { required = true, max = 1000 } = {}) {
  const text = String(value || '').trim()
  if (required && !text) fail(`${field} is required`, `payment_reconciliation_${field}_required`)
  if (text.length > max) fail(`${field} is too long`, `payment_reconciliation_${field}_invalid`)
  return text
}

function requireDate(value) {
  const text = normalizedText(value, 'business_date')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    fail('business_date must use YYYY-MM-DD', 'payment_reconciliation_business_date_invalid')
  }
  return text
}

function requirePhase(value) {
  const phase = normalizedText(value, 'shift_id').toLowerCase()
  if (!ALLOWED_PHASES.has(phase)) {
    fail('The migrated Payment Reconciliation record family currently applies to the night/closing phase', 'payment_reconciliation_phase_not_supported')
  }
  return phase
}

function parseCents(value, field) {
  const text = String(value ?? '').trim()
  if (!/^-?(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(text)) {
    fail(`${field} must be a plain monetary value with at most two decimal places`, 'payment_reconciliation_money_invalid')
  }
  const negative = text.startsWith('-')
  const unsigned = negative ? text.slice(1) : text
  const [whole, fraction = ''] = unsigned.split('.')
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, '0'))
  if (!Number.isSafeInteger(cents)) fail(`${field} is outside the supported range`, 'payment_reconciliation_money_invalid')
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

function explicitCapabilities(user) {
  if (Array.isArray(user?.capabilities)) return new Set(user.capabilities.map(String))
  if (user?.capabilities_json === undefined || user?.capabilities_json === null || user?.capabilities_json === '') return null
  const parsed = typeof user.capabilities_json === 'string'
    ? parseJson(user.capabilities_json, [])
    : user.capabilities_json
  return new Set(Array.isArray(parsed) ? parsed.map(String) : [])
}

function capabilities(user) {
  const explicit = explicitCapabilities(user)
  if (explicit) return explicit
  const role = String(user?.role || '').toLowerCase()
  const values = new Set()
  if (['staff', 'leader', 'supervisor', 'manager', 'owner'].includes(role)) {
    values.add('payment_reconciliation.enter_actuals')
    values.add('payment_reconciliation.reveal')
    values.add('payment_reconciliation.remark')
    values.add('payment_reconciliation.submit')
  }
  if (['supervisor', 'manager', 'owner'].includes(role)) values.add('payment_reconciliation.replace')
  return values
}

async function freshHuman(request, env, capability) {
  const payload = await sessionPayload(request, env)
  if (!payload?.sub) fail('Authentication required', 'auth_required', 401)
  const authMethod = String(payload.auth_method || 'google')
  const userId = String(payload.uid || (authMethod === 'local' ? payload.sub : '') || '').trim()
  const googleSub = userId ? '' : String(payload.sub || '').trim()
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
    fail('A current human principal is required for Payment Reconciliation', 'payment_reconciliation_human_required', 403)
  }
  if (!capabilities(user).has(capability)) {
    fail(`Current principal lacks ${capability}`, 'payment_reconciliation_capability_required', 403, { capability })
  }
  return user
}

function requireAssignedOutlet(user, requested) {
  const outletId = normalizedText(requested, 'outlet_id', { max: 120 })
  if (!assignedOutletIds(user).includes(outletId)) {
    fail('This outlet is not assigned to the current principal', 'wrong_outlet', 403)
  }
  return outletId
}

function rejectUnsupportedScope(body) {
  for (const field of ['company_id', 'tenant_id', 'supplier_id', 'supplier_invoice_id', 'payment_id', 'payment_allocation_id', 'bank_account_id']) {
    if (String(body?.[field] || '').trim()) {
      fail(`${field} is not a supported migrated LOOP-030 scope dimension`, 'payment_reconciliation_scope_dimension_unsupported')
    }
  }
}

function rejectServerManaged(body) {
  for (const field of ['expected', 'expected_total', 'actual', 'actual_total', 'variance', 'channel_variances', 'status', 'completion', 'review', 'reconciled']) {
    if (body?.[field] !== undefined) {
      fail(`${field} is server managed`, 'payment_reconciliation_server_managed_field')
    }
  }
}

function requireMutationId(request, body) {
  const id = String(body?.mutation_id || request.headers.get('X-ChefOps-Mutation-Id') || '').trim()
  if (!id || id.length > MUTATION_ID_LIMIT) {
    fail('A stable mutation_id is required', 'payment_reconciliation_mutation_id_required')
  }
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
      business_date: row.business_date || '',
      version: Number(row.version || 0),
      created_at: row.created_at || '',
      updated_at: row.updated_at || '',
    },
  }
}

function bare(record) {
  if (!record) return null
  const { __realtime: _ignored, ...value } = record
  return value
}

async function findRecord(db, entity, id) {
  const row = await db.prepare(
    "SELECT * FROM ops_records WHERE entity = ? AND entity_id = ? AND deleted_at = '' LIMIT 1",
  ).bind(entity, id).first()
  return { row, record: rowRecord(row) }
}

async function findMutation(db, mutationId, requestFingerprint) {
  const row = await db.prepare('SELECT result_json FROM ops_mutations WHERE mutation_id = ? LIMIT 1').bind(mutationId).first()
  if (!row) return null
  const result = parseJson(row.result_json, {}) || {}
  if (!constantTimeEqual(result.request_fingerprint, requestFingerprint)) {
    fail('mutation_id was already used with a different request body', 'payment_reconciliation_mutation_fingerprint_mismatch', 409)
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
  const record = rowRecord(row)
  return record?.authority_role === 'external_input' && record?.provider === 'feedme' ? record : null
}

async function currentActual(db, outletId, businessDate, shiftId) {
  const logicalKey = `${outletId}|${businessDate}|${shiftId}`
  const result = await db.prepare(`
    SELECT * FROM ops_records
    WHERE entity = ? AND outlet_id = ? AND business_date = ? AND status = 'completed'
      AND json_extract(payload_json, '$.logical_key') = ? AND deleted_at = ''
    ORDER BY CAST(json_extract(payload_json, '$.correction_sequence') AS INTEGER) DESC, created_at DESC
  `).bind(ACTUAL_ENTITY, outletId, businessDate, logicalKey).all()
  return (result.results || []).map(rowRecord).find((record) => record?.authority_contract === CASH_CLOSE_CONTRACT) || null
}

async function reconciliationRows(db, logicalKey) {
  const result = await db.prepare(`
    SELECT * FROM ops_records
    WHERE entity = ? AND json_extract(payload_json, '$.logical_key') = ? AND deleted_at = ''
    ORDER BY CAST(json_extract(payload_json, '$.replacement_sequence') AS INTEGER) DESC, created_at DESC
  `).bind(RECONCILIATION_ENTITY, logicalKey).all()
  return (result.results || []).map(rowRecord).filter((record) => record?.authority_contract === CONTRACT)
}

function actorEvidence(user, action, mutationId) {
  return {
    action,
    mutation_id: mutationId,
    actor_user_id: String(user.id || ''),
    actor_email: String(user.email || ''),
    actor_name: String(user.full_name || user.email || ''),
    principal_type: 'human',
    accepted_at: now(),
  }
}

function factIdentity(expected, actual) {
  return {
    expected: {
      entity: EXPECTED_ENTITY,
      id: expected.id,
      version: Number(expected.__realtime?.version || 0),
      source_digest: expected.source_digest,
      source_identity: expected.source_identity,
      observed_at: expected.observed_at,
    },
    actual: {
      entity: ACTUAL_ENTITY,
      id: actual.id,
      version: Number(actual.__realtime?.version || 0),
      count_identity: actual.count_identity,
      completed_at: actual.completed_at,
      correction_sequence: Number(actual.correction_sequence || 0),
    },
  }
}

function factSnapshots(expected, actual) {
  return {
    expected: {
      cash: expected.expected_cash,
      channels: expected.expected_channels || {},
      total: money(
        parseCents(expected.expected_cash, 'expected.expected_cash')
        + parseCents(expected.expected_channels_total, 'expected.expected_channels_total'),
      ),
    },
    actual: {
      cash: actual.actual_cash,
      channels: actual.actual_channels || {},
      total: money(
        parseCents(actual.actual_cash, 'actual.actual_cash')
        + Object.values(actual.actual_channels || {}).reduce((sum, value) => sum + parseCents(value, 'actual.channel'), 0),
      ),
    },
  }
}

function compareFacts(expectedSnapshot, actualSnapshot) {
  const keys = [...new Set([
    'cash',
    ...Object.keys(expectedSnapshot.channels || {}),
    ...Object.keys(actualSnapshot.channels || {}),
  ])].sort()
  let expectedTotalCents = 0
  let actualTotalCents = 0
  const channels = keys.map((channel) => {
    const expectedCents = channel === 'cash'
      ? parseCents(expectedSnapshot.cash, 'expected.cash')
      : parseCents(expectedSnapshot.channels?.[channel] || '0.00', `expected.${channel}`)
    const actualCents = channel === 'cash'
      ? parseCents(actualSnapshot.cash, 'actual.cash')
      : parseCents(actualSnapshot.channels?.[channel] || '0.00', `actual.${channel}`)
    const varianceCents = actualCents - expectedCents
    expectedTotalCents += expectedCents
    actualTotalCents += actualCents
    const difference_class = varianceCents === 0
      ? 'matched'
      : expectedCents === 0
        ? 'unexpected_actual'
        : actualCents === 0
          ? 'missing_actual'
          : 'amount_mismatch'
    return {
      channel,
      expected: money(expectedCents),
      actual: money(actualCents),
      variance: money(varianceCents),
      difference_class,
    }
  })
  return {
    channels,
    expected_total: money(expectedTotalCents),
    actual_total: money(actualTotalCents),
    variance: money(actualTotalCents - expectedTotalCents),
    all_matched: expectedTotalCents === actualTotalCents && channels.every((item) => item.difference_class === 'matched'),
  }
}

async function insertRecord(env, user, {
  entityId, outletId, businessDate, status, record, mutationId, operation, requestFingerprint, requestedAt,
}) {
  const db = database(env)
  const timestamp = now()
  const version = 1
  const result = {
    ok: true,
    replayed: false,
    mutation_id: mutationId,
    request_fingerprint: requestFingerprint,
    entity: RECONCILIATION_ENTITY,
    entity_id: entityId,
    outlet_id: outletId,
    version,
    record,
    committed_at: timestamp,
  }
  await db.batch([
    db.prepare(`
      INSERT INTO ops_records (
        entity, entity_id, outlet_id, business_date, status, payload_json,
        version, created_at, created_by, updated_at, updated_by, deleted_at
      ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, '')
    `).bind(RECONCILIATION_ENTITY, entityId, outletId, businessDate, status, JSON.stringify(record), timestamp, user.email, timestamp, user.email),
    db.prepare(`
      INSERT INTO ops_mutations (
        mutation_id, outlet_id, entity, entity_id, operation, actor_email,
        actor_name, requested_at, committed_at, result_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(mutationId, outletId, RECONCILIATION_ENTITY, entityId, operation, user.email, user.full_name || user.email, requestedAt || timestamp, timestamp, JSON.stringify(result)),
  ])
  return result
}

async function updateRecord(env, user, row, record, {
  status, mutationId, operation, requestFingerprint, requestedAt,
}) {
  const db = database(env)
  const timestamp = now()
  const currentVersion = Number(row.version || 0)
  const version = currentVersion + 1
  const result = {
    ok: true,
    replayed: false,
    mutation_id: mutationId,
    request_fingerprint: requestFingerprint,
    entity: RECONCILIATION_ENTITY,
    entity_id: row.entity_id,
    outlet_id: row.outlet_id,
    version,
    record,
    committed_at: timestamp,
  }
  const responses = await db.batch([
    db.prepare(`
      UPDATE ops_records SET status = ?, payload_json = ?, version = ?, updated_at = ?, updated_by = ?
      WHERE entity = ? AND entity_id = ? AND version = ? AND deleted_at = ''
    `).bind(status, JSON.stringify(record), version, timestamp, user.email, RECONCILIATION_ENTITY, row.entity_id, currentVersion),
    db.prepare(`
      INSERT INTO ops_mutations (
        mutation_id, outlet_id, entity, entity_id, operation, actor_email,
        actor_name, requested_at, committed_at, result_json
      )
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      WHERE EXISTS (
        SELECT 1 FROM ops_records
        WHERE entity = ? AND entity_id = ? AND version = ? AND deleted_at = ''
      )
    `).bind(
      mutationId, row.outlet_id, RECONCILIATION_ENTITY, row.entity_id, operation,
      user.email, user.full_name || user.email, requestedAt || timestamp, timestamp, JSON.stringify(result),
      RECONCILIATION_ENTITY, row.entity_id, version,
    ),
  ])
  const changes = Number(responses?.[0]?.meta?.changes ?? responses?.[0]?.changes ?? 1)
  if (changes === 0) fail('Reconciliation changed concurrently; refresh and retry', 'payment_reconciliation_version_conflict', 409)
  return result
}

function requireVersion(body, row) {
  const version = Number(body.expected_version)
  if (!Number.isInteger(version) || version < 1) {
    fail('expected_version is required for this lifecycle mutation', 'payment_reconciliation_expected_version_required')
  }
  if (version !== Number(row.version || 0)) {
    fail('Reconciliation changed concurrently; refresh and retry', 'payment_reconciliation_version_conflict', 409, {
      expected_version: version,
      current_version: Number(row.version || 0),
    })
  }
}

async function resolvedFacts(db, body, scope) {
  const expectedId = normalizedText(body.expected_basis_id, 'expected_basis_id', { max: 200 })
  const actualId = normalizedText(body.actual_close_id, 'actual_close_id', { max: 200 })
  const [{ row: expectedRow, record: expected }, { row: actualRow, record: actual }] = await Promise.all([
    findRecord(db, EXPECTED_ENTITY, expectedId),
    findRecord(db, ACTUAL_ENTITY, actualId),
  ])
  if (!expectedRow || expected?.authority_role !== 'external_input' || expected?.provider !== 'feedme') {
    fail('Expected basis is not an accepted FeedMe external snapshot', 'payment_reconciliation_expected_basis_invalid', 409)
  }
  if (!actualRow || actual?.authority_contract !== CASH_CLOSE_CONTRACT || actual?.status !== 'completed') {
    fail('Actual fact is not an authoritative completed D1 Close Up', 'payment_reconciliation_actual_fact_invalid', 409)
  }
  for (const fact of [expected, actual]) {
    if (fact.outlet_id !== scope.outletId || fact.business_date !== scope.businessDate || fact.shift_id !== scope.shiftId) {
      fail('Expected or actual fact does not match this outlet/date/phase', 'payment_reconciliation_fact_scope_mismatch', 409)
    }
  }
  const [latest, current] = await Promise.all([
    latestExpected(db, scope.outletId, scope.businessDate, scope.shiftId),
    currentActual(db, scope.outletId, scope.businessDate, scope.shiftId),
  ])
  if (!latest || latest.id !== expected.id) {
    fail('Expected source changed before acceptance; bind a new reconciliation to the latest source version', 'payment_reconciliation_expected_basis_stale', 409)
  }
  if (!current || current.id !== actual.id) {
    fail('Actual Close Up changed before acceptance; bind a new reconciliation to the current authoritative fact', 'payment_reconciliation_actual_fact_stale', 409)
  }
  if (body.expected_basis_digest && body.expected_basis_digest !== expected.source_digest) {
    fail('Expected basis digest does not match D1', 'payment_reconciliation_expected_digest_mismatch', 409)
  }
  if (body.actual_count_identity && body.actual_count_identity !== actual.count_identity) {
    fail('Actual count identity does not match D1', 'payment_reconciliation_actual_identity_mismatch', 409)
  }
  if (body.actual_version !== undefined && Number(body.actual_version) !== Number(actualRow.version || 0)) {
    fail('Actual fact version does not match D1', 'payment_reconciliation_actual_version_mismatch', 409)
  }
  return { expected, actual }
}

function staleness(record, expected, actual) {
  const reasons = []
  if (!expected) reasons.push('expected_source_unavailable')
  else {
    if (record.fact_identity?.expected?.id !== expected.id) reasons.push('expected_source_version_changed')
    if (record.fact_identity?.expected?.source_digest !== expected.source_digest) reasons.push('expected_source_digest_changed')
  }
  if (!actual) reasons.push('actual_fact_unavailable')
  else {
    if (record.fact_identity?.actual?.id !== actual.id) reasons.push('actual_fact_replaced')
    if (record.fact_identity?.actual?.count_identity !== actual.count_identity) reasons.push('actual_fact_identity_changed')
    if (Number(record.fact_identity?.actual?.version || 0) !== Number(actual.__realtime?.version || 0)) reasons.push('actual_fact_version_changed')
  }
  return reasons
}

async function requireCurrentBoundFacts(db, record) {
  const [expected, actual] = await Promise.all([
    latestExpected(db, record.outlet_id, record.business_date, record.shift_id),
    currentActual(db, record.outlet_id, record.business_date, record.shift_id),
  ])
  const reasons = staleness(record, expected, actual)
  if (reasons.length) {
    fail('A bound source fact changed; preserve this record and create a linked replacement', 'payment_reconciliation_source_drift', 409, { reasons })
  }
  return { expected, actual }
}

async function createDraft(request, env, { replacement = false } = {}) {
  const body = await readJson(request)
  rejectUnsupportedScope(body)
  rejectServerManaged(body)
  const capability = replacement ? 'payment_reconciliation.replace' : 'payment_reconciliation.enter_actuals'
  const user = await freshHuman(request, env, capability)
  const outletId = requireAssignedOutlet(user, body.outlet_id)
  const businessDate = requireDate(body.business_date)
  const shiftId = requirePhase(body.shift_id || 'night')
  const mutationId = requireMutationId(request, body)
  const action = replacement ? 'replace' : 'start'
  const requestFingerprint = await fingerprint(action, body)
  const db = database(env)
  const replay = await findMutation(db, mutationId, requestFingerprint)
  if (replay) return replay
  const logicalKey = `${outletId}|${businessDate}|${shiftId}`
  const rows = await reconciliationRows(db, logicalKey)
  let original = null
  if (replacement) {
    const originalId = normalizedText(body.original_reconciliation_id, 'original_reconciliation_id', { max: 200 })
    original = rows.find((record) => record.id === originalId) || null
    if (!original) fail('Original reconciliation was not found in this scope', 'payment_reconciliation_not_found', 404)
    if (rows[0]?.id !== original.id) {
      fail('A newer reconciliation or replacement already exists', 'payment_reconciliation_replacement_superseded', 409)
    }
  } else if (rows.length) {
    fail('A reconciliation already exists for this outlet/date/phase', 'payment_reconciliation_duplicate', 409)
  }
  const facts = await resolvedFacts(db, body, { outletId, businessDate, shiftId })
  const identity = factIdentity(facts.expected, facts.actual)
  const snapshots = factSnapshots(facts.expected, facts.actual)
  const replacementSequence = replacement ? Number(original.replacement_sequence || 0) + 1 : 0
  const rootId = replacement ? (original.root_reconciliation_id || original.id) : ''
  const reason = replacement
    ? normalizedText(body.replacement_reason, 'replacement_reason', { max: 1000 })
    : ''
  const identityDigest = await sha256(JSON.stringify(stableValue({ logicalKey, identity, replacementSequence })))
  const entityId = replacement
    ? `payment-reconciliation-replacement-${identityDigest.slice(0, 36)}`
    : `payment-reconciliation-${identityDigest.slice(0, 40)}`
  const audit = [actorEvidence(user, replacement ? 'create_linked_replacement' : 'enter_blind_actuals', mutationId)]
  const record = {
    id: entityId,
    authority_contract: CONTRACT,
    authority_role: 'authoritative_reconciliation_evidence',
    financial_mutation_authority: 'none',
    logical_key: logicalKey,
    root_reconciliation_id: rootId || entityId,
    replacement_of_id: original?.id || '',
    replacement_sequence: replacementSequence,
    replacement_reason: reason,
    outlet_id: outletId,
    business_date: businessDate,
    shift_id: shiftId,
    fact_identity: identity,
    fact_snapshots: snapshots,
    comparison: null,
    variance_remark: null,
    completion: null,
    entered_by: audit[0],
    audit,
    status: 'blind_entry',
  }
  return insertRecord(env, user, {
    entityId,
    outletId,
    businessDate,
    status: 'blind_entry',
    record,
    mutationId,
    operation: replacement ? 'payment_reconciliation_replace' : 'payment_reconciliation_enter_actuals',
    requestFingerprint,
    requestedAt: body.requested_at,
  })
}

async function lifecycleRecord(db, body, expectedStatus) {
  const id = normalizedText(body.reconciliation_id, 'reconciliation_id', { max: 200 })
  const { row, record } = await findRecord(db, RECONCILIATION_ENTITY, id)
  if (!row || record?.authority_contract !== CONTRACT) fail('Authoritative reconciliation was not found', 'payment_reconciliation_not_found', 404)
  if (record.status !== expectedStatus) {
    fail(`Reconciliation must be ${expectedStatus} for this command`, 'payment_reconciliation_lifecycle_conflict', 409, {
      required_status: expectedStatus,
      current_status: record.status,
    })
  }
  requireVersion(body, row)
  return { row, record }
}

async function reveal(request, env) {
  const body = await readJson(request)
  rejectUnsupportedScope(body)
  rejectServerManaged(body)
  const user = await freshHuman(request, env, 'payment_reconciliation.reveal')
  const mutationId = requireMutationId(request, body)
  const requestFingerprint = await fingerprint('reveal', body)
  const db = database(env)
  const replay = await findMutation(db, mutationId, requestFingerprint)
  if (replay) return replay
  const { row, record } = await lifecycleRecord(db, body, 'blind_entry')
  requireAssignedOutlet(user, record.outlet_id)
  const facts = await requireCurrentBoundFacts(db, record)
  const comparison = compareFacts(record.fact_snapshots.expected, record.fact_snapshots.actual)
  const event = actorEvidence(user, 'reveal_payment_differences', mutationId)
  const next = {
    ...bare(record),
    comparison,
    revealed_by: event,
    audit: [...(record.audit || []), event],
    status: 'differences_revealed',
    source_current_at_reveal: {
      expected_id: facts.expected.id,
      actual_id: facts.actual.id,
    },
  }
  return updateRecord(env, user, row, next, {
    status: 'differences_revealed', mutationId, operation: 'payment_reconciliation_reveal', requestFingerprint, requestedAt: body.requested_at,
  })
}

function normalizeEvidenceIds(value) {
  if (value == null) return []
  if (!Array.isArray(value) || value.length > 20) fail('evidence_ids must be an array with at most 20 entries', 'payment_reconciliation_evidence_invalid')
  return [...new Set(value.map((item) => normalizedText(item, 'evidence_id', { max: 200 })))]
}

async function remark(request, env) {
  const body = await readJson(request)
  rejectUnsupportedScope(body)
  rejectServerManaged(body)
  const user = await freshHuman(request, env, 'payment_reconciliation.remark')
  const mutationId = requireMutationId(request, body)
  const requestFingerprint = await fingerprint('remark', body)
  const db = database(env)
  const replay = await findMutation(db, mutationId, requestFingerprint)
  if (replay) return replay
  const { row, record } = await lifecycleRecord(db, body, 'differences_revealed')
  requireAssignedOutlet(user, record.outlet_id)
  await requireCurrentBoundFacts(db, record)
  const allMatched = record.comparison?.all_matched === true
  const classification = normalizedText(body.classification, 'classification', { max: 80 }).toLowerCase()
  const allowed = allMatched
    ? new Set(['matched'])
    : new Set(['explained_discrepancy', 'unresolved_exception'])
  if (!allowed.has(classification)) {
    fail(
      allMatched ? 'A zero-difference reconciliation must be classified as matched' : 'A discrepancy must be classified as explained_discrepancy or unresolved_exception',
      'payment_reconciliation_classification_invalid',
    )
  }
  const reason = normalizedText(body.reason, 'reason', { max: 1000 })
  const event = actorEvidence(user, 'record_variance_remarks', mutationId)
  const next = {
    ...bare(record),
    variance_remark: {
      classification,
      reason,
      evidence_ids: normalizeEvidenceIds(body.evidence_ids),
      recorded_by: event,
    },
    audit: [...(record.audit || []), event],
    status: 'remarks_complete',
  }
  return updateRecord(env, user, row, next, {
    status: 'remarks_complete', mutationId, operation: 'payment_reconciliation_remark', requestFingerprint, requestedAt: body.requested_at,
  })
}

async function submit(request, env) {
  const body = await readJson(request)
  rejectUnsupportedScope(body)
  rejectServerManaged(body)
  const user = await freshHuman(request, env, 'payment_reconciliation.submit')
  const mutationId = requireMutationId(request, body)
  const requestFingerprint = await fingerprint('submit', body)
  const db = database(env)
  const replay = await findMutation(db, mutationId, requestFingerprint)
  if (replay) return replay
  const { row, record } = await lifecycleRecord(db, body, 'remarks_complete')
  requireAssignedOutlet(user, record.outlet_id)
  await requireCurrentBoundFacts(db, record)
  if (record.comparison?.all_matched !== true && record.variance_remark?.classification !== 'explained_discrepancy') {
    fail('An unresolved discrepancy cannot complete reconciliation', 'payment_reconciliation_discrepancy_unresolved', 409)
  }
  const event = actorEvidence(user, 'submit_payment_reconciliation', mutationId)
  const next = {
    ...bare(record),
    submitted_by: event,
    completion: {
      complete: true,
      fact: 'submitted_reconciliation_retains_expected_source_actual_evidence_remarks_and_correction_identity',
      completed_at: event.accepted_at,
      financial_truth_changed: false,
      payment_created: false,
      payment_allocation_changed: false,
      supplier_invoice_outstanding_changed: false,
      accounting_journal_created: false,
      cash_close_changed: false,
    },
    audit: [...(record.audit || []), event],
    status: 'submitted',
  }
  return updateRecord(env, user, row, next, {
    status: 'submitted', mutationId, operation: 'payment_reconciliation_submit', requestFingerprint, requestedAt: body.requested_at,
  })
}

async function readContext(request, env, url) {
  const user = await freshHuman(request, env, 'payment_reconciliation.enter_actuals')
  rejectUnsupportedScope(Object.fromEntries(url.searchParams))
  const outletId = requireAssignedOutlet(user, url.searchParams.get('outlet_id'))
  const businessDate = requireDate(url.searchParams.get('business_date'))
  const shiftId = requirePhase(url.searchParams.get('shift_id') || 'night')
  const db = database(env)
  const logicalKey = `${outletId}|${businessDate}|${shiftId}`
  const [expected, actual, history] = await Promise.all([
    latestExpected(db, outletId, businessDate, shiftId),
    currentActual(db, outletId, businessDate, shiftId),
    reconciliationRows(db, logicalKey),
  ])
  const current = history[0] || null
  const staleReasons = current ? staleness(current, expected, actual) : []
  const historicalComplete = current?.status === 'submitted' && current?.completion?.complete === true
  return {
    ok: true,
    authority: 'cloudflare_d1',
    authority_contract: CONTRACT,
    authority_role: 'authoritative_reconciliation_evidence_only',
    financial_mutation_authority: 'none',
    scope: { outlet_id: outletId, business_date: businessDate, shift_id: shiftId },
    expected_basis: expected,
    actual_fact: actual,
    current_reconciliation: current,
    history,
    source_drift: staleReasons.length > 0,
    stale_reasons: staleReasons,
    completion: {
      complete: historicalComplete && staleReasons.length === 0,
      historical_complete: historicalComplete,
      fact: historicalComplete ? current.completion.fact : '',
      reconciliation_id: historicalComplete ? current.id : '',
    },
    payment_authority: 'statvara_core_canonical_payment_only',
    payment_allocation_authority: 'statvara_core_only',
    cash_close_authority: 'cloudflare_d1_independent_record_family',
    sheet_role: 'mirror_or_report_only_not_completion_authority',
    offline_authority: 'none_until_server_reauthorization_and_d1_commit',
  }
}

export async function handlePaymentReconciliationApi(request, env, url) {
  if (!url.pathname.startsWith('/api/payment-reconciliation')) return null
  try {
    if (url.pathname === '/api/payment-reconciliation/context' && request.method === 'GET') {
      return json(request, env, await readContext(request, env, url))
    }
    if (url.pathname === '/api/payment-reconciliation/start' && request.method === 'POST') {
      return json(request, env, await createDraft(request, env), 201)
    }
    if (url.pathname === '/api/payment-reconciliation/reveal' && request.method === 'POST') {
      return json(request, env, await reveal(request, env))
    }
    if (url.pathname === '/api/payment-reconciliation/remark' && request.method === 'POST') {
      return json(request, env, await remark(request, env))
    }
    if (url.pathname === '/api/payment-reconciliation/submit' && request.method === 'POST') {
      return json(request, env, await submit(request, env))
    }
    if (url.pathname === '/api/payment-reconciliation/replace' && request.method === 'POST') {
      return json(request, env, await createDraft(request, env, { replacement: true }), 201)
    }
    fail('Payment Reconciliation endpoint or method is not supported', 'payment_reconciliation_route_not_found', 404)
  } catch (error) {
    return errorResponse(request, env, error)
  }
}

export const paymentReconciliationDomain = {
  CONTRACT,
  RECONCILIATION_ENTITY,
  compareFacts,
  fingerprint,
  money,
  parseCents,
}
