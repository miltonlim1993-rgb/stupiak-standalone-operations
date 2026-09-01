import { sessionPayload } from './auth.js'
import { errorResponse, json, readJson } from './http.js'
import { assertLocalSessionVersion } from './local-auth-store.js'
import { assignedOutletIds } from './permissions.js'

const CONTRACT = 'statvara-attendance-workforce-v1'
const SCHEDULE_CONTRACT = 'statvara-duty-schedule-v1'
const SCHEDULE_ENTITY = 'Attendance'
const RECORD_ENTITY = 'AttendanceRecord'
const EVENT_ENTITY = 'AttendanceClockEvent'
const CONSEQUENCE_ENTITY = 'WorkforceConsequence'
const MUTATION_ID_LIMIT = 160

function now() { return new Date().toISOString() }

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
  if (!env.OPS_DB?.prepare) fail('Attendance D1 database is unavailable', 'attendance_database_unavailable', 503)
  return env.OPS_DB
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
  const parsed = typeof user.capabilities_json === 'string' ? parseJson(user.capabilities_json, []) : user.capabilities_json
  return new Set(Array.isArray(parsed) ? parsed.map(String) : [])
}

function capabilities(user) {
  const explicit = explicitCapabilities(user)
  if (explicit) return explicit
  const role = String(user?.role || '').toLowerCase().replace(/^role_/, '')
  const values = new Set()
  if (['staff', 'leader', 'supervisor', 'manager', 'owner'].includes(role)) {
    values.add('attendance.clock_self')
    values.add('attendance.view_self')
  }
  if (['supervisor', 'manager', 'owner'].includes(role)) {
    values.add('attendance.correct')
    values.add('attendance.view_outlet')
  }
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
    row = await database(env).prepare("SELECT * FROM ops_records WHERE entity = 'User' AND entity_id = ? AND deleted_at = '' LIMIT 1").bind(userId).first()
  } else if (googleSub) {
    row = await database(env).prepare("SELECT * FROM ops_records WHERE entity = 'User' AND json_extract(payload_json, '$.google_sub') = ? AND deleted_at = '' ORDER BY updated_at DESC LIMIT 1").bind(googleSub).first()
  }
  if (!row && email) {
    row = await database(env).prepare("SELECT * FROM ops_records WHERE entity = 'User' AND lower(json_extract(payload_json, '$.email')) = ? AND deleted_at = '' ORDER BY updated_at DESC LIMIT 1").bind(email).first()
  }
  const user = row ? (parseJson(row.payload_json, {}) || {}) : null
  if (!user || String(user.status || '').toLowerCase() !== 'active') fail('User account is inactive', 'user_inactive', 403)
  if (authMethod === 'local') await assertLocalSessionVersion(env, user.id, Number(payload.sv || 0))
  if (String(user.principal_type || 'human').toLowerCase() !== 'human') {
    fail('A current human principal is required for attendance commands', 'attendance_human_required', 403)
  }
  if (!capabilities(user).has(capability)) {
    fail(`Current principal lacks ${capability}`, 'attendance_capability_required', 403, { capability })
  }
  return user
}

function requireAssignedOutlet(user, value) {
  const outletId = String(value || '').trim()
  if (!outletId) fail('outlet_id is required', 'attendance_outlet_required')
  if (!assignedOutletIds(user).includes(outletId)) fail('This outlet is not assigned to the current principal', 'wrong_outlet', 403)
  return outletId
}

function requireDate(value) {
  const date = String(value || '').trim()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) fail('business_date must use YYYY-MM-DD', 'attendance_business_date_invalid')
  return date
}

function requireMutationId(request, body) {
  const id = String(body?.mutation_id || request.headers.get('X-ChefOps-Mutation-Id') || '').trim()
  if (!id || id.length > MUTATION_ID_LIMIT) fail('A stable mutation_id is required', 'attendance_mutation_id_required')
  return id
}

function rejectUnsupportedScope(body) {
  for (const field of ['company_id', 'tenant_id', 'payroll_id', 'timesheet_id', 'leave_id', 'payment_id', 'journal_entry_id']) {
    if (String(body?.[field] || '').trim()) fail(`${field} is not a supported LOOP-021 scope dimension`, 'attendance_scope_dimension_unsupported')
  }
}

function rejectServerManaged(body) {
  for (const field of [
    'employee_id', 'user_id', 'staff_name', 'clocked_in_at', 'clocked_out_at', 'accepted_at',
    'worked_seconds', 'hours_worked', 'status', 'late', 'absent', 'overtime', 'payroll_effect',
    'timesheet_effect', 'consequence', 'schedule_snapshot', 'outlet_id_override',
    'schedule_version', 'attendance_record_version', 'event_id',
  ]) {
    if (body?.[field] !== undefined) fail(`${field} is server managed`, 'attendance_server_managed_field')
  }
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
  const row = await db.prepare("SELECT * FROM ops_records WHERE entity = ? AND entity_id = ? AND deleted_at = '' LIMIT 1").bind(entity, id).first()
  return { row, record: rowRecord(row) }
}

async function findMutation(db, mutationId, requestFingerprint) {
  const row = await db.prepare('SELECT result_json FROM ops_mutations WHERE mutation_id = ? LIMIT 1').bind(mutationId).first()
  if (!row) return null
  const result = parseJson(row.result_json, {}) || {}
  if (!constantTimeEqual(result.request_fingerprint, requestFingerprint)) {
    fail('mutation_id was already used with a different request body', 'attendance_mutation_fingerprint_mismatch', 409)
  }
  return { ...result, replayed: true }
}

async function scheduleFor(db, user, outletId, businessDate, scheduleId = '') {
  const result = scheduleId
    ? await db.prepare(`SELECT * FROM ops_records WHERE entity = ? AND entity_id = ? AND outlet_id = ? AND business_date = ? AND status = 'scheduled' AND deleted_at = '' LIMIT 1`).bind(SCHEDULE_ENTITY, scheduleId, outletId, businessDate).all()
    : await db.prepare(`SELECT * FROM ops_records WHERE entity = ? AND outlet_id = ? AND business_date = ? AND status = 'scheduled' AND json_extract(payload_json, '$.employee_id') = ? AND deleted_at = '' ORDER BY json_extract(payload_json, '$.clock_in') LIMIT 2`).bind(SCHEDULE_ENTITY, outletId, businessDate, user.id).all()
  const rows = (result.results || []).filter((row) => {
    const record = rowRecord(row)
    return record?.authority_contract === SCHEDULE_CONTRACT && String(record.employee_id || '') === String(user.id)
  })
  if (rows.length > 1 && !scheduleId) fail('Multiple schedules require an explicit schedule_id', 'attendance_schedule_ambiguous', 409)
  return rows[0] ? rowRecord(rows[0]) : null
}

function scheduleSnapshot(schedule) {
  return {
    schedule_id: schedule.id,
    schedule_version: Number(schedule.__realtime?.version || schedule.version || 0),
    employee_id: schedule.employee_id,
    outlet_id: schedule.outlet_id,
    business_date: schedule.date,
    expected_start_local: schedule.clock_in,
    expected_end_local: schedule.clock_out,
    time_zone: schedule.time_zone,
    source_batch_id: schedule.source_batch_id,
    source_file_name: schedule.source_file_name,
    source_drive_file_id: schedule.source_drive_file_id,
    captured_authority_contract: SCHEDULE_CONTRACT,
  }
}

async function currentAttendance(db, userId, scheduleId) {
  const row = await db.prepare(`
    SELECT * FROM ops_records
    WHERE entity = ? AND json_extract(payload_json, '$.employee_id') = ?
      AND json_extract(payload_json, '$.schedule_snapshot.schedule_id') = ?
      AND json_extract(payload_json, '$.replacement_of') IS NULL
      AND deleted_at = ''
    ORDER BY created_at DESC LIMIT 1
  `).bind(RECORD_ENTITY, userId, scheduleId).first()
  return rowRecord(row)
}

async function latestReplacement(db, originalId) {
  const row = await db.prepare(`
    SELECT * FROM ops_records WHERE entity = ?
      AND json_extract(payload_json, '$.original_attendance_record_id') = ?
      AND status = 'completed' AND deleted_at = ''
    ORDER BY CAST(json_extract(payload_json, '$.correction_sequence') AS INTEGER) DESC LIMIT 1
  `).bind(RECORD_ENTITY, originalId).first()
  return rowRecord(row)
}

function mutationStatement(db, { mutationId, outletId, entityId, operation, actor, requestedAt, committedAt, result }) {
  return db.prepare(`
    INSERT INTO ops_mutations (
      mutation_id, outlet_id, entity, entity_id, operation, actor_email,
      actor_name, requested_at, committed_at, result_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(mutationId, outletId, RECORD_ENTITY, entityId, operation, actor.email, actor.full_name || actor.email, requestedAt, committedAt, JSON.stringify(result))
}

function recordInsert(db, entity, record, status, actor, timestamp, version = 1) {
  return db.prepare(`
    INSERT INTO ops_records (
      entity, entity_id, outlet_id, business_date, status, payload_json,
      version, created_at, created_by, updated_at, updated_by, deleted_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '')
  `).bind(entity, record.id, record.outlet_id, record.business_date, status, JSON.stringify(record), version, timestamp, actor.email, timestamp, actor.email)
}

function outboxInsert(db, mutationId, consequence, timestamp) {
  const message = {
    authority_contract: CONTRACT,
    projection_role: 'source_labelled_reporting_projection',
    source_entity: CONSEQUENCE_ENTITY,
    source_id: consequence.id,
    source_version: consequence.version,
    attendance_record_id: consequence.attendance_record_id,
    attendance_record_version: consequence.attendance_record_version,
    schedule_id: consequence.schedule_id,
    schedule_version: consequence.schedule_version,
    employee_id: consequence.employee_id,
    outlet_id: consequence.outlet_id,
    business_date: consequence.business_date,
    consequence_type: consequence.consequence_type,
    worked_seconds: consequence.worked_seconds,
    payroll_effect: 'none',
    timesheet_effect: 'none',
    created_at: timestamp,
  }
  return db.prepare(`
    INSERT INTO sheet_sync_outbox (
      mutation_id, entity, entity_id, outlet_id, operation, payload_json,
      status, attempts, next_attempt_at
    ) VALUES (?, ?, ?, ?, 'attendance_report_projection', ?, 'pending', 0, ?)
  `).bind(mutationId, CONSEQUENCE_ENTITY, consequence.id, consequence.outlet_id, JSON.stringify(message), timestamp)
}

async function context(request, env, url) {
  const user = await freshHuman(request, env, 'attendance.view_self')
  const outletId = requireAssignedOutlet(user, url.searchParams.get('outlet_id'))
  const businessDate = requireDate(url.searchParams.get('business_date'))
  const schedule = await scheduleFor(database(env), user, outletId, businessDate, String(url.searchParams.get('schedule_id') || ''))
  if (!schedule) {
    return { ok: true, authority_contract: CONTRACT, outlet_id: outletId, business_date: businessDate, schedule: null, attendance_record: null, consequence: null, completion: { complete: false, reason: 'no_bound_schedule' } }
  }
  const attendance = await currentAttendance(database(env), user.id, schedule.id)
  const replacement = attendance ? await latestReplacement(database(env), attendance.id) : null
  const effective = replacement || attendance
  let consequence = null
  if (effective?.status === 'completed') {
    const row = await database(env).prepare(`SELECT * FROM ops_records WHERE entity = ? AND json_extract(payload_json, '$.attendance_record_id') = ? AND deleted_at = '' ORDER BY created_at DESC LIMIT 1`).bind(CONSEQUENCE_ENTITY, effective.id).first()
    consequence = rowRecord(row)
  }
  const capturedVersion = Number(attendance?.schedule_snapshot?.schedule_version || 0)
  const currentVersion = Number(schedule.__realtime?.version || 0)
  return {
    ok: true,
    authority_contract: CONTRACT,
    outlet_id: outletId,
    business_date: businessDate,
    schedule,
    attendance_record: effective,
    original_attendance_record: replacement ? attendance : null,
    consequence,
    schedule_drift: Boolean(attendance && capturedVersion !== currentVersion),
    completion: {
      complete: Boolean(effective?.status === 'completed' && consequence),
      fact: effective?.status === 'completed' && consequence
        ? 'Attendance event is authoritative and drives an explicit report consequence.'
        : 'Attendance consequence is not complete.',
    },
    financial_mutation_authority: 'none',
  }
}

async function clockIn(request, env, body) {
  rejectUnsupportedScope(body)
  rejectServerManaged(body)
  const actor = await freshHuman(request, env, 'attendance.clock_self')
  const outletId = requireAssignedOutlet(actor, body.outlet_id)
  const businessDate = requireDate(body.business_date)
  const scheduleId = String(body.schedule_id || '').trim()
  if (!scheduleId) fail('schedule_id is required', 'attendance_schedule_required')
  const mutationId = requireMutationId(request, body)
  const requestFingerprint = await fingerprint('clock_in', body)
  const replay = await findMutation(database(env), mutationId, requestFingerprint)
  if (replay) return replay
  const schedule = await scheduleFor(database(env), actor, outletId, businessDate, scheduleId)
  if (!schedule) fail('A current, employee-bound D1 schedule was not found', 'attendance_schedule_not_found', 404)
  if (await currentAttendance(database(env), actor.id, schedule.id)) fail('Attendance has already started for this schedule', 'attendance_already_started', 409)

  const timestamp = now()
  const digest = await sha256(`${schedule.id}|${actor.id}`)
  const recordId = `attendance-record-${digest.slice(0, 36)}`
  const eventId = `${recordId}:clock-in`
  const record = {
    id: recordId, authority_contract: CONTRACT, record_family: 'authoritative_attendance', lifecycle: 'LC-ATTENDANCE-RECORD',
    lifecycle_transition: 'TR-011-001', command_id: 'CMD-WRK-02-051', status: 'clocked_in',
    employee_id: actor.id, employee_email: actor.email, employee_name: actor.full_name || actor.email,
    outlet_id: outletId, business_date: businessDate, schedule_snapshot: scheduleSnapshot(schedule),
    clocked_in_at: timestamp, clocked_out_at: '', worked_seconds: null,
    event_ids: [eventId], replacement_of: null, original_attendance_record_id: null,
    payroll_effect: 'none', timesheet_effect: 'none', report_consequence_id: '', version: 1,
    created_at: timestamp, created_by: actor.email, updated_at: timestamp, updated_by: actor.email,
  }
  const event = {
    id: eventId, authority_contract: CONTRACT, event_type: 'clock_in', acceptance_source: 'trusted_server_runtime',
    attendance_record_id: recordId, employee_id: actor.id, outlet_id: outletId, business_date: businessDate,
    schedule_id: schedule.id, schedule_version: Number(schedule.__realtime?.version || 0), accepted_at: timestamp,
    client_timestamp_authority: 'none', version: 1,
  }
  const result = { ok: true, replayed: false, request_fingerprint: requestFingerprint, mutation_id: mutationId, record, event, consequence: null, committed_at: timestamp }
  try {
    await database(env).batch([
      recordInsert(database(env), RECORD_ENTITY, record, 'clocked_in', actor, timestamp),
      recordInsert(database(env), EVENT_ENTITY, event, 'accepted', actor, timestamp),
      mutationStatement(database(env), { mutationId, outletId, entityId: recordId, operation: 'clock_in', actor, requestedAt: String(body.requested_at || timestamp), committedAt: timestamp, result }),
    ])
  } catch (error) {
    const concurrent = await findMutation(database(env), mutationId, requestFingerprint)
    if (concurrent) return concurrent
    fail('Attendance clock-in lost a concurrent race', 'attendance_concurrency_conflict', 409)
  }
  return result
}

async function clockOut(request, env, body) {
  rejectUnsupportedScope(body)
  rejectServerManaged(body)
  const actor = await freshHuman(request, env, 'attendance.clock_self')
  const outletId = requireAssignedOutlet(actor, body.outlet_id)
  const recordId = String(body.attendance_record_id || '').trim()
  if (!recordId) fail('attendance_record_id is required', 'attendance_record_required')
  const mutationId = requireMutationId(request, body)
  const requestFingerprint = await fingerprint('clock_out', body)
  const replay = await findMutation(database(env), mutationId, requestFingerprint)
  if (replay) return replay
  const found = await findRecord(database(env), RECORD_ENTITY, recordId)
  const current = found.record
  if (!current || current.authority_contract !== CONTRACT) fail('Authoritative attendance record was not found', 'attendance_record_not_found', 404)
  if (current.employee_id !== actor.id || current.outlet_id !== outletId) fail('Only the assigned employee may clock out this attendance record', 'attendance_resource_scope_denied', 403)
  if (current.status !== 'clocked_in') fail('Attendance must be clocked in before clock-out', 'attendance_lifecycle_conflict', 409)
  const timestamp = now()
  const start = Date.parse(current.clocked_in_at)
  const end = Date.parse(timestamp)
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) fail('Trusted attendance timestamps are invalid', 'attendance_timestamp_invalid', 409)
  const workedSeconds = Math.floor((end - start) / 1000)
  const eventId = `${recordId}:clock-out`
  const consequenceId = `${recordId}:worked-time`
  const nextVersion = Number(found.row.version || current.version || 1) + 1
  const completed = {
    ...bare(current), status: 'completed', lifecycle_transition: 'TR-011-002', command_id: 'CMD-WRK-02-052',
    clocked_out_at: timestamp, worked_seconds: workedSeconds,
    event_ids: [...new Set([...(current.event_ids || []), eventId])], report_consequence_id: consequenceId,
    version: nextVersion, updated_at: timestamp, updated_by: actor.email,
  }
  const event = {
    id: eventId, authority_contract: CONTRACT, event_type: 'clock_out', acceptance_source: 'trusted_server_runtime',
    attendance_record_id: recordId, employee_id: actor.id, outlet_id: outletId, business_date: current.business_date,
    schedule_id: current.schedule_snapshot.schedule_id, schedule_version: current.schedule_snapshot.schedule_version,
    accepted_at: timestamp, client_timestamp_authority: 'none', version: 1,
  }
  const consequence = {
    id: consequenceId, authority_contract: CONTRACT, consequence_type: 'accepted_worked_time', status: 'recorded',
    attendance_record_id: recordId, attendance_record_version: nextVersion,
    schedule_id: current.schedule_snapshot.schedule_id, schedule_version: current.schedule_snapshot.schedule_version,
    employee_id: actor.id, outlet_id: outletId, business_date: current.business_date, worked_seconds: workedSeconds,
    report_effect: 'source_labelled_projection_enqueued', payroll_effect: 'none', timesheet_effect: 'none',
    policy_classification: 'not_inferred', version: 1, created_at: timestamp,
  }
  const result = { ok: true, replayed: false, request_fingerprint: requestFingerprint, mutation_id: mutationId, record: completed, event, consequence, committed_at: timestamp }
  try {
    await database(env).batch([
      database(env).prepare(`UPDATE ops_records SET status = 'completed', payload_json = ?, version = ?, updated_at = ?, updated_by = ? WHERE entity = ? AND entity_id = ? AND version = ? AND status = 'clocked_in' AND deleted_at = ''`).bind(JSON.stringify(completed), nextVersion, timestamp, actor.email, RECORD_ENTITY, recordId, Number(found.row.version || 0)),
      recordInsert(database(env), EVENT_ENTITY, event, 'accepted', actor, timestamp),
      recordInsert(database(env), CONSEQUENCE_ENTITY, consequence, 'recorded', actor, timestamp),
      mutationStatement(database(env), { mutationId, outletId, entityId: recordId, operation: 'clock_out', actor, requestedAt: String(body.requested_at || timestamp), committedAt: timestamp, result }),
      outboxInsert(database(env), mutationId, consequence, timestamp),
    ])
  } catch (error) {
    const concurrent = await findMutation(database(env), mutationId, requestFingerprint)
    if (concurrent) return concurrent
    fail('Attendance clock-out lost a concurrent race', 'attendance_concurrency_conflict', 409)
  }
  return result
}

function correctedInstant(value, field) {
  const text = String(value || '').trim()
  const milliseconds = Date.parse(text)
  if (!text || !Number.isFinite(milliseconds)) fail(`${field} must be an ISO timestamp`, 'attendance_correction_timestamp_invalid')
  return { text: new Date(milliseconds).toISOString(), milliseconds }
}

async function correct(request, env, body) {
  rejectUnsupportedScope(body)
  const actor = await freshHuman(request, env, 'attendance.correct')
  const originalId = String(body.original_attendance_record_id || '').trim()
  if (!originalId) fail('original_attendance_record_id is required', 'attendance_original_record_required')
  const reason = String(body.reason || '').trim()
  if (reason.length < 8 || reason.length > 1000) fail('A correction reason of 8–1000 characters is required', 'attendance_correction_reason_required')
  const allowed = new Set(['mutation_id', 'requested_at', 'original_attendance_record_id', 'corrected_clocked_in_at', 'corrected_clocked_out_at', 'reason', 'outlet_id'])
  for (const key of Object.keys(body || {})) if (!allowed.has(key)) fail(`${key} is not accepted by the correction command`, 'attendance_correction_field_unsupported')
  const outletId = requireAssignedOutlet(actor, body.outlet_id)
  const mutationId = requireMutationId(request, body)
  const requestFingerprint = await fingerprint('correct', body)
  const replay = await findMutation(database(env), mutationId, requestFingerprint)
  if (replay) return replay
  const original = (await findRecord(database(env), RECORD_ENTITY, originalId)).record
  if (!original || original.authority_contract !== CONTRACT || original.status !== 'completed') fail('A completed authoritative attendance record is required', 'attendance_original_record_invalid', 409)
  if (original.outlet_id !== outletId) fail('Correction is outside the principal outlet scope', 'attendance_resource_scope_denied', 403)
  const start = correctedInstant(body.corrected_clocked_in_at, 'corrected_clocked_in_at')
  const end = correctedInstant(body.corrected_clocked_out_at, 'corrected_clocked_out_at')
  if (end.milliseconds < start.milliseconds) fail('Corrected clock-out must not precede clock-in', 'attendance_correction_interval_invalid')
  const prior = await latestReplacement(database(env), originalId)
  const sequence = Number(prior?.correction_sequence || 0) + 1
  const timestamp = now()
  const replacementId = `${originalId}:correction:${sequence}`
  const consequenceId = `${replacementId}:worked-time`
  const workedSeconds = Math.floor((end.milliseconds - start.milliseconds) / 1000)
  const replacement = {
    id: replacementId, authority_contract: CONTRACT, record_family: 'authoritative_attendance_correction', lifecycle: 'LC-ATTENDANCE-RECORD',
    candidate_operation: 'attendance.correct', command_id: null, status: 'completed',
    employee_id: original.employee_id, employee_email: original.employee_email, employee_name: original.employee_name,
    outlet_id: outletId, business_date: original.business_date, schedule_snapshot: original.schedule_snapshot,
    clocked_in_at: start.text, clocked_out_at: end.text, worked_seconds: workedSeconds, event_ids: [],
    replacement_of: prior?.id || originalId, original_attendance_record_id: originalId, correction_sequence: sequence,
    correction_reason: reason, corrected_by_id: actor.id, corrected_by_email: actor.email,
    payroll_effect: 'none', timesheet_effect: 'none', report_consequence_id: consequenceId, version: 1,
    created_at: timestamp, created_by: actor.email, updated_at: timestamp, updated_by: actor.email,
  }
  const consequence = {
    id: consequenceId, authority_contract: CONTRACT, consequence_type: 'corrected_worked_time', status: 'recorded',
    attendance_record_id: replacementId, attendance_record_version: 1,
    schedule_id: original.schedule_snapshot.schedule_id, schedule_version: original.schedule_snapshot.schedule_version,
    employee_id: original.employee_id, outlet_id: outletId, business_date: original.business_date, worked_seconds: workedSeconds,
    replaces_consequence_id: prior?.report_consequence_id || original.report_consequence_id,
    report_effect: 'source_labelled_projection_enqueued', payroll_effect: 'none', timesheet_effect: 'none',
    policy_classification: 'not_inferred', version: 1, created_at: timestamp,
  }
  const result = { ok: true, replayed: false, request_fingerprint: requestFingerprint, mutation_id: mutationId, record: replacement, original_record_unchanged: true, consequence, committed_at: timestamp }
  try {
    await database(env).batch([
      recordInsert(database(env), RECORD_ENTITY, replacement, 'completed', actor, timestamp),
      recordInsert(database(env), CONSEQUENCE_ENTITY, consequence, 'recorded', actor, timestamp),
      mutationStatement(database(env), { mutationId, outletId, entityId: replacementId, operation: 'correct', actor, requestedAt: String(body.requested_at || timestamp), committedAt: timestamp, result }),
      outboxInsert(database(env), mutationId, consequence, timestamp),
    ])
  } catch (error) {
    const concurrent = await findMutation(database(env), mutationId, requestFingerprint)
    if (concurrent) return concurrent
    fail('Attendance correction lost a concurrent race', 'attendance_concurrency_conflict', 409)
  }
  return result
}

export async function handleAttendanceWorkforceApi(request, env, url) {
  if (!url.pathname.startsWith('/api/attendance/workforce/')) return null
  try {
    if (url.pathname === '/api/attendance/workforce/context' && request.method === 'GET') {
      return json(request, env, await context(request, env, url))
    }
    if (request.method !== 'POST') fail('Method not allowed', 'method_not_allowed', 405)
    const body = await readJson(request)
    const result = url.pathname === '/api/attendance/workforce/clock-in'
      ? await clockIn(request, env, body)
      : url.pathname === '/api/attendance/workforce/clock-out'
        ? await clockOut(request, env, body)
        : url.pathname === '/api/attendance/workforce/correct'
          ? await correct(request, env, body)
          : null
    if (!result) return null
    return json(request, env, result, result.replayed ? 200 : 201)
  } catch (error) {
    return errorResponse(request, env, error)
  }
}

export const ATTENDANCE_WORKFORCE_POLICY = Object.freeze({
  contract: CONTRACT,
  schedule_contract: SCHEDULE_CONTRACT,
  schedule_entity: SCHEDULE_ENTITY,
  attendance_entity: RECORD_ENTITY,
  event_entity: EVENT_ENTITY,
  consequence_entity: CONSEQUENCE_ENTITY,
  completion_fact: 'Attendance event is authoritative and drives an explicit report consequence.',
  payroll_effect: 'none',
  timesheet_effect: 'none',
})
