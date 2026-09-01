import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { createSession } from '../src/auth.js'
import { handleAttendanceWorkforceApi } from '../src/attendance-workforce-d1.js'
import { commitAttendanceRoster } from '../src/realtime-attendance-roster.js'
import { withSubmissionLock } from '../src/submission-locks.js'

class D1Statement {
  constructor(database, sql, values = []) { this.database = database; this.sql = sql; this.values = values }
  bind(...values) { return new D1Statement(this.database, this.sql, values) }
  async first() { return this.database.prepare(this.sql).get(...this.values) || null }
  async all() { return { results: this.database.prepare(this.sql).all(...this.values) } }
  async run() {
    const result = this.database.prepare(this.sql).run(...this.values)
    return { ...result, changes: Number(result.changes || 0), meta: { changes: Number(result.changes || 0) } }
  }
}

function d1Adapter(database) {
  return {
    prepare(sql) { return new D1Statement(database, sql) },
    async batch(statements) {
      database.exec('BEGIN IMMEDIATE')
      try {
        const results = []
        for (const statement of statements) results.push(await statement.run())
        database.exec('COMMIT')
        return results
      } catch (error) {
        database.exec('ROLLBACK')
        throw error
      }
    },
  }
}

const sqlite = new DatabaseSync(':memory:')
sqlite.exec(readFileSync(new URL('../migrations/0001_realtime_core.sql', import.meta.url), 'utf8'))
sqlite.exec(readFileSync(new URL('../migrations/0002_submission_locks.sql', import.meta.url), 'utf8'))
sqlite.exec(readFileSync(new URL('../migrations/0002_local_auth.sql', import.meta.url), 'utf8'))

const db = d1Adapter(sqlite)
const env = {
  OPS_DB: db,
  SESSION_SECRET: 'attendance-session-secret-01234567890123456789',
  ATTENDANCE_TIME_ZONE: 'Asia/Kuala_Lumpur',
  ALLOWED_ORIGINS: 'https://example.test',
}

function insertRecord(entity, id, outletId, status, payload, businessDate = '') {
  const timestamp = '2026-09-01T00:00:00.000Z'
  sqlite.prepare(`
    INSERT INTO ops_records (
      entity, entity_id, outlet_id, business_date, status, payload_json,
      version, created_at, created_by, updated_at, updated_by, deleted_at
    ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, 'seed', ?, 'seed', '')
  `).run(entity, id, outletId, businessDate, status, JSON.stringify(payload), timestamp, timestamp)
}

insertRecord('Outlet', 'RR-KCH', 'RR-KCH', 'active', { id: 'RR-KCH', name: 'Royal Richmond', status: 'active' })
insertRecord('Outlet', 'OTHER', 'OTHER', 'active', { id: 'OTHER', name: 'Other', status: 'active' })

const users = {
  staff: { id: 'u-staff', email: 'staff@example.test', full_name: 'Staff One', role: 'staff', status: 'active', outlet_id: 'RR-KCH', outlet_ids: '["RR-KCH"]', principal_type: 'human' },
  supervisor: { id: 'u-supervisor', email: 'supervisor@example.test', full_name: 'Supervisor One', role: 'supervisor', status: 'active', outlet_id: 'RR-KCH', outlet_ids: '["RR-KCH"]', principal_type: 'human' },
  manager: { id: 'u-manager', email: 'manager@example.test', full_name: 'Manager One', role: 'manager', status: 'active', outlet_id: 'RR-KCH', outlet_ids: '["RR-KCH"]', principal_type: 'human' },
  outsider: { id: 'u-outsider', email: 'outside@example.test', full_name: 'Outside Owner', role: 'owner', status: 'active', outlet_id: 'OTHER', outlet_ids: '["OTHER"]', principal_type: 'human' },
  service: { id: 'u-service', email: 'service@example.test', full_name: 'Attendance Service', role: 'supervisor', status: 'active', outlet_id: 'RR-KCH', outlet_ids: '["RR-KCH"]', principal_type: 'service' },
  accessAdmin: { id: 'u-access', email: 'access@example.test', full_name: 'Access Admin', role: 'access_admin', status: 'active', outlet_id: 'RR-KCH', outlet_ids: '["RR-KCH"]', principal_type: 'human', capabilities_json: '[]' },
}

for (const user of Object.values(users)) insertRecord('User', user.id, user.outlet_id, user.status, user)

const tokens = Object.fromEntries(await Promise.all(Object.entries(users).map(async ([key, user]) => [key, await createSession(user, env)])))
tokens.unprovisioned = await createSession({ id: 'u-missing', email: 'missing@example.test', role: 'staff', status: 'active', outlet_id: 'RR-KCH' }, env)

function requestFor(path, { actor, method = 'GET', body, headers = {} } = {}) {
  const requestHeaders = new Headers({ Origin: 'https://example.test', 'X-ChefOps-Client-Id': `client-${actor || 'none'}`, ...headers })
  if (actor) requestHeaders.set('Authorization', `Bearer ${tokens[actor]}`)
  if (body !== undefined) requestHeaders.set('Content-Type', 'application/json')
  return new Request(`https://example.test${path}`, {
    method,
    headers: requestHeaders,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

async function call(path, options = {}) {
  const request = requestFor(path, options)
  const url = new URL(request.url)
  const response = url.pathname === '/api/attendance/workforce/context'
    ? await handleAttendanceWorkforceApi(request, env, url)
    : await withSubmissionLock(request, env, url, () => handleAttendanceWorkforceApi(request, env, url))
  return { response, data: await response.json().catch(() => ({})) }
}

async function importSchedule({ mutation = 'roster:workforce:a', batch = 'batch:a', date = '2026-09-01', clockIn = '09:00', clockOut = '17:00' } = {}) {
  const request = requestFor('/api/attendance/import', { actor: 'manager', method: 'POST', headers: { 'X-ChefOps-Mutation-Id': mutation } })
  return commitAttendanceRoster(request, env, users.manager, {
    mutation_id: mutation,
    batch_id: batch,
    outlet_id: 'RR-KCH',
    replace_existing: true,
    source: { file_name: 'weekly-roster.pdf', drive_file_id: 'drive-roster-a' },
    rows: [{ staff_name: 'Staff One', staff_role: 'staff', date, clock_in: clockIn, clock_out: clockOut, notes: 'Scheduled counter duty.' }],
  })
}

function clockInBody(scheduleId, mutation = 'attendance:clock-in:a', overrides = {}) {
  return { mutation_id: mutation, outlet_id: 'RR-KCH', business_date: '2026-09-01', schedule_id: scheduleId, ...overrides }
}

test.after(() => sqlite.close())

test('LOOP-021 closes through protected schedule, attendance, event, consequence, and projection records', async () => {
  const imported = await importSchedule()
  assert.equal(imported.employee_bindings_resolved, 1)
  const schedule = JSON.parse(sqlite.prepare("SELECT payload_json FROM ops_records WHERE entity='Attendance' AND status='scheduled'").get().payload_json)
  assert.equal(schedule.authority_contract, 'statvara-duty-schedule-v1')
  assert.equal(schedule.employee_id, users.staff.id)
  assert.equal(schedule.time_zone, 'Asia/Kuala_Lumpur')

  const contextBefore = await call('/api/attendance/workforce/context?outlet_id=RR-KCH&business_date=2026-09-01', { actor: 'staff' })
  assert.equal(contextBefore.response.status, 200)
  assert.equal(contextBefore.data.schedule.id, schedule.id)
  assert.equal(contextBefore.data.completion.complete, false)
  assert.equal(contextBefore.data.financial_mutation_authority, 'none')

  const noAuth = await call('/api/attendance/workforce/clock-in', { method: 'POST', body: clockInBody(schedule.id, 'attendance:no-auth') })
  assert.equal(noAuth.response.status, 401)
  const unprovisioned = await call('/api/attendance/workforce/clock-in', { actor: 'unprovisioned', method: 'POST', body: clockInBody(schedule.id, 'attendance:unprovisioned') })
  assert.equal(unprovisioned.response.status, 403)
  const service = await call('/api/attendance/workforce/clock-in', { actor: 'service', method: 'POST', body: clockInBody(schedule.id, 'attendance:service') })
  assert.equal(service.response.status, 403)
  assert.equal(service.data.code, 'attendance_human_required')
  const accessAdmin = await call('/api/attendance/workforce/clock-in', { actor: 'accessAdmin', method: 'POST', body: clockInBody(schedule.id, 'attendance:access') })
  assert.equal(accessAdmin.response.status, 403)
  const outsider = await call('/api/attendance/workforce/clock-in', { actor: 'outsider', method: 'POST', body: clockInBody(schedule.id, 'attendance:outside') })
  assert.equal(outsider.response.status, 403)

  const forgedIdentity = await call('/api/attendance/workforce/clock-in', {
    actor: 'staff', method: 'POST', body: clockInBody(schedule.id, 'attendance:forged-identity', { employee_id: users.manager.id }),
  })
  assert.equal(forgedIdentity.response.status, 400)
  assert.equal(forgedIdentity.data.code, 'attendance_server_managed_field')
  const forgedTimestamp = await call('/api/attendance/workforce/clock-in', {
    actor: 'staff', method: 'POST', body: clockInBody(schedule.id, 'attendance:forged-time', { clocked_in_at: '2020-01-01T00:00:00Z' }),
  })
  assert.equal(forgedTimestamp.response.status, 400)
  const forgedCompany = await call('/api/attendance/workforce/clock-in', {
    actor: 'staff', method: 'POST', body: clockInBody(schedule.id, 'attendance:forged-company', { company_id: 'FOREIGN-COMPANY' }),
  })
  assert.equal(forgedCompany.response.status, 400)
  assert.equal(forgedCompany.data.code, 'attendance_scope_dimension_unsupported')
  const forgedStatus = await call('/api/attendance/workforce/clock-in', {
    actor: 'staff', method: 'POST', body: clockInBody(schedule.id, 'attendance:forged-status', { status: 'Present', late: false }),
  })
  assert.equal(forgedStatus.response.status, 400)
  const substitutedScheduleVersion = await call('/api/attendance/workforce/clock-in', {
    actor: 'staff', method: 'POST', body: clockInBody(schedule.id, 'attendance:substitute-schedule', { schedule_version: 999 }),
  })
  assert.equal(substitutedScheduleVersion.response.status, 400)
  const foreignSchedule = await call('/api/attendance/workforce/clock-in', {
    actor: 'staff', method: 'POST', body: clockInBody('attendance-roster-foreign', 'attendance:foreign-schedule'),
  })
  assert.equal(foreignSchedule.response.status, 404)

  const started = await call('/api/attendance/workforce/clock-in', { actor: 'staff', method: 'POST', body: clockInBody(schedule.id) })
  assert.equal(started.response.status, 201)
  assert.equal(started.data.record.status, 'clocked_in')
  assert.equal(started.data.record.employee_id, users.staff.id)
  assert.equal(started.data.event.client_timestamp_authority, 'none')
  assert.equal(started.data.record.schedule_snapshot.schedule_version, 1)

  const replay = await call('/api/attendance/workforce/clock-in', { actor: 'staff', method: 'POST', body: clockInBody(schedule.id) })
  assert.equal(replay.response.status, 200)
  assert.equal(replay.data.replayed, true)
  const changedReplay = await call('/api/attendance/workforce/clock-in', { actor: 'staff', method: 'POST', body: clockInBody(schedule.id, 'attendance:clock-in:a', { business_date: '2026-09-02' }) })
  assert.equal(changedReplay.response.status, 409)
  assert.equal(changedReplay.data.code, 'attendance_mutation_fingerprint_mismatch')
  const duplicateEvent = await call('/api/attendance/workforce/clock-in', {
    actor: 'staff', method: 'POST', body: clockInBody(schedule.id, 'attendance:duplicate-new-id'),
  })
  assert.equal(duplicateEvent.response.status, 409)
  assert.equal(duplicateEvent.data.code, 'attendance_already_started')

  const forgedDuration = await call('/api/attendance/workforce/clock-out', {
    actor: 'staff', method: 'POST', body: { mutation_id: 'attendance:forged-duration', outlet_id: 'RR-KCH', attendance_record_id: started.data.record.id, worked_seconds: 99 },
  })
  assert.equal(forgedDuration.response.status, 400)
  const forgedClockOut = await call('/api/attendance/workforce/clock-out', {
    actor: 'staff', method: 'POST', body: { mutation_id: 'attendance:forged-clock-out', outlet_id: 'RR-KCH', attendance_record_id: started.data.record.id, clocked_out_at: '2030-01-01T00:00:00Z' },
  })
  assert.equal(forgedClockOut.response.status, 400)
  const foreignRecord = await call('/api/attendance/workforce/clock-out', {
    actor: 'staff', method: 'POST', body: { mutation_id: 'attendance:foreign-record', outlet_id: 'RR-KCH', attendance_record_id: 'attendance-record-foreign' },
  })
  assert.equal(foreignRecord.response.status, 404)
  const managerCannotClockEmployee = await call('/api/attendance/workforce/clock-out', {
    actor: 'manager', method: 'POST', body: { mutation_id: 'attendance:manager-clock-out', outlet_id: 'RR-KCH', attendance_record_id: started.data.record.id },
  })
  assert.equal(managerCannotClockEmployee.response.status, 403)

  const completed = await call('/api/attendance/workforce/clock-out', {
    actor: 'staff', method: 'POST', body: { mutation_id: 'attendance:clock-out:a', outlet_id: 'RR-KCH', attendance_record_id: started.data.record.id },
  })
  assert.equal(completed.response.status, 201)
  assert.equal(completed.data.record.status, 'completed')
  assert.equal(completed.data.record.lifecycle_transition, 'TR-011-002')
  assert.equal(completed.data.consequence.consequence_type, 'accepted_worked_time')
  assert.equal(completed.data.consequence.payroll_effect, 'none')
  assert.equal(completed.data.consequence.timesheet_effect, 'none')
  assert(Number.isInteger(completed.data.consequence.worked_seconds))
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM sheet_sync_outbox WHERE operation='attendance_report_projection'").get().count, 1)

  const completedContext = await call('/api/attendance/workforce/context?outlet_id=RR-KCH&business_date=2026-09-01', { actor: 'staff' })
  assert.equal(completedContext.data.completion.complete, true)
  assert.equal(completedContext.data.completion.fact, 'Attendance event is authoritative and drives an explicit report consequence.')

  const correctionWithoutReason = await call('/api/attendance/workforce/correct', {
    actor: 'manager', method: 'POST', body: {
      mutation_id: 'attendance:correct-no-reason', outlet_id: 'RR-KCH', original_attendance_record_id: started.data.record.id,
      corrected_clocked_in_at: '2026-09-01T01:00:00.000Z', corrected_clocked_out_at: '2026-09-01T09:00:00.000Z',
    },
  })
  assert.equal(correctionWithoutReason.response.status, 400)
  const employeeCorrection = await call('/api/attendance/workforce/correct', {
    actor: 'staff', method: 'POST', body: {
      mutation_id: 'attendance:employee-correct', outlet_id: 'RR-KCH', original_attendance_record_id: started.data.record.id,
      corrected_clocked_in_at: '2026-09-01T01:00:00.000Z', corrected_clocked_out_at: '2026-09-01T09:00:00.000Z', reason: 'Employee cannot self-approve a finalized correction.',
    },
  })
  assert.equal(employeeCorrection.response.status, 403)
  const serviceCorrection = await call('/api/attendance/workforce/correct', {
    actor: 'service', method: 'POST', body: {
      mutation_id: 'attendance:service-correct', outlet_id: 'RR-KCH', original_attendance_record_id: started.data.record.id,
      corrected_clocked_in_at: '2026-09-01T01:00:00.000Z', corrected_clocked_out_at: '2026-09-01T09:00:00.000Z', reason: 'Service principal cannot perform the human correction decision.',
    },
  })
  assert.equal(serviceCorrection.response.status, 403)
  assert.equal(serviceCorrection.data.code, 'attendance_human_required')

  const originalBefore = sqlite.prepare("SELECT payload_json FROM ops_records WHERE entity='AttendanceRecord' AND entity_id=?").get(started.data.record.id).payload_json
  sqlite.prepare("UPDATE ops_records SET version=2, payload_json=json_set(payload_json, '$.clock_in', '10:00', '$.version', 2) WHERE entity='Attendance' AND entity_id=?").run(schedule.id)
  const drift = await call('/api/attendance/workforce/context?outlet_id=RR-KCH&business_date=2026-09-01', { actor: 'staff' })
  assert.equal(drift.data.schedule_drift, true)
  assert.equal(drift.data.attendance_record.schedule_snapshot.expected_start_local, '09:00')
  assert.equal(drift.data.attendance_record.schedule_snapshot.schedule_version, 1)

  const corrected = await call('/api/attendance/workforce/correct', {
    actor: 'manager', method: 'POST', body: {
      mutation_id: 'attendance:correct:a', outlet_id: 'RR-KCH', original_attendance_record_id: started.data.record.id,
      corrected_clocked_in_at: '2026-09-01T14:00:00.000Z', corrected_clocked_out_at: '2026-09-02T22:00:00.000Z',
      reason: 'Supervisor verified the overnight shift against signed custody notes.',
    },
  })
  assert.equal(corrected.response.status, 201)
  assert.equal(corrected.data.record.command_id, null)
  assert.equal(corrected.data.record.candidate_operation, 'attendance.correct')
  assert.equal(corrected.data.record.worked_seconds, 115200)
  assert.equal(corrected.data.original_record_unchanged, true)
  assert.equal(sqlite.prepare("SELECT payload_json FROM ops_records WHERE entity='AttendanceRecord' AND entity_id=?").get(started.data.record.id).payload_json, originalBefore)
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM sheet_sync_outbox WHERE operation='attendance_report_projection'").get().count, 2)

  const correctedContext = await call('/api/attendance/workforce/context?outlet_id=RR-KCH&business_date=2026-09-01', { actor: 'staff' })
  assert.equal(correctedContext.data.attendance_record.id, corrected.data.record.id)
  assert.equal(correctedContext.data.original_attendance_record.id, started.data.record.id)

  for (const entity of ['Payment', 'PaymentAllocation', 'SupplierInvoice', 'JournalEntry', 'Timesheet', 'PayrollEntry', 'LeaveApplication']) {
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM ops_records WHERE entity=?').get(entity).count, 0, `${entity} must remain untouched`)
  }
})

test('current D1 access state and deterministic concurrency fail closed', async () => {
  const imported = await importSchedule({ mutation: 'roster:workforce:b', batch: 'batch:b', date: '2026-09-02' })
  assert.equal(imported.employee_bindings_resolved, 1)
  const schedule = JSON.parse(sqlite.prepare("SELECT payload_json FROM ops_records WHERE entity='Attendance' AND business_date='2026-09-02' AND deleted_at='' LIMIT 1").get().payload_json)

  sqlite.prepare("UPDATE ops_records SET payload_json=json_set(payload_json, '$.capabilities_json', '[]') WHERE entity='User' AND entity_id=?").run(users.staff.id)
  const revokedCapability = await call('/api/attendance/workforce/clock-in', {
    actor: 'staff', method: 'POST', body: { mutation_id: 'attendance:revoked-capability', requested_at: '2026-08-31T00:00:00Z', outlet_id: 'RR-KCH', business_date: '2026-09-02', schedule_id: schedule.id },
  })
  assert.equal(revokedCapability.response.status, 403)
  assert.equal(revokedCapability.data.code, 'attendance_capability_required')
  sqlite.prepare("UPDATE ops_records SET payload_json=json_remove(payload_json, '$.capabilities_json') WHERE entity='User' AND entity_id=?").run(users.staff.id)

  sqlite.prepare("UPDATE ops_records SET payload_json=json_set(payload_json, '$.outlet_id', '', '$.outlet_ids', '[]') WHERE entity='User' AND entity_id=?").run(users.staff.id)
  const removedOutletOffline = await call('/api/attendance/workforce/clock-in', {
    actor: 'staff', method: 'POST', body: { mutation_id: 'attendance:removed-outlet-offline', requested_at: '2026-08-31T00:00:00Z', outlet_id: 'RR-KCH', business_date: '2026-09-02', schedule_id: schedule.id },
  })
  assert.equal(removedOutletOffline.response.status, 403)
  assert.equal(removedOutletOffline.data.code, 'wrong_outlet')
  sqlite.prepare("UPDATE ops_records SET payload_json=json_set(payload_json, '$.outlet_id', 'RR-KCH', '$.outlet_ids', '[\"RR-KCH\"]') WHERE entity='User' AND entity_id=?").run(users.staff.id)

  sqlite.prepare("UPDATE ops_records SET status='inactive', payload_json=json_set(payload_json, '$.status', 'inactive') WHERE entity='User' AND entity_id=?").run(users.staff.id)
  const staleSession = await call('/api/attendance/workforce/clock-in', {
    actor: 'staff', method: 'POST', body: { mutation_id: 'attendance:stale-session', outlet_id: 'RR-KCH', business_date: '2026-09-02', schedule_id: schedule.id },
  })
  assert.equal(staleSession.response.status, 403)
  assert.equal(staleSession.data.code, 'user_inactive')
  sqlite.prepare("UPDATE ops_records SET status='active', payload_json=json_set(payload_json, '$.status', 'active') WHERE entity='User' AND entity_id=?").run(users.staff.id)

  const bodies = ['a', 'b'].map((suffix) => ({
    mutation_id: `attendance:race:${suffix}`, outlet_id: 'RR-KCH', business_date: '2026-09-02', schedule_id: schedule.id,
  }))
  const results = await Promise.all(bodies.map((body) => call('/api/attendance/workforce/clock-in', { actor: 'staff', method: 'POST', body })))
  assert.equal(results.filter(({ response }) => response.status === 201).length, 1)
  assert.equal(results.filter(({ response }) => [409, 423].includes(response.status)).length, 1)
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM ops_records WHERE entity='AttendanceRecord' AND business_date='2026-09-02'").get().count, 1)
})
