import { errorResponse, json, readJson } from './http.js'
import { handleRealtimeDataApi } from './sheet-backup-queue.js'

const MAX_BATCH_MUTATIONS = 100

function methodNotAllowed() {
  const error = new Error('Method not allowed')
  error.status = 405
  error.code = 'method_not_allowed'
  return error
}

function invalidBatch(message, code = 'realtime_mutation_batch_invalid') {
  const error = new Error(message)
  error.status = 400
  error.code = code
  return error
}

async function applyOne(request, env, mutation) {
  const mutationId = String(mutation?.mutation_id || '').trim()
  const innerUrl = new URL('/api/realtime/mutations', request.url)
  const headers = new Headers(request.headers)
  headers.set('Content-Type', 'application/json')
  headers.delete('Content-Length')
  if (mutationId) headers.set('X-ChefOps-Mutation-Id', mutationId)

  const response = await handleRealtimeDataApi(new Request(innerUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify(mutation || {}),
  }), env, innerUrl)
  const data = await response.json().catch(() => ({}))

  if (response.ok) {
    return {
      ok: true,
      status: response.status,
      mutation_id: String(data?.mutation_id || mutationId),
      result: data,
    }
  }

  return {
    ok: false,
    status: response.status,
    mutation_id: mutationId,
    error: data?.error || data?.message || `Realtime mutation failed (${response.status})`,
    code: data?.code || 'realtime_mutation_failed',
    details: data?.details,
    current_version: data?.current_version,
  }
}

export async function handleRealtimeMutationBatch(request, env, url) {
  if (url.pathname !== '/api/realtime/mutations/batch') return null

  try {
    if (request.method !== 'POST') throw methodNotAllowed()
    const body = await readJson(request)
    const mutations = Array.isArray(body?.mutations) ? body.mutations : []
    if (!mutations.length) throw invalidBatch('At least one mutation is required')
    if (mutations.length > MAX_BATCH_MUTATIONS) {
      throw invalidBatch(
        `A maximum of ${MAX_BATCH_MUTATIONS} mutations may be submitted at once`,
        'realtime_mutation_batch_too_large',
      )
    }

    const results = []
    for (const mutation of mutations) {
      results.push(await applyOne(request, env, mutation))
    }

    const committed = results.filter((item) => item.ok).length
    const failed = results.length - committed
    return json(request, env, {
      ok: failed === 0,
      accepted: mutations.length,
      committed,
      failed,
      results,
      server_time: new Date().toISOString(),
    }, failed ? 207 : 200)
  } catch (error) {
    return errorResponse(request, env, error)
  }
}

export { MAX_BATCH_MUTATIONS }
