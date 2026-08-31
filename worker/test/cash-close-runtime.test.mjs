import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { createSession } from '../src/auth.js'
import { handleCashCloseApi } from '../src/cash-close-d1.js'
import { handleD1CloseUpUpsert } from '../src/realtime-closeup-upsert-d1.js'
import { handleRealtimeDataApi } from '../src/realtime-store.js'
import { withSubmissionLock } from '../src/submission-locks.js'

function literal(value) {
  if (value === null || value === undefined) return 'NULL'
  if (typeof value === 'number') return String(value)
  return `'${String(value).replaceAll("'", "''")}'`
}

function bindSql(sql, values) {
  let index = 0
  return String(sql).replace(/\?/g, () => {
    if (index >= values.length) throw new Error('Missing SQL binding')
    return literal(values[index++])
  })
}

function jsonRows(output) {
  const text = String(output || '').trim()
  if (!text) return []
  return JSON.parse(text)
}

class SqliteStatement {
  constructor(database, sql, values = []) {
    this.database = database
    this.sql = sql
    this.values = values
  }

  bind(...values) { return new SqliteStatement(this.database, this.sql, values) }
  compiled() { return bindSql(this.sql, this.values) }
  async first() { return (await this.all()).results[0] || null }
  async all() { return { results: this.database.query(this.compiled()) } }
  async run() {
    const rows = this.database.query(`${this.compiled()}; SELECT changes() AS changes`)
    const changes = Number(rows.at(-1)?.changes || 0)
    return { changes, meta: { changes } }
  }
}

class SqliteD1 {
  constructor(filename) { this.filename = filename }
  prepare(sql) { return new SqliteStatement(this, sql) }
  execute(sql) {
    const result = spawnSync('sqlite3', [this.filename], { input: sql, encoding: 'utf8' })
    if (result.status !== 0) throw new Error(result.stderr || `sqlite3 exited ${result.status}`)
  }
  query(sql) {
    const result = spawnSync('sqlite3', ['-json', this.filename, sql], { encoding: 'utf8' })
    if (result.status !== 0) throw new Error(result.stderr || `sqlite3 exited ${result.status}`)
    return jsonRows(result.stdout)
  }
  async batch(statements) {
    this.execute(`BEGIN IMMEDIATE;\n${statements.map((statement) => `${statement.compiled()};`).join('\n')}\nCOMMIT;`)
    return statements.map(() => ({ success: true, meta: { changes: 1 } }))
  }
}

const tempDirectory = mkdtempSync(join(tmpdir(), 'statvara-cash-close-'))
const databaseFile = join(tempDirectory, 'ops.sqlite')
const db = new SqliteD1(databaseFile)
const queueMessages = []
const waitUntilPromises = []
const env = {
  OPS_DB: db,
  SESSION_SECRET: 'session-secret-012345678901234567890123456789',
  CASH_EXPECTED_BRIDGE_SECRET: 'cash-bridge-secret-012345678901234567890123',
  ALLOWED_ORIGINS: 'https://example.test',
  SHEET_SYNC_QUEUE: {
    async send(message) {
      queueMessages.push(message)
      throw new Error('simulated Sheet mirror outage')
    },
  },
}
const ctx = { waitUntil(promise) { waitUntilPromises.push(Promise.resolve(promise)) } }
const runEnv = Object.create(env)
Object.defineProperty(runEnv, '__CHEFOPS_CTX', { value: ctx, enumerable: false })

db.execute(readFileSync(new URL('../migrations/0001_realtime_core.sql', import.meta.url), 'utf8'))
db.execute(readFileSync(new URL('../migrations/0002_submission_locks.sql', import.meta.url), 'utf8'))

const users = {
  staff: { id: 'u-staff', email: 'staff@example.test', full_name: 'Staff One', role: 'staff', status: 'active', outlet_id: 'RR-KCH', outlet_ids: '["RR-KCH"]', principal_type: 'human' },
  reviewer: { id: 'u-review', email: 'review@example.test', full_name: 'Reviewer One', role: 'supervisor', status: 'active', outlet_id: 'RR-KCH', outlet_ids: '["RR-KCH"]', principal_type: 'human' },
  reviewer2: { id: 'u-review-2', email: 'review2@example.test', full_name: 'Reviewer Two', role: 'manager', status: 'active', outlet_id: 'RR-KCH', outlet_ids: '["RR-KCH"]', principal_type: 'human' },
  outsider: { id: 'u-outsider', email: 'outside@example.test', full_name: 'Outside Owner', role: 'owner', status: 'active', outlet_id: 'OTHER', outlet_ids: '["OTHER"]', principal_type: 'human' },
  service: { id: 'u-service', email: 'service@example.test', full_name: 'Cash Service', role: 'supervisor', status: 'active', outlet_id: 'RR-KCH', outlet_ids: '["RR-KCH"]', principal_type: 'service' },
  accessAdmin: { id: 'u-access', email: 'access@example.test', full_name: 'Access Admin', role: 'access_admin', status: 'active', outlet_id: 'RR-KCH', outlet_ids: '["RR-KCH"]', principal_type: 'human', capabilities_json: '[]' },
}

for (const user of Object.values(users)) {
  const timestamp = new Date().toISOString()
  db.prepare(`
    INSERT INTO ops_records (
      entity, entity_id, outlet_id, business_date, status, payload_json,
      version, created_at, created_by, updated_at, updated_by, deleted_at
    ) VALUES ('User', ?, ?, '', ?, ?, 1, ?, 'seed', ?, 'seed', '')
  `).bind(user.id, user.outlet_id, user.status, JSON.stringify(user), timestamp, timestamp).run()
}

const tokens = Object.fromEntries(await Promise.all(Object.entries(users).map(async ([key, user]) => [
  key,
  await createSession(user, env),
])))
tokens.unprovisioned = await createSession({
  id: 'u-unprovisioned',
  email: 'unprovisioned@example.test',
  role: 'staff',
  status: 'active',
  outlet_id: 'RR-KCH',
  outlet_ids: '["RR-KCH"]',
  principal_type: 'human',
}, env)

function authHeaders(actor, extras = {}) {
  return { Authorization: `Bearer ${tokens[actor]}`, Origin: 'https://example.test', ...extras }
}

async function call(path, { actor, method = 'GET', body, headers = {} } = {}) {
  const requestHeaders = new Headers(actor ? authHeaders(actor, headers) : { Origin: 'https://example.test', ...headers })
  if (body !== undefined) requestHeaders.set('Content-Type', 'application/json')
  const request = new Request(`https://example.test${path}`, {
    method,
    headers: requestHeaders,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const url = new URL(request.url)
  let response
  if (path.startsWith('/api/cash-close')) {
    response = ['/api/cash-close/submit', '/api/cash-close/review', '/api/cash-close/correct'].includes(url.pathname)
      ? await withSubmissionLock(request, runEnv, url, () => handleCashCloseApi(request, runEnv, url))
      : await handleCashCloseApi(request, runEnv, url)
  } else if (url.pathname === '/api/close-up/upsert') {
    response = await handleD1CloseUpUpsert(request, runEnv, url)
  } else if (url.pathname.startsWith('/api/realtime/')) {
    response = await handleRealtimeDataApi(request, runEnv, url)
  } else {
    throw new Error(`Test route is not wired: ${url.pathname}`)
  }
  const data = await response.json().catch(() => ({}))
  return { response, data }
}

async function expected({
  date = '2026-08-31', expectedCash = '100.00', expectedChannels = { duitnow: '20.00' },
  snapshot = 'snapshot-a', observedAt = '2026-08-31T14:00:00.000Z', mutation = `expected:${snapshot}`,
} = {}) {
  const body = {
    mutation_id: mutation,
    provider: 'feedme',
    outlet_id: 'RR-KCH',
    business_date: date,
    shift_id: 'night',
    expected_cash: expectedCash,
    expected_channels: expectedChannels,
    business_id: 'feedme-business-1',
    report_id: '63e368a60000000000000000',
    outlet_external_id: 'feedme-outlet-6960',
    snapshot_id: snapshot,
    source_version: 'FeedMe Insights 7.2.27',
    watermark: `${date}:payment-breakdown:v1`,
    observed_at: observedAt,
  }
  const raw = JSON.stringify(body)
  const timestamp = new Date().toISOString()
  const signature = createHmac('sha256', env.CASH_EXPECTED_BRIDGE_SECRET).update(`${timestamp}.${raw}`).digest('hex')
  const request = new Request('https://example.test/api/cash-close/expected', {
    method: 'POST',
    headers: {
      Origin: 'https://example.test',
      'Content-Type': 'application/json',
      'X-Statvara-Cash-Timestamp': timestamp,
      'X-Statvara-Cash-Signature': signature,
    },
    body: raw,
  })
  const response = await handleCashCloseApi(request, runEnv, new URL(request.url))
  return { response, data: await response.json() }
}

function submitBody(basis, overrides = {}) {
  return {
    mutation_id: 'close:submit:a',
    outlet_id: 'RR-KCH',
    business_date: '2026-08-31',
    shift_id: 'night',
    expected_basis_id: basis.record.id,
    expected_basis_digest: basis.record.source_digest,
    denominations: { 50: '1', 20: '2', 10: '0', 5: '0', 1: '0', 0.5: '0', 0.2: '0', 0.1: '0', 0.05: '0', 100: '0' },
    actual_channels: { duitnow: '20.00' },
    variance_reason: 'RM10 counted shortage retained for supervisor review',
    ...overrides,
  }
}

test.after(async () => {
  await Promise.allSettled(waitUntilPromises)
  rmSync(tempDirectory, { recursive: true, force: true })
})

test('real Worker path closes LOOP-029 and preserves immutable correction history', async () => {
  const noAuth = await call('/api/cash-close/submit', { method: 'POST', body: {} })
  assert.equal(noAuth.response.status, 401)

  const invalidSignature = await call('/api/cash-close/expected', {
    method: 'POST',
    headers: { 'X-Statvara-Cash-Timestamp': new Date().toISOString(), 'X-Statvara-Cash-Signature': '00'.repeat(32) },
    body: { provider: 'feedme' },
  })
  assert.equal(invalidSignature.response.status, 401)

  const basisA = await expected()
  assert.equal(basisA.response.status, 202)
  assert.equal(basisA.data.record.authority_role, 'external_input')

  const unprovisioned = await call('/api/cash-close/submit', {
    actor: 'unprovisioned', method: 'POST', body: submitBody(basisA.data, { mutation_id: 'unprovisioned' }),
  })
  assert.equal(unprovisioned.response.status, 403)
  assert.equal(unprovisioned.data.code, 'user_inactive')

  const wrongCompany = await call('/api/cash-close/submit', {
    actor: 'staff', method: 'POST', body: submitBody(basisA.data, { mutation_id: 'wrong-company', company_id: 'OTHER-COMPANY' }),
  })
  assert.equal(wrongCompany.response.status, 400)
  assert.equal(wrongCompany.data.code, 'cash_close_scope_dimension_unsupported')

  const forgedCustodian = await call('/api/cash-close/submit', {
    actor: 'staff', method: 'POST', body: submitBody(basisA.data, { mutation_id: 'forged-custodian', custodian_user_id: users.reviewer.id }),
  })
  assert.equal(forgedCustodian.response.status, 403)
  assert.equal(forgedCustodian.data.code, 'cash_close_custodian_forged')

  for (const [field, value] of [['expected_cash', '0.00'], ['actual_total', '0.00'], ['cash_variance', '0.00']]) {
    const forged = await call('/api/cash-close/submit', {
      actor: 'staff', method: 'POST', body: submitBody(basisA.data, { mutation_id: `forged-${field}`, [field]: value }),
    })
    assert.equal(forged.response.status, 400)
    assert.equal(forged.data.code, 'cash_close_server_managed_field')
  }

  const negative = await call('/api/cash-close/submit', {
    actor: 'staff', method: 'POST', body: submitBody(basisA.data, { mutation_id: 'negative', denominations: { 100: '-1' } }),
  })
  assert.equal(negative.response.status, 400)
  assert.equal(negative.data.code, 'cash_close_denomination_quantity_invalid')

  const unsupported = await call('/api/cash-close/submit', {
    actor: 'staff', method: 'POST', body: submitBody(basisA.data, { mutation_id: 'unsupported', denominations: { 2: '1' } }),
  })
  assert.equal(unsupported.response.status, 400)
  assert.equal(unsupported.data.code, 'cash_close_denomination_unsupported')

  const crossOutlet = await call('/api/cash-close/submit', {
    actor: 'outsider', method: 'POST', body: submitBody(basisA.data, { mutation_id: 'cross-outlet' }),
  })
  assert.equal(crossOutlet.response.status, 403)
  assert.equal(crossOutlet.data.code, 'wrong_outlet')

  const accessAdmin = await call('/api/cash-close/submit', {
    actor: 'accessAdmin', method: 'POST', body: submitBody(basisA.data, { mutation_id: 'access-admin' }),
  })
  assert.equal(accessAdmin.response.status, 403)
  assert.equal(accessAdmin.data.code, 'cash_close_capability_required')

  const submitted = await call('/api/cash-close/submit', {
    actor: 'staff', method: 'POST', body: submitBody(basisA.data),
  })
  assert.equal(submitted.response.status, 201)
  assert.equal(submitted.data.record.actual_cash, '90.00')
  assert.equal(submitted.data.record.cash_variance, '-10.00')
  assert.equal(submitted.data.record.total_variance, '-10.00')
  assert.equal(submitted.data.record.custody.custodian_user_id, users.staff.id)
  assert.equal(submitted.data.record.status, 'submitted')

  const replay = await call('/api/cash-close/submit', {
    actor: 'staff', method: 'POST', body: submitBody(basisA.data),
  })
  assert.equal(replay.response.status, 201)
  assert.equal(replay.data.replayed, true)
  assert.equal(replay.data.entity_id, submitted.data.entity_id)

  const changedReplay = await call('/api/cash-close/submit', {
    actor: 'staff', method: 'POST', body: submitBody(basisA.data, { actual_channels: { duitnow: '21.00' } }),
  })
  assert.equal(changedReplay.response.status, 409)
  assert.equal(changedReplay.data.code, 'cash_close_mutation_fingerprint_mismatch')

  const duplicate = await call('/api/cash-close/submit', {
    actor: 'staff', method: 'POST', body: submitBody(basisA.data, { mutation_id: 'close:submit:duplicate' }),
  })
  assert.equal(duplicate.response.status, 409)
  assert.equal(duplicate.data.code, 'cash_close_duplicate')

  const foreignClose = await call('/api/cash-close/review', {
    actor: 'reviewer', method: 'POST', body: { mutation_id: 'review:foreign', close_id: 'foreign-close-id', outlet_id: 'RR-KCH', decision: 'accept', reason: 'not found' },
  })
  assert.equal(foreignClose.response.status, 404)
  assert.equal(foreignClose.data.code, 'cash_close_not_found')

  const selfReview = await call('/api/cash-close/review', {
    actor: 'staff', method: 'POST', body: { mutation_id: 'review:self', close_id: submitted.data.entity_id, outlet_id: 'RR-KCH', decision: 'accept', reason: 'self' },
  })
  assert.equal(selfReview.response.status, 403)

  const serviceReview = await call('/api/cash-close/review', {
    actor: 'service', method: 'POST', body: { mutation_id: 'review:service', close_id: submitted.data.entity_id, outlet_id: 'RR-KCH', decision: 'accept', reason: 'service' },
  })
  assert.equal(serviceReview.response.status, 403)
  assert.equal(serviceReview.data.code, 'cash_close_human_required')

  const accepted = await call('/api/cash-close/review', {
    actor: 'reviewer', method: 'POST', body: { mutation_id: 'review:accept:a', close_id: submitted.data.entity_id, outlet_id: 'RR-KCH', decision: 'accept', reason: 'Shortage explained and accepted' },
  })
  assert.equal(accepted.response.status, 200)
  assert.equal(accepted.data.record.status, 'completed')
  assert.equal(accepted.data.record.total_variance, '-10.00')
  const originalBeforeCorrection = JSON.stringify(accepted.data.record)

  const basisB = await expected({ expectedCash: '110.00', snapshot: 'snapshot-b', observedAt: '2026-08-31T15:00:00.000Z' })
  assert.equal(basisB.response.status, 202)
  const driftContext = await call('/api/cash-close/context?outlet_id=RR-KCH&business_date=2026-08-31&shift_id=night', { actor: 'reviewer' })
  assert.equal(driftContext.response.status, 200)
  assert.equal(driftContext.data.expected_drift, true)
  assert.equal(driftContext.data.current_close.expected_basis_id, basisA.data.record.id)
  assert.equal(driftContext.data.current_close.total_variance, '-10.00')

  const unauthorizedCorrection = await call('/api/cash-close/correct', {
    actor: 'staff', method: 'POST', body: {
      ...submitBody(basisB.data, { mutation_id: 'correct:unauthorized', expected_basis_id: basisB.data.record.id, expected_basis_digest: basisB.data.record.source_digest }),
      original_close_id: accepted.data.entity_id,
      correction_reason: 'Not allowed',
    },
  })
  assert.equal(unauthorizedCorrection.response.status, 403)

  const correction = await call('/api/cash-close/correct', {
    actor: 'reviewer', method: 'POST', body: {
      ...submitBody(basisB.data, {
        mutation_id: 'correct:a',
        expected_basis_id: basisB.data.record.id,
        expected_basis_digest: basisB.data.record.source_digest,
        denominations: { 100: '1', 5: '1', 50: '0', 20: '0', 10: '0', 1: '0', 0.5: '0', 0.2: '0', 0.1: '0', 0.05: '0' },
        variance_reason: 'Corrected count remains RM5 short',
      }),
      original_close_id: accepted.data.entity_id,
      correction_reason: 'Supervisor recount found RM15 more than original count',
    },
  })
  assert.equal(correction.response.status, 201)
  assert.equal(correction.data.record.correction_of_id, accepted.data.entity_id)
  assert.equal(correction.data.record.actual_cash, '105.00')
  assert.equal(correction.data.record.total_variance, '-5.00')

  const correctionAccepted = await call('/api/cash-close/review', {
    actor: 'reviewer2', method: 'POST', body: { mutation_id: 'review:correction', close_id: correction.data.entity_id, outlet_id: 'RR-KCH', decision: 'accept', reason: 'Correction evidence reviewed' },
  })
  assert.equal(correctionAccepted.response.status, 200)
  assert.equal(correctionAccepted.data.record.status, 'completed')

  const finalContext = await call('/api/cash-close/context?outlet_id=RR-KCH&business_date=2026-08-31&shift_id=night', { actor: 'reviewer2' })
  assert.equal(finalContext.data.current_close.id, correction.data.entity_id)
  assert.equal(finalContext.data.completion.complete, true)
  assert.equal(finalContext.data.history.length, 2)
  const originalAfterCorrection = finalContext.data.history.find((row) => row.id === accepted.data.entity_id)
  assert.equal(JSON.stringify({ ...originalAfterCorrection, mirror: undefined, __realtime: undefined }), JSON.stringify({ ...JSON.parse(originalBeforeCorrection), mirror: undefined, __realtime: undefined }))

  const legacy = await call('/api/close-up/upsert', {
    actor: 'staff', method: 'POST', body: { mutation_id: 'legacy-night', outlet_id: 'RR-KCH', business_date: '2026-09-01', shift_id: 'night' },
  })
  assert.equal(legacy.response.status, 409)
  assert.equal(legacy.data.code, 'cash_close_v1_required')

  const generic = await call('/api/realtime/mutations', {
    actor: 'staff', method: 'POST', body: { mutation_id: 'generic-night', entity: 'CloseUp', entity_id: 'bypass', outlet_id: 'RR-KCH', operation: 'create', payload: { id: 'bypass', outlet_id: 'RR-KCH', business_date: '2026-09-01', shift_id: 'night' } },
  })
  assert.equal(generic.response.status, 409)
  assert.equal(generic.data.code, 'cash_close_v1_required')

  const entrySource = readFileSync(new URL('../src/entry.js', import.meta.url), 'utf8')
  assert.match(entrySource, /legacyCloseUpMutationBlocked/)
  assert.match(entrySource, /cash_close_command_api_required/)

  assert.ok(queueMessages.length >= 5)
  const authorityBeforeMirrorRetry = db.query("SELECT payload_json FROM ops_records WHERE entity = 'CloseUp' AND entity_id = " + literal(correction.data.entity_id))[0].payload_json
  db.prepare("UPDATE sheet_sync_outbox SET status = 'failed', attempts = attempts + 1, last_error = 'manual Sheet failure' WHERE entity = 'CloseUp'").run()
  const authorityAfterMirrorRetry = db.query("SELECT payload_json FROM ops_records WHERE entity = 'CloseUp' AND entity_id = " + literal(correction.data.entity_id))[0].payload_json
  assert.equal(authorityAfterMirrorRetry, authorityBeforeMirrorRetry)

  const businessEntities = db.query("SELECT DISTINCT entity FROM ops_records WHERE entity NOT IN ('User') ORDER BY entity").map((row) => row.entity)
  assert.deepEqual(businessEntities, ['CashExpectedBasis', 'CloseUp'])
  assert.equal(db.query("SELECT COUNT(*) AS count FROM ops_records WHERE entity IN ('SupplierPayment','PaymentAllocation','SupplierInvoice','JournalEntry')")[0].count, 0)
})

test('acceptance-time reauthorization rejects revoked, disabled and service principals', async () => {
  const basis = await expected({ date: '2026-09-02', snapshot: 'snapshot-reauth', observedAt: '2026-09-02T14:00:00.000Z' })
  assert.equal(basis.response.status, 202)
  const body = submitBody(basis.data, {
    mutation_id: 'reauth:queued',
    business_date: '2026-09-02',
    expected_basis_id: basis.data.record.id,
    expected_basis_digest: basis.data.record.source_digest,
  })

  const revoked = { ...users.staff, capabilities_json: '[]' }
  db.prepare("UPDATE ops_records SET payload_json = ?, version = version + 1 WHERE entity = 'User' AND entity_id = ?").bind(JSON.stringify(revoked), users.staff.id).run()
  const revokedResponse = await call('/api/cash-close/submit', { actor: 'staff', method: 'POST', body })
  assert.equal(revokedResponse.response.status, 403)
  assert.equal(revokedResponse.data.code, 'cash_close_capability_required')

  const disabled = { ...users.staff, status: 'inactive' }
  db.prepare("UPDATE ops_records SET payload_json = ?, status = 'inactive', version = version + 1 WHERE entity = 'User' AND entity_id = ?").bind(JSON.stringify(disabled), users.staff.id).run()
  const disabledResponse = await call('/api/cash-close/submit', { actor: 'staff', method: 'POST', body: { ...body, mutation_id: 'reauth:disabled' } })
  assert.equal(disabledResponse.response.status, 403)
  assert.equal(disabledResponse.data.code, 'user_inactive')

  const removedOutlet = { ...users.staff, outlet_id: 'OTHER', outlet_ids: '["OTHER"]' }
  db.prepare("UPDATE ops_records SET payload_json = ?, outlet_id = 'OTHER', status = 'active', version = version + 1 WHERE entity = 'User' AND entity_id = ?").bind(JSON.stringify(removedOutlet), users.staff.id).run()
  const removedOutletResponse = await call('/api/cash-close/submit', { actor: 'staff', method: 'POST', body: { ...body, mutation_id: 'reauth:removed-outlet' } })
  assert.equal(removedOutletResponse.response.status, 403)
  assert.equal(removedOutletResponse.data.code, 'wrong_outlet')

  db.prepare("UPDATE ops_records SET payload_json = ?, status = 'active', version = version + 1 WHERE entity = 'User' AND entity_id = ?").bind(JSON.stringify(users.staff), users.staff.id).run()
  const serviceResponse = await call('/api/cash-close/submit', { actor: 'service', method: 'POST', body: { ...body, mutation_id: 'reauth:service' } })
  assert.equal(serviceResponse.response.status, 403)
  assert.equal(serviceResponse.data.code, 'cash_close_human_required')
})

test('submission and review races have one deterministic authoritative winner', async () => {
  const basis = await expected({ date: '2026-09-03', snapshot: 'snapshot-race', observedAt: '2026-09-03T14:00:00.000Z' })
  const base = submitBody(basis.data, {
    business_date: '2026-09-03',
    expected_basis_id: basis.data.record.id,
    expected_basis_digest: basis.data.record.source_digest,
  })
  const [left, right] = await Promise.all([
    call('/api/cash-close/submit', { actor: 'staff', method: 'POST', body: { ...base, mutation_id: 'race:submit:left' } }),
    call('/api/cash-close/submit', { actor: 'staff', method: 'POST', body: { ...base, mutation_id: 'race:submit:right' } }),
  ])
  assert.deepEqual([left.response.status, right.response.status].sort(), [201, 423])
  const winner = left.response.status === 201 ? left : right
  const lockedSubmission = left.response.status === 423 ? left : right
  const retryAfterLock = await call('/api/cash-close/submit', {
    actor: 'staff', method: 'POST', body: { ...base, mutation_id: lockedSubmission === left ? 'race:submit:left' : 'race:submit:right' },
  })
  assert.equal(retryAfterLock.response.status, 409)
  assert.equal(retryAfterLock.data.code, 'cash_close_duplicate')
  const [accept, reject] = await Promise.all([
    call('/api/cash-close/review', { actor: 'reviewer', method: 'POST', body: { mutation_id: 'race:review:accept', close_id: winner.data.entity_id, outlet_id: 'RR-KCH', decision: 'accept', reason: 'accepted' } }),
    call('/api/cash-close/review', { actor: 'reviewer2', method: 'POST', body: { mutation_id: 'race:review:reject', close_id: winner.data.entity_id, outlet_id: 'RR-KCH', decision: 'reject', reason: 'rejected' } }),
  ])
  assert.deepEqual([accept.response.status, reject.response.status].sort(), [200, 423])
  const lockedReview = accept.response.status === 423 ? accept : reject
  const retryReview = await call('/api/cash-close/review', {
    actor: lockedReview === accept ? 'reviewer' : 'reviewer2',
    method: 'POST',
    body: lockedReview === accept
      ? { mutation_id: 'race:review:accept', close_id: winner.data.entity_id, outlet_id: 'RR-KCH', decision: 'accept', reason: 'accepted' }
      : { mutation_id: 'race:review:reject', close_id: winner.data.entity_id, outlet_id: 'RR-KCH', decision: 'reject', reason: 'rejected' },
  })
  assert.equal(retryReview.response.status, 409)
  assert.equal(retryReview.data.code, 'cash_close_lifecycle_conflict')
  const rows = db.query(`SELECT status, COUNT(*) AS count FROM ops_records WHERE entity = 'CloseUp' AND business_date = '2026-09-03' GROUP BY status`)
  assert.equal(rows.reduce((sum, row) => sum + Number(row.count), 0), 1)
})
