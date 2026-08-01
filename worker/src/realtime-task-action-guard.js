import { getCurrentUser } from './auth.js'
import { errorResponse } from './http.js'
import { assertAssignedOutletAccess } from './permissions.js'
import { findRecord } from './sheets.js'

function parseJson(value, fallback = null) {
  try { return JSON.parse(String(value || '')) } catch { return fallback }
}

async function mutationAlreadyCommitted(env, mutationId) {
  if (!mutationId || !env.OPS_DB?.prepare) return false
  const row = await env.OPS_DB.prepare(
    'SELECT mutation_id FROM ops_mutations WHERE mutation_id = ? LIMIT 1',
  ).bind(mutationId).first()
  return Boolean(row)
}

async function canonicalTask(env, taskId) {
  if (!env.OPS_DB?.prepare) return null
  const row = await env.OPS_DB.prepare(`
    SELECT payload_json FROM ops_records
    WHERE entity = 'Task' AND entity_id = ? AND deleted_at = '' LIMIT 1
  `).bind(taskId).first()
  return row ? (parseJson(row.payload_json, {}) || {}) : null
}

export async function guardCompletedOperationalTask(request, env, url) {
  if (url.pathname !== '/api/tasks/operational/action' || request.method !== 'POST') return null

  try {
    const body = await request.clone().json()
    const mutationId = String(
      body?.mutation_id || request.headers.get('X-ChefOps-Mutation-Id') || '',
    ).trim()
    if (await mutationAlreadyCommitted(env, mutationId)) return null

    const taskId = String(body?.task_id || '').trim()
    if (!taskId) return null
    let task = await canonicalTask(env, taskId)
    if (!task) {
      const year = Number(String(body?.date || '').slice(0, 4)) || new Date().getFullYear()
      try { task = (await findRecord(env, 'Task', taskId, { year })).record } catch { return null }
    }

    const user = await getCurrentUser(request, env)
    if (task.outlet_id) assertAssignedOutletAccess(user, task.outlet_id)
    if (String(task.status || '').toLowerCase() !== 'done') return null

    const error = new Error('This task is already completed and cannot be reopened from a stale device')
    error.status = 409
    error.code = 'task_already_completed'
    return errorResponse(request, env, error)
  } catch (error) {
    return errorResponse(request, env, error)
  }
}
