import { getCurrentUser } from './auth.js'
import { errorResponse, json, readJson } from './http.js'

const DEVICE_ENTITY = 'DeviceRegistration'

function cleanText(value, max = 1000) {
  return String(value || '').trim().slice(0, max)
}

async function sha256(value) {
  const bytes = new TextEncoder().encode(String(value || ''))
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

async function deviceEntityId(userId, deviceId) {
  const hash = await sha256(`${String(userId || '')}\n${String(deviceId || '')}`)
  return `device-${hash.slice(0, 40)}`
}

function parsePayload(row) {
  try { return JSON.parse(String(row?.payload_json || '{}')) || {} } catch { return {} }
}

async function saveDevice(env, user, body) {
  if (!env.OPS_DB?.prepare) {
    const error = new Error('Canonical D1 database is unavailable')
    error.status = 503
    error.code = 'realtime_database_unavailable'
    throw error
  }

  const deviceId = cleanText(body.device_id, 240)
  if (!deviceId) {
    const error = new Error('device_id is required')
    error.status = 400
    error.code = 'missing_device_id'
    throw error
  }

  const entityId = await deviceEntityId(user.id, deviceId)
  const existing = await env.OPS_DB.prepare(`
    SELECT payload_json, version, created_at, created_by
    FROM ops_records
    WHERE entity = ? AND entity_id = ? AND deleted_at = ''
    LIMIT 1
  `).bind(DEVICE_ENTITY, entityId).first()

  const timestamp = new Date().toISOString()
  const previous = parsePayload(existing)
  const record = {
    ...previous,
    id: entityId,
    outlet_id: cleanText(user.outlet_id, 120),
    created_date: previous.created_date || existing?.created_at || timestamp,
    created_by: previous.created_by || existing?.created_by || user.email,
    updated_date: timestamp,
    updated_by: user.email,
    deleted_at: '',
    version: Number(existing?.version || previous.version || 0) + 1,
    user_id: cleanText(user.id, 200),
    user_email: cleanText(user.email, 320),
    user_name: cleanText(user.full_name || user.email, 240),
    device_id: deviceId,
    platform: cleanText(body.platform, 80),
    app_version: cleanText(body.app_version, 80),
    notification_permission: cleanText(body.notification_permission || 'default', 40),
    push_endpoint: cleanText(body.push_endpoint, 2000),
    push_subscription_json: body.push_subscription_json
      ? JSON.stringify(body.push_subscription_json).slice(0, 12000)
      : '',
    last_active_at: timestamp,
    status: 'active',
  }

  await env.OPS_DB.prepare(`
    INSERT INTO ops_records (
      entity, entity_id, outlet_id, business_date, status, payload_json,
      version, created_at, created_by, updated_at, updated_by, deleted_at
    ) VALUES (?, ?, ?, '', ?, ?, ?, ?, ?, ?, ?, '')
    ON CONFLICT(entity, entity_id) DO UPDATE SET
      outlet_id = excluded.outlet_id,
      status = excluded.status,
      payload_json = excluded.payload_json,
      version = ops_records.version + 1,
      updated_at = excluded.updated_at,
      updated_by = excluded.updated_by,
      deleted_at = ''
  `).bind(
    DEVICE_ENTITY,
    entityId,
    record.outlet_id,
    record.status,
    JSON.stringify(record),
    record.version,
    record.created_date,
    record.created_by,
    timestamp,
    user.email,
  ).run()

  return record
}

export async function handleD1DeviceRegistration(request, env, url) {
  if (url.pathname !== '/api/app/v4/device' || request.method !== 'POST') return null

  try {
    const user = await getCurrentUser(request, env)
    const body = await readJson(request)
    const device = await saveDevice(env, user, body || {})
    const response = json(request, env, { ok: true, device })
    const headers = new Headers(response.headers)
    headers.set('X-ChefOps-Device-Registration-Path', 'd1-only-v1')
    headers.set('Cache-Control', 'no-store')
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    })
  } catch (error) {
    return errorResponse(request, env, error)
  }
}
