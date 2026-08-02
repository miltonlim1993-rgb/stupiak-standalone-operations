import { getCurrentUser } from './auth.js'
import { errorResponse, json, readJson } from './http.js'
import {
  assertCreatePermission,
  assertOutletAccess,
  assertUpdatePermission,
  assignedOutletIds,
} from './permissions.js'
import { getSchema } from './schema.js'
import { handleRealtimeDataApi } from './realtime-store.js'

function now() {
  return new Date().toISOString()
}

function parseJson(value, fallback = null) {
  try { return JSON.parse(String(value || '')) } catch { return fallback }
}

function realtimeRecord(row) {
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

function safeKey(value) {
  return String(value || '')
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 96)
}

function resolveOutletId(user, requested = '') {
  const value = String(requested || '').trim()
  if (user.role === 'manager' || user.role === 'owner') return value || user.outlet_id || assignedOutletIds(user)[0] || ''
  const allowed = assignedOutletIds(user)
  const target = value || user.outlet_id || allowed[0] || ''
  if (target) assertOutletAccess(user, target)
  return target
}

function cleanPatch(input) {
  const schema = getSchema('CloseUp')
  const allowed = new Set(schema.headers)
  const serverManaged = new Set([
    'id', 'created_date', 'created_by', 'updated_date', 'updated_by',
    'deleted_at', 'version', 'created_at', 'updated_at', 'submitted_at',
    'sync_attempts', 'last_sync_at', 'last_sync_error', 'external_sync_key',
    'external_response_json',
  ])
  return Object.fromEntries(
    Object.entries(input || {}).filter(([key]) => allowed.has(key) && !serverManaged.has(key)),
  )
}

async function mutationResponse(request, env, body) {
  const targetUrl = new URL('/api/realtime/mutations', request.url)
  const headers = new Headers(request.headers)
  headers.set('Content-Type', 'application/json')
  headers.delete('Content-Length')
  const subrequest = new Request(targetUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })
  const response = await handleRealtimeDataApi(subrequest, env, targetUrl)
  const data = await response.json().catch(() => ({}))
  if (!response.ok) {
    const error = new Error(data.error || data.message || `Realtime mutation failed (${response.status})`)
    error.status = response.status
    error.code = data.code || 'realtime_mutation_failed'
    error.details = data.details
    throw error
  }
  return data
}

async function d1Rows(env, outletId, businessDate) {
  const response = await env.OPS_DB.prepare(`
    SELECT * FROM ops_records
    WHERE entity = 'CloseUp' AND outlet_id = ? AND business_date = ? AND deleted_at = ''
    ORDER BY updated_at DESC LIMIT 500
  `).bind(outletId, businessDate).all()
  return (response.results || []).map(realtimeRecord)
}

async function d1Record(env, entityId) {
  const row = await env.OPS_DB.prepare(`
    SELECT * FROM ops_records
    WHERE entity = 'CloseUp' AND entity_id = ? AND deleted_at = '' LIMIT 1
  `).bind(entityId).first()
  return realtimeRecord(row)
}

function mutationId(request, rawInput) {
  const supplied = String(
    rawInput.mutation_id || request.headers.get('X-ChefOps-Mutation-Id') || '',
  ).trim()
  return (supplied || `close-up:${crypto.randomUUID()}`).slice(0, 160)
}

async function saveCloseUp(request, env) {
  if (!env.OPS_DB?.prepare) {
    const error = new Error('Realtime D1 database is not configured')
    error.status = 503
    error.code = 'realtime_database_unavailable'
    throw error
  }

  const user = await getCurrentUser(request, env)
  const rawInput = await readJson(request)
  const requestedRecordId = String(rawInput.record_id || '').trim()
  const input = cleanPatch(rawInput)
  const outletId = resolveOutletId(user, input.outlet_id)
  const businessDate = String(input.business_date || '').trim()
  const shiftId = String(input.shift_id || '').trim()
  const allowedPhases = new Set(['morning', 'handover', 'night'])

  if (!outletId || !/^\d{4}-\d{2}-\d{2}$/.test(businessDate) || !shiftId) {
    const error = new Error('Outlet, business date and phase are required')
    error.status = 400
    error.code = 'close_up_required_fields'
    throw error
  }
  if (!allowedPhases.has(shiftId)) {
    const error = new Error('Phase must be morning, handover or night')
    error.status = 400
    error.code = 'close_up_invalid_phase'
    throw error
  }
  assertOutletAccess(user, outletId)

  input.outlet_id = outletId
  input.business_date = businessDate
  input.shift_id = shiftId
  input.shift_name = input.shift_name || (shiftId === 'morning'
    ? 'Morning / Opening'
    : shiftId === 'handover'
      ? 'Cash Handover'
      : 'Night / Closing')

  const isHandover = shiftId === 'handover'
  const datedRows = await d1Rows(env, outletId, businessDate)
  const baseMutationId = mutationId(request, rawInput)
  const generatedEventKey = isHandover
    ? `handover-${safeKey(rawInput.event_key || requestedRecordId || baseMutationId)}`
    : `${outletId}|${businessDate}|${shiftId}`
  input.event_key = String(input.event_key || generatedEventKey).trim()

  let existing = requestedRecordId ? await d1Record(env, requestedRecordId) : null
  if (!existing) existing = datedRows.find((row) => String(row.event_key || '') === input.event_key) || null
  if (!existing && !isHandover) {
    existing = datedRows.find((row) => String(row.shift_id || '') === shiftId) || null
  }

  if (existing && (
    String(existing.outlet_id || '') !== outletId
    || String(existing.business_date || '') !== businessDate
    || String(existing.shift_id || '') !== shiftId
  )) {
    const error = new Error('The selected Close Up record does not match this outlet, date or phase')
    error.status = 409
    error.code = 'close_up_record_mismatch'
    throw error
  }

  if (isHandover) {
    if (!String(input.from_staff || '').trim() || !String(input.to_staff || '').trim()) {
      const error = new Error('From staff and to staff are required for a handover')
      error.status = 400
      error.code = 'close_up_handover_staff_required'
      throw error
    }
    if (existing) input.handover_sequence = Number(existing.handover_sequence || 0) || 1
    else {
      const maxSequence = datedRows
        .filter((row) => String(row.shift_id || '') === 'handover')
        .reduce((max, row) => Math.max(max, Number(row.handover_sequence || 0)), 0)
      input.handover_sequence = maxSequence + 1
    }
    input.handover_variance = Number(input.incoming_cash || 0) - Number(input.outgoing_cash || 0)
  } else {
    input.handover_sequence = 0
    input.outgoing_cash = 0
    input.incoming_cash = 0
    input.handover_variance = 0
    input.from_staff = ''
    input.to_staff = ''
    input.outgoing_denominations_json = '{}'
    input.incoming_denominations_json = '{}'
  }

  if (existing) assertUpdatePermission(user, 'CloseUp', existing, input)
  else assertCreatePermission(user, 'CloseUp')

  const timestamp = now()
  const id = existing?.id || requestedRecordId || `closeup-${safeKey(input.event_key)}`
  const payload = {
    ...(existing || {}),
    ...input,
    __realtime: undefined,
    id,
    outlet_id: outletId,
    business_date: businessDate,
    submitted_at: timestamp,
    submitted_by_email: input.submitted_by_email || user.email,
    submitted_by_name: input.submitted_by_name || user.full_name || user.email,
    sync_status: 'pending',
    last_sync_error: '',
  }

  const committed = await mutationResponse(request, env, {
    mutation_id: baseMutationId,
    entity: 'CloseUp',
    entity_id: id,
    outlet_id: outletId,
    operation: existing?.__realtime ? 'update' : 'upsert',
    expected_version: existing?.__realtime?.version,
    payload,
  })

  return {
    record: committed.record,
    created: !existing,
  }
}

export async function handleD1CloseUpUpsert(request, env, url) {
  if (url.pathname !== '/api/close-up/upsert' || request.method !== 'POST') return null
  try {
    const result = await saveCloseUp(request, env)
    return json(request, env, result.record, result.created ? 201 : 200)
  } catch (error) {
    return errorResponse(request, env, error)
  }
}
