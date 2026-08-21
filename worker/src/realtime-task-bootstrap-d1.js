import { getCurrentUser } from './auth.js'
import { errorResponse } from './http.js'
import { applyOperationalTaskAudienceResponse } from './operational-task-audience.js'
import { applyOperationalTaskPolicyResponse } from './operational-task-policy.js'
import { assertAssignedOutletAccess, assignedOutletIds } from './permissions.js'
import { overlayOperationalBootstrapResponse } from './realtime-task-bootstrap.js'

function invalid(message, code, status = 400) {
  const error = new Error(message)
  error.status = status
  error.code = code
  throw error
}

export async function handleD1OperationalBootstrap(request, env, url) {
  if (url.pathname !== '/api/tasks/operational/bootstrap' || request.method !== 'POST') return null

  try {
    if (!env.OPS_DB?.prepare) invalid('Task D1 database is unavailable', 'task_d1_unavailable', 503)

    const bodyRequest = request.clone()
    const policyRequest = request.clone()
    const audienceRequest = request.clone()
    const body = await bodyRequest.json().catch(() => ({}))
    const user = await getCurrentUser(request, env)
    const outletId = String(body.outlet_id || user.outlet_id || assignedOutletIds(user)[0] || '').trim()
    const dateText = String(body.date || '').trim()
    if (!outletId) invalid('Your account is not assigned to an outlet', 'missing_outlet')
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateText)) invalid('Task date must use YYYY-MM-DD', 'invalid_task_date')
    assertAssignedOutletAccess(user, outletId)

    // The existing bootstrap assembler already knows how to combine the published
    // Task package with D1 Task/TaskPhoto rows and create missing generated Tasks.
    // Give it an intentionally unavailable legacy base so no Sheet payload can be
    // seeded into the canonical runtime.
    const noLegacyBase = new Response(JSON.stringify({}), {
      status: 503,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    })
    let response = await overlayOperationalBootstrapResponse(request, url, env, noLegacyBase)
    if (response === noLegacyBase || response.status >= 500) {
      invalid(
        'No published operational checklist configuration is available for this outlet and date',
        'published_operational_config_unavailable',
        503,
      )
    }

    response = await applyOperationalTaskPolicyResponse(policyRequest, url, response)
    response = await applyOperationalTaskAudienceResponse(audienceRequest, url, env, response)
    const headers = new Headers(response.headers)
    headers.set('X-ChefOps-Task-Bootstrap-Path', 'published-pack-d1-only-v1')
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    })
  } catch (error) {
    return errorResponse(request, env, error)
  }
}
