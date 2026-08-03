import { getCurrentUser } from './auth.js'
import { errorResponse, json, readJson } from './http.js'
import { assertOutletAccess } from './permissions.js'
import { findDirectoryRecord } from './d1-directory-store.js'
import { appendRecords, updateManyRecords } from './sheets.js'

const ENTITY = 'Attendance'
const IMPORT_OPERATION = 'roster_replace'
const MAX_ROWS = 500
const MAX_DATES = 14

function now() {
  return new Date().toISOString()
}

function parseJson(value, fallback = null) {
  try { return JSON.parse(String(value || '')) } catch { return fallback }
}

function database(env) {
  if (!env.OPS_DB?.prepare) {
    const error = new Error('OPS D1 database is not configured for Duty Roster')
    error.status = 503
    error.code = 'roster_d1_unavailable'
    throw error
  }
  return env.OPS_DB
}

function managerOnly(user) {
  const role = String(user?.role || '').toLowerCase().replace(/^role_/, '')
  if (role === 'manager' || role === 'owner') return
  const error = new Error('Manager access required to import a duty roster')
  error.status = 403
  error.code = 'manager_required'
  throw error
}

function validDate(value) {
  const date = String(value || '').slice(0, 10)
  return /^20\d{2}-\d{2}-\d{2}$/.test(date) ? date : ''
}

function normalizeTime(value) {
  const match = String(value || '').trim().match(/^(\d{1,2}):(\d{2})$/)
  if (!match) return ''
  const hour = Number(match[1])
  const minute = Number(match[2])
  if (!Number.isInteger(hour) || hour < 0 || hour > 23 || !Number.isInteger(minute) || minute < 0 || minute > 59) return ''
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
}

function rosterHours(clockIn, clockOut) {
  const minutes = (value) => {
    const [hour, minute] = String(value || '').split(':').map(Number)
    return (Number(hour) || 0) * 60 + (Number(minute) || 0)
  }
  const start = minutes(clockIn)
  let end = minutes(clockOut)
  if (end <= start) end += 24 * 60
  return Math.round(((end - start) / 60) * 100) / 100
}

function canonicalName(value) {
  return String(value || '').replace(/\s+/g, ' ').trim()
}

function canonicalKey(outletId, row) {
  return [
    String(outletId || '').trim(),
    row.date,
    canonicalName(row.staff_name).toLocaleUpperCase('en-MY'),
    row.clock_in,
    row.clock_out,
  ].join('|')
}

async function digestText(value) {
  const bytes = new TextEncoder().encode(String(value || ''))
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

export async function rosterEntityId(outletId, row) {
  const digest = await digestText(canonicalKey(outletId, row))
  return `attendance-roster-${digest.slice(0, 36)}`
}

export async function normalizeRosterRows(rows, outletId) {
  if (!Array.isArray(rows) || rows.length < 1 || rows.length > MAX_ROWS) {
    const error = new Error(`Provide between 1 and ${MAX_ROWS} roster rows`)
    error.status = 400
    error.code = 'invalid_roster_import'
    throw error
  }

  const seen = new Set()
  const normalized = []
  let duplicateCount = 0

  for (const input of rows) {
    const staffName = canonicalName(input?.staff_name)
    const date = validDate(input?.date)
    const clockIn = normalizeTime(input?.clock_in)
    const clockOut = normalizeTime(input?.clock_out)
    if (!staffName || !date || !clockIn || !clockOut) {
      const error = new Error(`Invalid roster row for ${staffName || 'unknown staff'}`)
      error.status = 400
      error.code = 'invalid_roster_row'
      throw error
    }

    const row = {
      staff_name: staffName,
      staff_role: String(input?.staff_role || 'staff').trim().toLowerCase().replace(/^role_/, '') || 'staff',
      date,
      clock_in: clockIn,
      clock_out: clockOut,
      status: 'scheduled',
      hours_worked: Number.isFinite(Number(input?.hours_worked))
        ? Number(input.hours_worked)
        : rosterHours(clockIn, clockOut),
      notes: String(input?.notes || '').trim(),
      duty_summary: String(input?.duty_summary || '').trim(),
    }
    const key = canonicalKey(outletId, row)
    if (seen.has(key)) {
      duplicateCount += 1
      continue
    }
    seen.add(key)
    normalized.push({ ...row, id: await rosterEntityId(outletId, row) })
  }

  const dates = [...new Set(normalized.map((row) => row.date))].sort()
  if (!dates.length || dates.length > MAX_DATES) {
    const error = new Error(`Duty Roster must contain between 1 and ${MAX_DATES} valid dates`)
    error.status = 400
    error.code = 'invalid_roster_dates'
    throw error
  }

  normalized.sort((left, right) => (
    left.date.localeCompare(right.date)
    || left.clock_in.localeCompare(right.clock_in)
    || left.staff_name.localeCompare(right.staff_name, undefined, { sensitivity: 'base' })
  ))
  return { rows: normalized, dates, duplicateCount }
}

function sourceNotes(row, source, batchId) {
  return [
    String(row.notes || '').trim(),
    `Imported roster batch: ${batchId}.`,
    source.file_name ? `Source file: ${String(source.file_name).trim()}` : '',
    source.file_url ? `Source PDF: ${String(source.file_url).trim()}` : '',
  ].filter(Boolean).join(' ')
}

function buildRecord(row, outletId, actor, source, batchId, existingRow, timestamp) {
  const existing = parseJson(existingRow?.payload_json, {}) || {}
  const version = Number(existingRow?.version || 0) + 1
  return {
    id: row.id,
    outlet_id: outletId,
    created_date: existing.created_date || existingRow?.created_at || timestamp,
    created_by: existing.created_by || existingRow?.created_by || actor.email,
    updated_date: timestamp,
    updated_by: actor.email,
    deleted_at: '',
    version,
    staff_name: row.staff_name,
    staff_role: row.staff_role,
    date: row.date,
    clock_in: row.clock_in,
    clock_out: row.clock_out,
    status: 'scheduled',
    hours_worked: row.hours_worked,
    notes: sourceNotes(row, source, batchId),
  }
}

async function findReplay(db, mutationId) {
  const row = await db.prepare(
    'SELECT result_json FROM ops_mutations WHERE mutation_id = ? LIMIT 1',
  ).bind(mutationId).first()
  const result = parseJson(row?.result_json, null)
  return result ? { ...result, replayed: true } : null
}

function requestMutationId(request, body) {
  const supplied = String(body?.mutation_id || request.headers.get('X-ChefOps-Mutation-Id') || '').trim()
  return (supplied || `attendance-roster:${crypto.randomUUID()}`).slice(0, 150)
}

async function enqueueMirror(env, message) {
  if (!env.SHEET_SYNC_QUEUE?.send) return false
  try {
    await env.SHEET_SYNC_QUEUE.send(message)
    await env.OPS_DB.prepare(`
      UPDATE sheet_sync_outbox
      SET status = 'queued', queued_at = ?, last_error = ''
      WHERE mutation_id = ?
    `).bind(now(), message.mutation_id).run()
    return true
  } catch (error) {
    console.error('Unable to queue Duty Roster Sheet mirror', message.mutation_id, error)
    return false
  }
}

async function broadcastRosterEvent(env, message, result) {
  if (!env.OUTLET_REALTIME?.getByName) return
  try {
    const stub = env.OUTLET_REALTIME.getByName(message.outlet_id)
    await stub.fetch('https://chefops-realtime.internal/broadcast', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-ChefOps-Realtime-Internal': '1',
      },
      body: JSON.stringify({
        id: crypto.randomUUID(),
        type: 'attendance.roster_replaced',
        mutation_id: message.mutation_id,
        entity: ENTITY,
        outlet_id: message.outlet_id,
        dates: message.dates,
        imported: result.imported,
        replaced: result.replaced,
        occurred_at: result.committed_at,
      }),
    })
  } catch (error) {
    console.error('Unable to broadcast Duty Roster replacement', message.mutation_id, error)
  }
}

export async function commitAttendanceRoster(request, env, actor, body) {
  managerOnly(actor)
  const outletId = String(body?.outlet_id || '').trim()
  if (!outletId) {
    const error = new Error('Choose an outlet before importing the Duty Roster')
    error.status = 400
    error.code = 'roster_outlet_required'
    throw error
  }
  assertOutletAccess(actor, outletId)

  const outlet = await findDirectoryRecord(env, 'Outlet', outletId)
  if (!outlet) {
    const error = new Error('The selected outlet was not found in D1')
    error.status = 404
    error.code = 'roster_outlet_not_found'
    throw error
  }

  const normalized = await normalizeRosterRows(body?.rows, outletId)
  const replaceExisting = body?.replace_existing !== false
  const source = {
    file_name: String(body?.source?.file_name || '').trim(),
    file_url: String(body?.source?.file_url || '').trim(),
    drive_file_id: String(body?.source?.drive_file_id || '').trim(),
  }
  const db = database(env)
  const mutationId = requestMutationId(request, body)
  const replay = await findReplay(db, mutationId)
  if (replay) return replay

  const placeholders = normalized.dates.map(() => '?').join(', ')
  const existingResponse = await db.prepare(`
    SELECT * FROM ops_records
    WHERE entity = '${ENTITY}' AND outlet_id = ?
      AND business_date IN (${placeholders})
      AND (
        status = 'scheduled'
        OR lower(COALESCE(json_extract(payload_json, '$.status'), '')) = 'scheduled'
      )
  `).bind(outletId, ...normalized.dates).all()
  const existingRows = existingResponse.results || []
  const existingById = new Map(existingRows.map((row) => [String(row.entity_id), row]))
  const activeExisting = existingRows.filter((row) => !String(row.deleted_at || '').trim())
  const newIds = new Set(normalized.rows.map((row) => row.id))
  const timestamp = now()
  const batchId = String(body?.batch_id || crypto.randomUUID()).slice(0, 120)
  const records = normalized.rows.map((row) => (
    buildRecord(row, outletId, actor, source, batchId, existingById.get(row.id), timestamp)
  ))

  const result = {
    ok: true,
    replayed: false,
    mutation_id: mutationId,
    batch_id: batchId,
    outlet_id: outletId,
    dates: normalized.dates,
    imported: records.length,
    replaced: replaceExisting ? activeExisting.length : 0,
    archived: replaceExisting
      ? activeExisting.filter((row) => !newIds.has(String(row.entity_id))).length
      : 0,
    updated: activeExisting.filter((row) => newIds.has(String(row.entity_id))).length,
    deduplicated: normalized.duplicateCount,
    sync_status: 'pending',
    storage: 'd1',
    committed_at: timestamp,
  }
  const mirrorMessage = {
    mutation_id: mutationId,
    entity: ENTITY,
    entity_id: batchId,
    outlet_id: outletId,
    operation: IMPORT_OPERATION,
    replace_existing: replaceExisting,
    dates: normalized.dates,
    records,
    source,
    committed_at: timestamp,
  }

  const statements = []
  if (replaceExisting) {
    statements.push(db.prepare(`
      UPDATE ops_records
      SET deleted_at = ?, status = 'archived', updated_at = ?, updated_by = ?
      WHERE entity = '${ENTITY}' AND outlet_id = ?
        AND business_date IN (${placeholders}) AND deleted_at = ''
        AND (
          status = 'scheduled'
          OR lower(COALESCE(json_extract(payload_json, '$.status'), '')) = 'scheduled'
        )
    `).bind(timestamp, timestamp, actor.email, outletId, ...normalized.dates))
  }

  for (const record of records) {
    const existingRow = existingById.get(record.id)
    statements.push(db.prepare(`
      INSERT INTO ops_records (
        entity, entity_id, outlet_id, business_date, status, payload_json,
        version, created_at, created_by, updated_at, updated_by, deleted_at
      ) VALUES ('${ENTITY}', ?, ?, ?, 'scheduled', ?, ?, ?, ?, ?, ?, '')
      ON CONFLICT(entity, entity_id) DO UPDATE SET
        outlet_id = excluded.outlet_id,
        business_date = excluded.business_date,
        status = excluded.status,
        payload_json = excluded.payload_json,
        version = excluded.version,
        updated_at = excluded.updated_at,
        updated_by = excluded.updated_by,
        deleted_at = ''
    `).bind(
      record.id,
      outletId,
      record.date,
      JSON.stringify(record),
      record.version,
      existingRow?.created_at || timestamp,
      existingRow?.created_by || actor.email,
      timestamp,
      actor.email,
    ))
  }

  statements.push(
    db.prepare(`
      INSERT INTO ops_mutations (
        mutation_id, outlet_id, entity, entity_id, operation, actor_email,
        actor_name, requested_at, committed_at, result_json
      ) VALUES (?, ?, '${ENTITY}', ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      mutationId,
      outletId,
      batchId,
      IMPORT_OPERATION,
      actor.email,
      actor.full_name || actor.email,
      String(body?.requested_at || timestamp),
      timestamp,
      JSON.stringify(result),
    ),
    db.prepare(`
      INSERT INTO sheet_sync_outbox (
        mutation_id, entity, entity_id, outlet_id, operation, payload_json,
        status, attempts, next_attempt_at
      ) VALUES (?, '${ENTITY}', ?, ?, ?, ?, 'pending', 0, ?)
    `).bind(
      mutationId,
      batchId,
      outletId,
      IMPORT_OPERATION,
      JSON.stringify(mirrorMessage),
      timestamp,
    ),
  )

  try {
    await db.batch(statements)
  } catch (error) {
    const concurrentReplay = await findReplay(db, mutationId)
    if (concurrentReplay) return concurrentReplay
    throw error
  }

  const followups = Promise.all([
    enqueueMirror(env, mirrorMessage),
    broadcastRosterEvent(env, mirrorMessage, result),
  ])
  if (env.__CHEFOPS_CTX?.waitUntil) env.__CHEFOPS_CTX.waitUntil(followups)
  else followups.catch((error) => console.error('Duty Roster follow-up failed', mutationId, error))
  return result
}

export async function handleRealtimeAttendanceRosterImport(request, env, url) {
  if (url.pathname !== '/api/attendance/import' || request.method !== 'POST') return null
  try {
    const actor = await getCurrentUser(request, env)
    const result = await commitAttendanceRoster(request, env, actor, await readJson(request))
    return json(request, env, result, result.replayed ? 200 : 201)
  } catch (error) {
    return errorResponse(request, env, error)
  }
}

export async function mirrorAttendanceRosterToSheets(env, message) {
  if (
    message?.entity !== ENTITY
    || message?.operation !== IMPORT_OPERATION
    || !Array.isArray(message?.records)
  ) return false

  const timestamp = now()
  if (message.replace_existing !== false) {
    for (const date of message.dates || []) {
      await updateManyRecords(env, ENTITY, {
        outlet_id: String(message.outlet_id || ''),
        date: String(date || '').slice(0, 10),
        status: 'scheduled',
      }, {
        deleted_at: timestamp,
        updated_date: timestamp,
        updated_by: 'd1-roster-mirror@chefops.local',
      }, { year: Number(String(date || '').slice(0, 4)) })
    }
  }
  await appendRecords(env, ENTITY, message.records)
  return true
}

export const ATTENDANCE_ROSTER_POLICY = Object.freeze({
  entity: ENTITY,
  operation: IMPORT_OPERATION,
  maximum_rows: MAX_ROWS,
  maximum_dates: MAX_DATES,
  storage: 'd1',
  replacement: 'soft-delete-selected-outlet-date-scheduled-rows',
})
