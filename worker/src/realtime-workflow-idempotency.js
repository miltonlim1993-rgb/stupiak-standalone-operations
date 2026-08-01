const IDEMPOTENT_WORKFLOW_PATHS = new Set([
  '/api/tasks/operational/action',
  '/api/close-up/upsert',
])

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .filter((key) => !['mutation_id', 'requested_at'].includes(key))
        .sort()
        .map((key) => [key, stableValue(value[key])]),
    )
  }
  return value
}

async function sha256(value) {
  const bytes = new TextEncoder().encode(String(value || ''))
  const hash = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(hash)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

function workflowKey(pathname, body) {
  if (pathname === '/api/tasks/operational/action') {
    return [
      'task',
      body.task_id || 'unknown',
      body.action || 'action',
    ].join(':')
  }
  return [
    'closeup',
    body.record_id
      || body.event_key
      || [body.outlet_id, body.business_date, body.shift_id].filter(Boolean).join('|')
      || 'unknown',
  ].join(':')
}

export async function withStableWorkflowMutationId(request, url) {
  if (
    request.method !== 'POST'
    || !IDEMPOTENT_WORKFLOW_PATHS.has(url.pathname)
  ) return request

  const suppliedHeader = String(request.headers.get('X-ChefOps-Mutation-Id') || '').trim()
  let body
  try { body = await request.clone().json() } catch { return request }
  if (suppliedHeader || String(body?.mutation_id || '').trim()) return request

  const fingerprint = await sha256(JSON.stringify(stableValue(body || {})))
  const mutationId = `${workflowKey(url.pathname, body || {})}:${fingerprint.slice(0, 48)}`.slice(0, 160)
  const headers = new Headers(request.headers)
  headers.set('Content-Type', 'application/json')
  headers.set('X-ChefOps-Mutation-Id', mutationId)
  headers.delete('Content-Length')

  return new Request(request.url, {
    method: request.method,
    headers,
    body: JSON.stringify({
      ...(body || {}),
      mutation_id: mutationId,
    }),
  })
}
