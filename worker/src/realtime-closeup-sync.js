import { getCurrentUser } from './auth.js'
import { errorResponse, json } from './http.js'
import { assertOutletAccess } from './permissions.js'
import { syncCloseUpToSalesTemplate } from './closeup-sync.js'
import { handleRealtimeDataApi } from './realtime-store.js'

function parseJson(value, fallback = null) {
  try { return JSON.parse(String(value || '')) } catch { return fallback }
}

async function updateCanonicalRecord(request, env, body) {
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
    throw error
  }
  return data
}

export async function handleRealtimeCloseUpSync(request, env, url) {
  const match = url.pathname.match(/^\/api\/close-up\/([^/]+)\/sync$/)
  if (!match || request.method !== 'POST' || !env.OPS_DB?.prepare) return null

  try {
    const id = decodeURIComponent(match[1])
    const row = await env.OPS_DB.prepare(`
      SELECT * FROM ops_records
      WHERE entity = 'CloseUp' AND entity_id = ? AND deleted_at = '' LIMIT 1
    `).bind(id).first()
    if (!row) return null

    const user = await getCurrentUser(request, env)
    const record = parseJson(row.payload_json, {}) || {}
    if (record.outlet_id) assertOutletAccess(user, record.outlet_id)
    const syncPatch = await syncCloseUpToSalesTemplate(env, record)
    const supplied = String(request.headers.get('X-ChefOps-Mutation-Id') || '').trim()
    const mutationId = (supplied || `closeup-sync:${id}:${Number(row.version || 0)}`).slice(0, 160)
    const result = await updateCanonicalRecord(request, env, {
      mutation_id: mutationId,
      entity: 'CloseUp',
      entity_id: id,
      outlet_id: row.outlet_id,
      operation: 'update',
      expected_version: Number(row.version || 0),
      payload: { ...record, ...syncPatch },
    })
    return json(request, env, result.record)
  } catch (error) {
    return errorResponse(request, env, error)
  }
}
