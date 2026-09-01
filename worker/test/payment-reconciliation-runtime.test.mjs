import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { createSession } from '../src/auth.js'
import { handleCashCloseApi } from '../src/cash-close-d1.js'
import { handlePaymentReconciliationApi } from '../src/payment-reconciliation-d1.js'
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
  return text ? JSON.parse(text) : []
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
    return statements.map(() => ({ success: true, changes: 1, meta: { changes: 1 } }))
  }
}

const tempDirectory = mkdtempSync(join(tmpdir(), 'statvara-payment-reconciliation-'))
const databaseFile = join(tempDirectory, 'ops.sqlite')
const db = new SqliteD1(databaseFile)
const env = {
  OPS_DB: db,
  SESSION_SECRET: 'session-secret-012345678901234567890123456789',
  CASH_EXPECTED_BRIDGE_SECRET: 'cash-bridge-secret-012345678901234567890123',
  ALLOWED_ORIGINS: 'https://example.test',
}

db.execute(readFileSync(new URL('../migrations/0001_realtime_core.sql', import.meta.url), 'utf8'))
db.execute(readFileSync(new URL('../migrations/0002_submission_locks.sql', import.meta.url), 'utf8'))

const users = {
  staff: { id: 'u-staff', email: 'staff@example.test', full_name: 'Staff One', role: 'staff', status: 'active', outlet_id: 'RR-KCH', outlet_ids: '["RR-KCH"]', principal_type: 'human' },
  supervisor: { id: 'u-supervisor', email: 'supervisor@example.test', full_name: 'Supervisor One', role: 'supervisor', status: 'active', outlet_id: 'RR-KCH', outlet_ids: '["RR-KCH"]', principal_type: 'human' },
  manager: { id: 'u-manager', email: 'manager@example.test', full_name: 'Manager One', role: 'manager', status: 'active', outlet_id: 'RR-KCH', outlet_ids: '["RR-KCH"]', principal_type: 'human' },
  outsider: { id: 'u-outsider', email: 'outside@example.test', full_name: 'Outside Owner', role: 'owner', status: 'active', outlet_id: 'OTHER', outlet_ids: '["OTHER"]', principal_type: 'human' },
  service: { id: 'u-service', email: 'service@example.test', full_name: 'Reconciliation Service', role: 'supervisor', status: 'active', outlet_id: 'RR-KCH', outlet_ids: '["RR-KCH"]', principal_type: 'service' },
  accessAdmin: { id: 'u-access', email: 'access@example.test', full_name: 'Access Admin', role: 'access_admin', status: 'active', outlet_id: 'RR-KCH', outlet_ids: '["RR-KCH"]', principal_type: 'human', capabilities_json: '[]' },
}

for (const user of Object.values(users)) {
  const timestamp = new Date().toISOString()
  await db.prepare(`
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
  id: 'u-unprovisioned', email: 'unprovisioned@example.test', role: 'staff', status: 'active',
  outlet_id: 'RR-KCH', outlet_ids: '["RR-KCH"]', principal_type: 'human',
}, env)

function authHeaders(actor, extras = {}) {
  return { Authorization: `Bearer ${tokens[actor]}`, Origin: 'https://example.test', 'X-ChefOps-Client-Id': `client-${actor}`, ...extras }
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
      ? await withSubmissionLock(request, env, url, () => handleCashCloseApi(request, env, url))
      : await handleCashCloseApi(request, env, url)
  } else if (path.startsWith('/api/payment-reconciliation')) {
    response = url.pathname === '/api/payment-reconciliation/context'
      ? await handlePaymentReconciliationApi(request, env, url)
      : await withSubmissionLock(request, env, url, () => handlePaymentReconciliationApi(request, env, url))
  } else {
    throw new Error(`Test route is not wired: ${url.pathname}`)
  }
  const data = await response.json().catch(() => ({}))
  return { response, data }
}

async function expected({
  expectedCash = '100.00', expectedChannels = { duitnow: '20.00' }, snapshot = 'snapshot-a',
  observedAt = '2026-09-01T14:00:00.000Z', mutation = `expected:${snapshot}`,
} = {}) {
  const body = {
    mutation_id: mutation,
    provider: 'feedme',
    outlet_id: 'RR-KCH',
    business_date: '2026-09-01',
    shift_id: 'night',
    expected_cash: expectedCash,
    expected_channels: expectedChannels,
    business_id: 'feedme-business-1',
    report_id: '63e368a60000000000000000',
    outlet_external_id: 'feedme-outlet-6960',
    snapshot_id: snapshot,
    source_version: 'FeedMe Insights 7.2.27',
    watermark: `2026-09-01:payment-breakdown:${snapshot}`,
    observed_at: observedAt,
  }
  const raw = JSON.stringify(body)
  const timestamp = new Date().toISOString()
  const signature = createHmac('sha256', env.CASH_EXPECTED_BRIDGE_SECRET).update(`${timestamp}.${raw}`).digest('hex')
  const request = new Request('https://example.test/api/cash-close/expected', {
    method: 'POST',
    headers: {
      Origin: 'https://example.test', 'Content-Type': 'application/json',
      'X-Statvara-Cash-Timestamp': timestamp, 'X-Statvara-Cash-Signature': signature,
    },
    body: raw,
  })
  const response = await handleCashCloseApi(request, env, new URL(request.url))
  return { response, data: await response.json() }
}

function cashSubmitBody(basis) {
  return {
    mutation_id: 'close:submit:reconciliation',
    outlet_id: 'RR-KCH', business_date: '2026-09-01', shift_id: 'night',
    expected_basis_id: basis.record.id, expected_basis_digest: basis.record.source_digest,
    denominations: { 50: '1', 20: '2', 10: '0', 5: '0', 1: '0', 0.5: '0', 0.2: '0', 0.1: '0', 0.05: '0', 100: '0' },
    actual_channels: { duitnow: '20.00' },
    variance_reason: 'RM10 counted shortage retained as accepted custody evidence',
  }
}

function startBody(basis, close, overrides = {}) {
  return {
    mutation_id: 'reconciliation:start:a',
    outlet_id: 'RR-KCH', business_date: '2026-09-01', shift_id: 'night',
    expected_basis_id: basis.id, expected_basis_digest: basis.source_digest,
    actual_close_id: close.id, actual_version: Number(close.__realtime?.version || 2),
    actual_count_identity: close.count_identity,
    ...overrides,
  }
}

test.after(() => rmSync(tempDirectory, { recursive: true, force: true }))

test('real Worker path closes LOOP-030 without mutating payment, AP, accounting, or Cash Close truth', async () => {
  const basis = await expected()
  assert.equal(basis.response.status, 202)

  const closeSubmitted = await call('/api/cash-close/submit', {
    actor: 'staff', method: 'POST', body: cashSubmitBody(basis.data),
  })
  assert.equal(closeSubmitted.response.status, 201)
  const closeCompleted = await call('/api/cash-close/review', {
    actor: 'supervisor', method: 'POST', body: {
      mutation_id: 'close:review:reconciliation', close_id: closeSubmitted.data.record.id,
      outlet_id: 'RR-KCH', decision: 'accept', reason: 'Custody discrepancy reviewed',
    },
  })
  assert.equal(closeCompleted.response.status, 200)
  assert.equal(closeCompleted.data.record.status, 'completed')
  const cashCloseBefore = JSON.stringify(closeCompleted.data.record)

  const contextBefore = await call('/api/payment-reconciliation/context?outlet_id=RR-KCH&business_date=2026-09-01&shift_id=night', { actor: 'staff' })
  assert.equal(contextBefore.response.status, 200)
  assert.equal(contextBefore.data.completion.complete, false)
  assert.equal(contextBefore.data.actual_fact.id, closeCompleted.data.record.id)
  assert.equal(contextBefore.data.financial_mutation_authority, 'none')

  const noAuth = await call('/api/payment-reconciliation/start', { method: 'POST', body: {} })
  assert.equal(noAuth.response.status, 401)

  const unprovisioned = await call('/api/payment-reconciliation/start', {
    actor: 'unprovisioned', method: 'POST', body: startBody(basis.data.record, closeCompleted.data.record, { mutation_id: 'reconciliation:unprovisioned' }),
  })
  assert.equal(unprovisioned.response.status, 403)
  assert.equal(unprovisioned.data.code, 'user_inactive')

  const service = await call('/api/payment-reconciliation/start', {
    actor: 'service', method: 'POST', body: startBody(basis.data.record, closeCompleted.data.record, { mutation_id: 'reconciliation:service' }),
  })
  assert.equal(service.response.status, 403)
  assert.equal(service.data.code, 'payment_reconciliation_human_required')

  const accessAdmin = await call('/api/payment-reconciliation/start', {
    actor: 'accessAdmin', method: 'POST', body: startBody(basis.data.record, closeCompleted.data.record, { mutation_id: 'reconciliation:access-admin' }),
  })
  assert.equal(accessAdmin.response.status, 403)
  assert.equal(accessAdmin.data.code, 'payment_reconciliation_capability_required')

  const wrongOutlet = await call('/api/payment-reconciliation/start', {
    actor: 'outsider', method: 'POST', body: startBody(basis.data.record, closeCompleted.data.record, { mutation_id: 'reconciliation:wrong-outlet' }),
  })
  assert.equal(wrongOutlet.response.status, 403)
  assert.equal(wrongOutlet.data.code, 'wrong_outlet')

  const wrongCompany = await call('/api/payment-reconciliation/start', {
    actor: 'staff', method: 'POST', body: startBody(basis.data.record, closeCompleted.data.record, { mutation_id: 'reconciliation:wrong-company', company_id: 'OTHER' }),
  })
  assert.equal(wrongCompany.response.status, 400)
  assert.equal(wrongCompany.data.code, 'payment_reconciliation_scope_dimension_unsupported')

  const forgedExpected = await call('/api/payment-reconciliation/start', {
    actor: 'staff', method: 'POST', body: startBody(basis.data.record, closeCompleted.data.record, { mutation_id: 'reconciliation:forged-expected', expected_total: '0.00' }),
  })
  assert.equal(forgedExpected.response.status, 400)
  assert.equal(forgedExpected.data.code, 'payment_reconciliation_server_managed_field')

  const forgedDigest = await call('/api/payment-reconciliation/start', {
    actor: 'staff', method: 'POST', body: startBody(basis.data.record, closeCompleted.data.record, { mutation_id: 'reconciliation:forged-digest', expected_basis_digest: 'forged' }),
  })
  assert.equal(forgedDigest.response.status, 409)
  assert.equal(forgedDigest.data.code, 'payment_reconciliation_expected_digest_mismatch')

  const foreignExpected = await call('/api/payment-reconciliation/start', {
    actor: 'staff', method: 'POST', body: startBody(basis.data.record, closeCompleted.data.record, {
      mutation_id: 'reconciliation:foreign-expected', expected_basis_id: 'foreign-expected-basis',
    }),
  })
  assert.equal(foreignExpected.response.status, 409)
  assert.equal(foreignExpected.data.code, 'payment_reconciliation_expected_basis_invalid')

  const foreignActual = await call('/api/payment-reconciliation/start', {
    actor: 'staff', method: 'POST', body: startBody(basis.data.record, closeCompleted.data.record, {
      mutation_id: 'reconciliation:foreign-actual', actual_close_id: 'foreign-close-up',
    }),
  })
  assert.equal(foreignActual.response.status, 409)
  assert.equal(foreignActual.data.code, 'payment_reconciliation_actual_fact_invalid')

  const forgedActual = await call('/api/payment-reconciliation/start', {
    actor: 'staff', method: 'POST', body: startBody(basis.data.record, closeCompleted.data.record, {
      mutation_id: 'reconciliation:forged-actual', actual_total: '999.00',
    }),
  })
  assert.equal(forgedActual.response.status, 400)
  assert.equal(forgedActual.data.code, 'payment_reconciliation_server_managed_field')

  const clientCompleted = await call('/api/payment-reconciliation/start', {
    actor: 'staff', method: 'POST', body: startBody(basis.data.record, closeCompleted.data.record, {
      mutation_id: 'reconciliation:client-completed', status: 'submitted',
    }),
  })
  assert.equal(clientCompleted.response.status, 400)
  assert.equal(clientCompleted.data.code, 'payment_reconciliation_server_managed_field')

  const started = await call('/api/payment-reconciliation/start', {
    actor: 'staff', method: 'POST', body: startBody(basis.data.record, closeCompleted.data.record),
  })
  assert.equal(started.response.status, 201)
  assert.equal(started.data.record.status, 'blind_entry')
  assert.equal(started.data.record.fact_identity.expected.id, basis.data.record.id)
  assert.equal(started.data.record.fact_identity.actual.id, closeCompleted.data.record.id)

  const replay = await call('/api/payment-reconciliation/start', {
    actor: 'staff', method: 'POST', body: startBody(basis.data.record, closeCompleted.data.record),
  })
  assert.equal(replay.response.status, 201)
  assert.equal(replay.data.replayed, true)
  assert.equal(replay.data.entity_id, started.data.entity_id)

  const changedReplay = await call('/api/payment-reconciliation/start', {
    actor: 'staff', method: 'POST', body: startBody(basis.data.record, closeCompleted.data.record, { actual_count_identity: 'changed' }),
  })
  assert.equal(changedReplay.response.status, 409)
  assert.equal(changedReplay.data.code, 'payment_reconciliation_mutation_fingerprint_mismatch')

  const duplicate = await call('/api/payment-reconciliation/start', {
    actor: 'staff', method: 'POST', body: startBody(basis.data.record, closeCompleted.data.record, { mutation_id: 'reconciliation:start:duplicate' }),
  })
  assert.equal(duplicate.response.status, 409)
  assert.equal(duplicate.data.code, 'payment_reconciliation_duplicate')

  const forgedVariance = await call('/api/payment-reconciliation/reveal', {
    actor: 'staff', method: 'POST', body: {
      mutation_id: 'reconciliation:reveal:forged', reconciliation_id: started.data.record.id,
      expected_version: 1, variance: '0.00',
    },
  })
  assert.equal(forgedVariance.response.status, 400)
  assert.equal(forgedVariance.data.code, 'payment_reconciliation_server_managed_field')

  const staleVersion = await call('/api/payment-reconciliation/reveal', {
    actor: 'staff', method: 'POST', body: {
      mutation_id: 'reconciliation:reveal:stale', reconciliation_id: started.data.record.id,
      expected_version: 99,
    },
  })
  assert.equal(staleVersion.response.status, 409)
  assert.equal(staleVersion.data.code, 'payment_reconciliation_version_conflict')

  const revealBody = {
    reconciliation_id: started.data.record.id, expected_version: 1,
  }
  const [revealA, revealB] = await Promise.all([
    call('/api/payment-reconciliation/reveal', { actor: 'staff', method: 'POST', body: { mutation_id: 'reconciliation:reveal:a', ...revealBody } }),
    call('/api/payment-reconciliation/reveal', { actor: 'manager', method: 'POST', body: { mutation_id: 'reconciliation:reveal:b', ...revealBody } }),
  ])
  assert.ok([revealA.response.status, revealB.response.status].includes(200))
  assert.ok([revealA.response.status, revealB.response.status].some((status) => status === 409 || status === 423))
  const revealed = revealA.response.status === 200 ? revealA : revealB
  assert.equal(revealed.data.record.status, 'differences_revealed')
  assert.equal(revealed.data.record.comparison.expected_total, '120.00')
  assert.equal(revealed.data.record.comparison.actual_total, '110.00')
  assert.equal(revealed.data.record.comparison.variance, '-10.00')
  assert.equal(revealed.data.record.comparison.all_matched, false)

  const unresolved = await call('/api/payment-reconciliation/remark', {
    actor: 'staff', method: 'POST', body: {
      mutation_id: 'reconciliation:remark:unresolved', reconciliation_id: started.data.record.id,
      expected_version: 2, classification: 'unresolved_exception', reason: 'Cash shortage requires investigation',
      evidence_ids: ['close-up-photo:001'],
    },
  })
  assert.equal(unresolved.response.status, 200)
  const blockedSubmit = await call('/api/payment-reconciliation/submit', {
    actor: 'staff', method: 'POST', body: {
      mutation_id: 'reconciliation:submit:blocked', reconciliation_id: started.data.record.id, expected_version: 3,
    },
  })
  assert.equal(blockedSubmit.response.status, 409)
  assert.equal(blockedSubmit.data.code, 'payment_reconciliation_discrepancy_unresolved')

  const replacementFromUnresolved = await call('/api/payment-reconciliation/replace', {
    actor: 'supervisor', method: 'POST', body: {
      ...startBody(basis.data.record, closeCompleted.data.record, { mutation_id: 'reconciliation:replace:decision' }),
      original_reconciliation_id: started.data.record.id,
      replacement_reason: 'Finance reviewer supplied final variance disposition',
    },
  })
  assert.equal(replacementFromUnresolved.response.status, 201)
  const replacement = replacementFromUnresolved.data.record
  assert.equal(replacement.replacement_of_id, started.data.record.id)
  assert.equal(replacement.replacement_sequence, 1)

  const revealedReplacement = await call('/api/payment-reconciliation/reveal', {
    actor: 'staff', method: 'POST', body: {
      mutation_id: 'reconciliation:reveal:replacement', reconciliation_id: replacement.id, expected_version: 1,
    },
  })
  assert.equal(revealedReplacement.response.status, 200)
  const remarkedReplacement = await call('/api/payment-reconciliation/remark', {
    actor: 'staff', method: 'POST', body: {
      mutation_id: 'reconciliation:remark:accepted', reconciliation_id: replacement.id, expected_version: 2,
      classification: 'explained_discrepancy', reason: 'RM10 shortage investigated and accepted as evidence-only discrepancy',
      evidence_ids: ['close-up-photo:001', 'manager-note:001'],
    },
  })
  assert.equal(remarkedReplacement.response.status, 200)
  const submitted = await call('/api/payment-reconciliation/submit', {
    actor: 'manager', method: 'POST', body: {
      mutation_id: 'reconciliation:submit:accepted', reconciliation_id: replacement.id, expected_version: 3,
    },
  })
  assert.equal(submitted.response.status, 200)
  assert.equal(submitted.data.record.status, 'submitted')
  assert.equal(submitted.data.record.completion.complete, true)
  assert.equal(submitted.data.record.completion.financial_truth_changed, false)
  assert.equal(submitted.data.record.completion.payment_created, false)
  assert.equal(submitted.data.record.completion.payment_allocation_changed, false)
  assert.equal(submitted.data.record.completion.supplier_invoice_outstanding_changed, false)
  assert.equal(submitted.data.record.completion.accounting_journal_created, false)
  assert.equal(submitted.data.record.completion.cash_close_changed, false)

  const submitReplayBody = {
    mutation_id: 'reconciliation:submit:accepted', reconciliation_id: replacement.id, expected_version: 3,
  }
  const submitReplay = await call('/api/payment-reconciliation/submit', {
    actor: 'manager', method: 'POST', body: submitReplayBody,
  })
  assert.equal(submitReplay.response.status, 200)
  assert.equal(submitReplay.data.replayed, true)
  assert.equal(submitReplay.data.entity_id, replacement.id)
  const changedSubmitReplay = await call('/api/payment-reconciliation/submit', {
    actor: 'manager', method: 'POST', body: { ...submitReplayBody, expected_version: 4 },
  })
  assert.equal(changedSubmitReplay.response.status, 409)
  assert.equal(changedSubmitReplay.data.code, 'payment_reconciliation_mutation_fingerprint_mismatch')

  const storedClose = JSON.parse(db.query(`SELECT payload_json FROM ops_records WHERE entity='CloseUp' AND entity_id=${literal(closeCompleted.data.record.id)}`)[0].payload_json)
  assert.equal(JSON.stringify(storedClose), cashCloseBefore)
  for (const entity of ['Payment', 'PaymentAllocation', 'SupplierInvoice', 'JournalEntry']) {
    assert.equal(Number(db.query(`SELECT COUNT(*) AS count FROM ops_records WHERE entity=${literal(entity)}`)[0].count), 0)
  }
  assert.equal(Number(db.query("SELECT COUNT(*) AS count FROM sheet_sync_outbox WHERE entity='PaymentReconciliation'")[0].count), 0)

  const completedContext = await call('/api/payment-reconciliation/context?outlet_id=RR-KCH&business_date=2026-09-01&shift_id=night', { actor: 'staff' })
  assert.equal(completedContext.data.completion.complete, true)
  assert.equal(completedContext.data.completion.historical_complete, true)
  assert.equal(completedContext.data.history.length, 2)
  const originalBeforeDrift = JSON.stringify(completedContext.data.history.find((record) => record.id === started.data.record.id))
  const submittedBeforeDrift = JSON.stringify(completedContext.data.current_reconciliation)

  const basisB = await expected({ expectedCash: '110.00', snapshot: 'snapshot-b', observedAt: '2026-09-01T15:00:00.000Z' })
  assert.equal(basisB.response.status, 202)
  const driftContext = await call('/api/payment-reconciliation/context?outlet_id=RR-KCH&business_date=2026-09-01&shift_id=night', { actor: 'staff' })
  assert.equal(driftContext.data.source_drift, true)
  assert.equal(driftContext.data.completion.complete, false)
  assert.equal(driftContext.data.completion.historical_complete, true)
  assert.ok(driftContext.data.stale_reasons.includes('expected_source_version_changed'))
  assert.equal(JSON.stringify(driftContext.data.history.find((record) => record.id === started.data.record.id)), originalBeforeDrift)
  assert.equal(JSON.stringify(driftContext.data.current_reconciliation), submittedBeforeDrift)

  await db.prepare(`
    INSERT INTO ops_records (
      entity, entity_id, outlet_id, business_date, status, payload_json,
      version, created_at, created_by, updated_at, updated_by, deleted_at
    ) VALUES ('PaymentReconciliation', 'sheet-spoof', 'RR-KCH', '2026-09-01', 'submitted', ?, 1, ?, 'sheet', ?, 'sheet', '')
  `).bind(JSON.stringify({
    id: 'sheet-spoof', authority_contract: 'google-sheet-report', logical_key: 'RR-KCH|2026-09-01|night',
    replacement_sequence: 999, status: 'submitted', completion: { complete: true },
  }), new Date().toISOString(), new Date().toISOString()).run()
  const spoofContext = await call('/api/payment-reconciliation/context?outlet_id=RR-KCH&business_date=2026-09-01&shift_id=night', { actor: 'staff' })
  assert.notEqual(spoofContext.data.current_reconciliation.id, 'sheet-spoof')

  const entrySource = readFileSync(new URL('../src/entry.js', import.meta.url), 'utf8')
  const domainSource = readFileSync(new URL('../src/payment-reconciliation-d1.js', import.meta.url), 'utf8')
  assert.match(entrySource, /legacyPaymentReconciliationMutationBlocked/)
  assert.match(entrySource, /payment_reconciliation_command_api_required/)
  assert.doesNotMatch(domainSource, /INSERT INTO (?:payments|payment_allocations|supplier_invoices|journal_entries)/i)
  assert.doesNotMatch(domainSource, /UPDATE (?:payments|payment_allocations|supplier_invoices|journal_entries)/i)
})

test('acceptance-time reauthorization rejects a stale session and no offline state becomes authoritative', async () => {
  const basis = db.query("SELECT payload_json FROM ops_records WHERE entity='CashExpectedBasis' ORDER BY updated_at DESC LIMIT 1").map((row) => JSON.parse(row.payload_json))[0]
  const close = db.query("SELECT payload_json, version FROM ops_records WHERE entity='CloseUp' AND status='completed' ORDER BY updated_at DESC LIMIT 1").map((row) => ({ ...JSON.parse(row.payload_json), __realtime: { version: row.version } }))[0]
  const current = db.query("SELECT payload_json FROM ops_records WHERE entity='PaymentReconciliation' AND json_extract(payload_json, '$.authority_contract')='statvara-payment-reconciliation-v1' ORDER BY CAST(json_extract(payload_json, '$.replacement_sequence') AS INTEGER) DESC LIMIT 1").map((row) => JSON.parse(row.payload_json))[0]
  const draft = await call('/api/payment-reconciliation/replace', {
    actor: 'supervisor', method: 'POST', body: {
      ...startBody(basis, close, { mutation_id: 'reconciliation:replace:reauth' }),
      original_reconciliation_id: current.id,
      replacement_reason: 'Rebind to the latest expected source before stale-session test',
    },
  })
  assert.equal(draft.response.status, 201)
  const revealed = await call('/api/payment-reconciliation/reveal', {
    actor: 'staff', method: 'POST', body: {
      mutation_id: 'reconciliation:reveal:reauth', reconciliation_id: draft.data.record.id, expected_version: 1,
    },
  })
  assert.equal(revealed.response.status, 200)
  const remarked = await call('/api/payment-reconciliation/remark', {
    actor: 'staff', method: 'POST', body: {
      mutation_id: 'reconciliation:remark:reauth', reconciliation_id: draft.data.record.id, expected_version: 2,
      classification: 'explained_discrepancy', reason: 'Prepared while currently authorized', evidence_ids: [],
    },
  })
  assert.equal(remarked.response.status, 200)

  const staff = { ...users.staff, status: 'inactive' }
  await db.prepare("UPDATE ops_records SET status='inactive', payload_json=?, version=version+1 WHERE entity='User' AND entity_id=?")
    .bind(JSON.stringify(staff), staff.id).run()
  const rejected = await call('/api/payment-reconciliation/submit', {
    actor: 'staff', method: 'POST', body: {
      mutation_id: 'reconciliation:submit:revoked', reconciliation_id: draft.data.record.id, expected_version: 3,
    },
  })
  assert.equal(rejected.response.status, 403)
  assert.equal(rejected.data.code, 'user_inactive')
  const row = db.query(`SELECT status FROM ops_records WHERE entity='PaymentReconciliation' AND entity_id=${literal(draft.data.record.id)}`)[0]
  assert.equal(row.status, 'remarks_complete')
  assert.equal(db.query("SELECT COUNT(*) AS count FROM ops_mutations WHERE mutation_id='reconciliation:submit:revoked'")[0].count, 0)
})
