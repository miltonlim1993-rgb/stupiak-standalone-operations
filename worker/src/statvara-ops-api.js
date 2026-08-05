import { createSession } from './auth.js'
import { findDirectoryUser } from './d1-directory-store.js'
import { json, readJson } from './http.js'
import { handleD1CloseUpUpsert } from './realtime-closeup-upsert-d1.js'
import { handleJsonAtomicStockCountBatch } from './realtime-stock-batch-json.js'
import { handleD1OperationalTaskAction } from './realtime-task-action-d1.js'
import { handleRealtimeWorkflowApi } from './realtime-workflows.js'
import { handleD1Labels } from './realtime-labels-d1.js'

const API_PREFIX = '/api/ops/v1'
const READABLE_ENTITIES = new Set([
  'Task', 'TaskPhoto', 'StockCount', 'CloseUp', 'UrgentIssue', 'FoodLabel',
  'LabelPrintLog', 'Attendance', 'TrainingAssignment', 'TrainingProgress',
  'TrainingAcknowledgement', 'TrainingAttempt',
])

function safeEqual(left, right) {
  const a = String(left || '')
  const b = String(right || '')
  if (!a || !b || a.length !== b.length) return false
  let mismatch = 0
  for (let index = 0; index < a.length; index += 1) mismatch |= a.charCodeAt(index) ^ b.charCodeAt(index)
  return mismatch === 0
}

function bearer(request) {
  const value = String(request.headers.get('Authorization') || '')
  return value.replace(/^Bearer\s+/i, '').trim()
}

function requireStatvara(request, env) {
  const expected = String(env.STATVARA_OPS_API_TOKEN || '').trim()
  if (!expected) {
    const error = new Error('Statvara OPS API token is not configured')
    error.status = 503
    error.code = 'statvara_token_unconfigured'
    throw error
  }
  if (!safeEqual(expected, bearer(request))) {
    const error = new Error('Invalid Statvara OPS token')
    error.status = 401
    error.code = 'statvara_unauthorized'
    throw error
  }
}

async function approvedActor(env, request, body = {}) {
  const email = String(
    request.headers.get('X-Statvara-Actor-Email') || body.actor_email || '',
  ).trim().toLowerCase()
  if (!email) {
    const error = new Error('X-Statvara-Actor-Email or actor_email is required for OPS mutations')
    error.status = 400
    error.code = 'statvara_actor_required'
    throw error
  }
  const user = await findDirectoryUser(env, { email })
  if (!user || String(user.status || '').toLowerCase() !== 'active') {
    const error = new Error('Statvara actor is not an active OPS user')
    error.status = 403
    error.code = 'statvara_actor_inactive'
    throw error
  }
  if (!['manager', 'owner'].includes(String(user.role || '').toLowerCase())) {
    const error = new Error('Statvara mutations require an active manager or owner identity')
    error.status = 403
    error.code = 'statvara_actor_manager_required'
    throw error
  }
  return user
}

async function internalRequest(request, env, pathname, body) {
  const actor = await approvedActor(env, request, body)
  const token = await createSession(actor, env, { authMethod: 'statvara', sessionVersion: 0 })
  const url = new URL(request.url)
  url.pathname = pathname
  url.search = ''
  const headers = new Headers(request.headers)
  headers.set('Content-Type', 'application/json')
  headers.set('Authorization', `Bearer ${token}`)
  headers.set('X-ChefOps-Statvara', '1')
  headers.delete('Content-Length')
  const payload = { ...(body || {}) }
  delete payload.actor_email
  return new Request(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  })
}

async function readRecords(env, url) {
  const entity = String(url.searchParams.get('entity') || '').trim()
  const outletId = String(url.searchParams.get('outlet_id') || '').trim()
  const limit = Math.max(1, Math.min(Number(url.searchParams.get('limit') || 100), 1000))
  if (!READABLE_ENTITIES.has(entity)) {
    const error = new Error('Entity is not available through the Statvara OPS API')
    error.status = 400
    error.code = 'statvara_entity_not_allowed'
    throw error
  }
  if (!outletId) {
    const error = new Error('outlet_id is required')
    error.status = 400
    error.code = 'statvara_outlet_required'
    throw error
  }
  if (!env.OPS_DB?.prepare) {
    const error = new Error('Cloudflare D1 is not configured')
    error.status = 503
    error.code = 'statvara_d1_unavailable'
    throw error
  }
  const rows = await env.OPS_DB.prepare(`
    SELECT entity_id, outlet_id, business_date, status, payload_json, version,
           created_at, updated_at, deleted_at
    FROM ops_records
    WHERE entity = ? AND outlet_id = ? AND deleted_at = ''
    ORDER BY updated_at DESC
    LIMIT ?
  `).bind(entity, outletId, limit).all()
  return (rows.results || []).map((row) => ({
    ...JSON.parse(row.payload_json || '{}'),
    __ops: {
      entity,
      entity_id: row.entity_id,
      outlet_id: row.outlet_id,
      business_date: row.business_date || '',
      status: row.status || '',
      version: Number(row.version || 0),
      created_at: row.created_at || '',
      updated_at: row.updated_at || '',
    },
  }))
}

function proxyResponse(response) {
  const headers = new Headers(response.headers)
  headers.set('X-ChefOps-Statvara-Bridge', 'd1-primary-v1')
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

export async function handleStatvaraOpsApi(request, env, url) {
  if (!url.pathname.startsWith(API_PREFIX)) return null
  requireStatvara(request, env)

  if (url.pathname === `${API_PREFIX}/status` && request.method === 'GET') {
    return json(request, env, {
      ok: true,
      revision: 'statvara-ops-d1-primary-v1',
      canonical_database: 'cloudflare-d1',
      canonical_media: 'cloudflare-r2',
      sheet_role: 'asynchronous_backup_record_only',
      mutation_actor_policy: 'active_manager_or_owner',
      capabilities: {
        read_records: [...READABLE_ENTITIES],
        task_action: true,
        stock_count_batch: true,
        close_up_upsert: true,
        issue_workflow: true,
        labels: true,
      },
    })
  }

  if (url.pathname === `${API_PREFIX}/records` && request.method === 'GET') {
    const records = await readRecords(env, url)
    return json(request, env, { records, count: records.length, source: 'cloudflare-d1' })
  }

  const body = await readJson(request)

  if (url.pathname === `${API_PREFIX}/tasks/action` && request.method === 'POST') {
    const target = '/api/tasks/operational/action'
    return proxyResponse(await handleD1OperationalTaskAction(
      await internalRequest(request, env, target, body), env, new URL(target, request.url),
    ))
  }

  if (url.pathname === `${API_PREFIX}/stock-counts/batch` && request.method === 'POST') {
    const target = '/api/stock-counts/batch'
    return proxyResponse(await handleJsonAtomicStockCountBatch(
      await internalRequest(request, env, target, body), env, new URL(target, request.url),
    ))
  }

  if (url.pathname === `${API_PREFIX}/close-up/upsert` && request.method === 'POST') {
    const target = '/api/close-up/upsert'
    return proxyResponse(await handleD1CloseUpUpsert(
      await internalRequest(request, env, target, body), env, new URL(target, request.url),
    ))
  }

  if (url.pathname.startsWith(`${API_PREFIX}/issues/`) && request.method === 'POST') {
    const target = url.pathname.replace(API_PREFIX, '/api')
    return proxyResponse(await handleRealtimeWorkflowApi(
      await internalRequest(request, env, target, body), env, new URL(target, request.url),
    ))
  }

  if (url.pathname.startsWith(`${API_PREFIX}/labels/`) && request.method === 'POST') {
    const target = url.pathname.replace(API_PREFIX, '/api')
    return proxyResponse(await handleD1Labels(
      await internalRequest(request, env, target, body), env, new URL(target, request.url),
    ))
  }

  const error = new Error('Statvara OPS endpoint not found')
  error.status = 404
  error.code = 'statvara_endpoint_not_found'
  throw error
}
