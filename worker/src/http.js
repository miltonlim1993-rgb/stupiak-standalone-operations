export function allowedOrigins(env) {
  return String(env.ALLOWED_ORIGINS || 'http://localhost:5188')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
}

export function corsHeaders(request, env) {
  const origin = request.headers.get('Origin')
  const allowed = allowedOrigins(env)
  const allowOrigin = origin && allowed.includes(origin) ? origin : allowed[0] || 'null'
  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-ChefOps-Native, X-Requested-With',
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
    'Vary': 'Origin',
  }
}

export function json(request, env, data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...corsHeaders(request, env),
      ...extraHeaders,
    },
  })
}

export function errorResponse(request, env, error) {
  const status = Number(error?.status) || 500
  const safeServerMessage = error?.publicMessage || (
    error?.code === 'sheets_rate_limited'
      ? 'Google Sheets is temporarily busy. Please wait about one minute and try again.'
      : 'Internal server error'
  )
  const message = status >= 500 ? safeServerMessage : (error?.message || 'Request failed')
  if (status >= 500) console.error(error)
  const headers = error?.retryAfter ? { 'Retry-After': String(error.retryAfter) } : {}
  return json(request, env, {
    error: message,
    code: error?.code || (status >= 500 ? 'internal_error' : 'request_error'),
    retry_after: error?.retryAfter || undefined,
    details: status >= 500 ? undefined : error?.details,
  }, status, headers)
}

export async function readJson(request) {
  try {
    return await request.json()
  } catch {
    const error = new Error('Invalid JSON request body')
    error.status = 400
    error.code = 'invalid_json'
    throw error
  }
}

export function parseCookies(request) {
  const raw = request.headers.get('Cookie') || ''
  return Object.fromEntries(raw.split(';').map((part) => {
    const index = part.indexOf('=')
    if (index < 0) return [part.trim(), '']
    return [part.slice(0, index).trim(), decodeURIComponent(part.slice(index + 1).trim())]
  }).filter(([key]) => key))
}
