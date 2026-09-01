import { getCurrentUser } from './auth.js'
import { errorResponse, readJson } from './http.js'
import { assertAssignedOutletAccess, assignedOutletIds } from './permissions.js'

const LOCK_LEASE_MS = 90_000

function now() {
  return new Date().toISOString()
}

function changes(result) {
  return Number(result?.meta?.changes || result?.changes || 0)
}

function database(env) {
  if (!env.OPS_DB?.prepare) {
    const error = new Error('Realtime D1 database is not configured')
    error.status = 503
    error.code = 'realtime_database_unavailable'
    throw error
  }
  return env.OPS_DB
}

async function describeLock(request, url, user, env) {
  if (request.method !== 'POST') return null
  const isTask = url.pathname === '/api/tasks/operational/action'
  const isStock = url.pathname === '/api/stock-counts/batch'
  const isCash = ['/api/cash-close/submit', '/api/cash-close/review', '/api/cash-close/correct'].includes(url.pathname)
  const isReconciliation = [
    '/api/payment-reconciliation/start',
    '/api/payment-reconciliation/reveal',
    '/api/payment-reconciliation/remark',
    '/api/payment-reconciliation/submit',
    '/api/payment-reconciliation/replace',
  ].includes(url.pathname)
  const isAttendance = [
    '/api/attendance/workforce/clock-in',
    '/api/attendance/workforce/clock-out',
    '/api/attendance/workforce/correct',
  ].includes(url.pathname)
  if (!isTask && !isStock && !isCash && !isReconciliation && !isAttendance) return null

  const body = await readJson(request.clone())
  let cashRecord = null
  if (isCash && url.pathname !== '/api/cash-close/submit') {
    const closeId = String(body.close_id || body.original_close_id || '').trim()
    if (!closeId) {
      const error = new Error('close_id or original_close_id is required')
      error.status = 400
      error.code = 'cash_close_id_required'
      throw error
    }
    cashRecord = await database(env).prepare(`
      SELECT outlet_id, business_date, payload_json
      FROM ops_records
      WHERE entity = 'CloseUp' AND entity_id = ? AND deleted_at = ''
      LIMIT 1
    `).bind(closeId).first()
    if (!cashRecord) {
      const error = new Error('Authoritative Close Up was not found')
      error.status = 404
      error.code = 'cash_close_not_found'
      throw error
    }
  }
  let reconciliationRecord = null
  if (isReconciliation && url.pathname !== '/api/payment-reconciliation/start') {
    const reconciliationId = String(body.reconciliation_id || body.original_reconciliation_id || '').trim()
    if (!reconciliationId) {
      const error = new Error('reconciliation_id or original_reconciliation_id is required')
      error.status = 400
      error.code = 'payment_reconciliation_id_required'
      throw error
    }
    reconciliationRecord = await database(env).prepare(`
      SELECT outlet_id, business_date, payload_json
      FROM ops_records
      WHERE entity = 'PaymentReconciliation' AND entity_id = ? AND deleted_at = ''
      LIMIT 1
    `).bind(reconciliationId).first()
    if (!reconciliationRecord) {
      const error = new Error('Authoritative Payment Reconciliation was not found')
      error.status = 404
      error.code = 'payment_reconciliation_not_found'
      throw error
    }
  }
  let attendanceRecord = null
  if (isAttendance && url.pathname !== '/api/attendance/workforce/clock-in') {
    const attendanceId = String(body.attendance_record_id || body.original_attendance_record_id || '').trim()
    if (!attendanceId) {
      const error = new Error('attendance_record_id or original_attendance_record_id is required')
      error.status = 400
      error.code = 'attendance_record_required'
      throw error
    }
    attendanceRecord = await database(env).prepare(`
      SELECT outlet_id, business_date, payload_json
      FROM ops_records
      WHERE entity = 'AttendanceRecord' AND entity_id = ? AND deleted_at = ''
      LIMIT 1
    `).bind(attendanceId).first()
    if (!attendanceRecord) {
      const error = new Error('Authoritative Attendance record was not found')
      error.status = 404
      error.code = 'attendance_record_not_found'
      throw error
    }
  }
  const outletId = String(
    body.outlet_id || cashRecord?.outlet_id || reconciliationRecord?.outlet_id || attendanceRecord?.outlet_id || user.outlet_id || assignedOutletIds(user)[0] || '',
  ).trim()
  if (!outletId) {
    const error = new Error('Your account is not assigned to an outlet')
    error.status = 400
    error.code = 'missing_outlet'
    throw error
  }
  assertAssignedOutletAccess(user, outletId)

  if (isCash) {
    const stored = cashRecord?.payload_json ? JSON.parse(cashRecord.payload_json) : null
    const businessDate = String(body.business_date || cashRecord?.business_date || stored?.business_date || '').trim()
    const shiftId = String(body.shift_id || stored?.shift_id || 'night').trim().toLowerCase()
    if (!/^\d{4}-\d{2}-\d{2}$/.test(businessDate)) {
      const error = new Error('business_date must use YYYY-MM-DD')
      error.status = 400
      error.code = 'invalid_business_date'
      throw error
    }
    return {
      scopeKey: `cash-close:${outletId}:${businessDate}:${shiftId}`,
      outletId,
      resourceType: 'cash-close',
      resourceId: `${businessDate}:${shiftId}`,
      action: url.pathname.split('/').at(-1),
      label: 'Cash Close',
    }
  }

  if (isReconciliation) {
    const stored = reconciliationRecord?.payload_json ? JSON.parse(reconciliationRecord.payload_json) : null
    const businessDate = String(body.business_date || reconciliationRecord?.business_date || stored?.business_date || '').trim()
    const shiftId = String(body.shift_id || stored?.shift_id || 'night').trim().toLowerCase()
    if (!/^\d{4}-\d{2}-\d{2}$/.test(businessDate)) {
      const error = new Error('business_date must use YYYY-MM-DD')
      error.status = 400
      error.code = 'invalid_business_date'
      throw error
    }
    return {
      scopeKey: `payment-reconciliation:${outletId}:${businessDate}:${shiftId}`,
      outletId,
      resourceType: 'payment-reconciliation',
      resourceId: `${businessDate}:${shiftId}`,
      action: url.pathname.split('/').at(-1),
      label: 'Payment Reconciliation',
    }
  }

  if (isAttendance) {
    const resourceId = String(
      body.schedule_id || body.attendance_record_id || body.original_attendance_record_id || '',
    ).trim()
    if (!resourceId) {
      const error = new Error('Attendance command resource identifier is required')
      error.status = 400
      error.code = 'attendance_resource_required'
      throw error
    }
    return {
      scopeKey: `attendance:${outletId}:${resourceId}`,
      outletId,
      resourceType: 'attendance',
      resourceId,
      action: url.pathname.split('/').at(-1),
      label: 'Attendance',
    }
  }

  if (isTask) {
    const action = String(body.action || '').trim().toLowerCase()
    if (!['save', 'complete'].includes(action)) return null
    const taskId = String(body.task_id || '').trim()
    if (!taskId) {
      const error = new Error('task_id is required')
      error.status = 400
      error.code = 'missing_task_id'
      throw error
    }
    return {
      scopeKey: `task:${outletId}:${taskId}`,
      outletId,
      resourceType: 'task',
      resourceId: taskId,
      action,
      label: '任务',
    }
  }

  const countDate = String(body.count_date || '').trim()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(countDate)) {
    const error = new Error('count_date must use YYYY-MM-DD')
    error.status = 400
    error.code = 'invalid_count_date'
    throw error
  }
  return {
    scopeKey: `stock:${outletId}:${countDate}`,
    outletId,
    resourceType: 'stock',
    resourceId: countDate,
    action: 'save',
    label: '库存盘点',
  }
}

async function acquireLock(env, descriptor, user, clientId) {
  const db = database(env)
  const ownerToken = crypto.randomUUID()
  const acquiredAt = now()
  const expiresAt = new Date(Date.now() + LOCK_LEASE_MS).toISOString()

  const result = await db.prepare(`
    INSERT INTO ops_submission_locks (
      scope_key, outlet_id, resource_type, resource_id, owner_token,
      owner_client_id, owner_email, owner_name, acquired_at, expires_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(scope_key) DO UPDATE SET
      outlet_id = excluded.outlet_id,
      resource_type = excluded.resource_type,
      resource_id = excluded.resource_id,
      owner_token = excluded.owner_token,
      owner_client_id = excluded.owner_client_id,
      owner_email = excluded.owner_email,
      owner_name = excluded.owner_name,
      acquired_at = excluded.acquired_at,
      expires_at = excluded.expires_at,
      updated_at = excluded.updated_at
    WHERE ops_submission_locks.expires_at <= excluded.acquired_at
  `).bind(
    descriptor.scopeKey,
    descriptor.outletId,
    descriptor.resourceType,
    descriptor.resourceId,
    ownerToken,
    clientId,
    user.email || '',
    user.full_name || user.email || '',
    acquiredAt,
    expiresAt,
    acquiredAt,
  ).run()

  if (changes(result) > 0) {
    return {
      acquired: true,
      ...descriptor,
      ownerToken,
      ownerClientId: clientId,
      ownerEmail: user.email || '',
      ownerName: user.full_name || user.email || '',
      acquiredAt,
      expiresAt,
    }
  }

  const current = await db.prepare(`
    SELECT scope_key, outlet_id, resource_type, resource_id, owner_client_id,
           owner_email, owner_name, acquired_at, expires_at
    FROM ops_submission_locks
    WHERE scope_key = ?
    LIMIT 1
  `).bind(descriptor.scopeKey).first()

  return {
    acquired: false,
    ...descriptor,
    ownerClientId: String(current?.owner_client_id || ''),
    ownerEmail: String(current?.owner_email || ''),
    ownerName: String(current?.owner_name || current?.owner_email || '其他员工'),
    acquiredAt: String(current?.acquired_at || ''),
    expiresAt: String(current?.expires_at || expiresAt),
  }
}

async function releaseLock(env, lock) {
  if (!lock?.acquired) return false
  const result = await database(env).prepare(`
    DELETE FROM ops_submission_locks
    WHERE scope_key = ? AND owner_token = ?
  `).bind(lock.scopeKey, lock.ownerToken).run()
  return changes(result) > 0
}

async function broadcastLock(env, lock, type) {
  if (!env.OUTLET_REALTIME?.getByName || !lock?.outletId) return
  try {
    const stub = env.OUTLET_REALTIME.getByName(lock.outletId)
    await stub.fetch('https://chefops-realtime.internal/broadcast', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-ChefOps-Realtime-Internal': '1',
      },
      body: JSON.stringify({
        id: crypto.randomUUID(),
        type,
        entity: 'SubmissionLock',
        scope_key: lock.scopeKey,
        resource_type: lock.resourceType,
        resource_id: lock.resourceId,
        resource_label: lock.label,
        action: lock.action,
        outlet_id: lock.outletId,
        origin_client_id: lock.ownerClientId || '',
        owner: {
          email: lock.ownerEmail || '',
          name: lock.ownerName || lock.ownerEmail || '其他员工',
        },
        acquired_at: lock.acquiredAt || '',
        expires_at: lock.expiresAt || '',
        occurred_at: now(),
      }),
    })
  } catch (error) {
    console.error('Unable to broadcast submission lock', type, error)
  }
}

function lockedError(lock) {
  const error = new Error(`${lock.ownerName || '其他员工'} 正在保存，请稍候`)
  error.status = 423
  error.code = 'submission_locked'
  error.details = {
    scope_key: lock.scopeKey,
    resource_type: lock.resourceType,
    resource_id: lock.resourceId,
    resource_label: lock.label,
    action: lock.action,
    outlet_id: lock.outletId,
    owner_client_id: lock.ownerClientId,
    owner_email: lock.ownerEmail,
    owner_name: lock.ownerName,
    acquired_at: lock.acquiredAt,
    expires_at: lock.expiresAt,
    retry_after_ms: 900,
  }
  return error
}

export async function withSubmissionLock(request, env, url, operation) {
  try {
    const user = await getCurrentUser(request, env)
    const descriptor = await describeLock(request, url, user, env)
    if (!descriptor) return operation()

    const clientId = String(request.headers.get('X-ChefOps-Client-Id') || '').trim()
    const lock = await acquireLock(env, descriptor, user, clientId)
    if (!lock.acquired) return errorResponse(request, env, lockedError(lock))

    await broadcastLock(env, lock, 'submission_lock.acquired')
    try {
      return await operation()
    } finally {
      const released = await releaseLock(env, lock)
      if (released) await broadcastLock(env, lock, 'submission_lock.released')
    }
  } catch (error) {
    return errorResponse(request, env, error)
  }
}
