let accessTokenCache = null

const RETRYABLE_METHODS = new Set(['GET', 'HEAD', 'PUT'])
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504])

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function retryDelayMs(response, attempt) {
  const retryAfter = Number(response.headers.get('Retry-After') || 0)
  if (Number.isFinite(retryAfter) && retryAfter > 0) {
    return Math.min(retryAfter * 1000, 5000)
  }
  const schedule = [500, 1200, 2500, 5000]
  return schedule[Math.min(attempt, schedule.length - 1)]
}

export async function getGoogleAccessToken(env) {
  const now = Date.now()
  if (accessTokenCache && accessTokenCache.expiresAt > now + 60_000) {
    return accessTokenCache.token
  }

  const body = new URLSearchParams({
    client_id: env.GOOGLE_DATA_CLIENT_ID,
    client_secret: env.GOOGLE_DATA_CLIENT_SECRET,
    refresh_token: env.GOOGLE_DATA_REFRESH_TOKEN,
    grant_type: 'refresh_token',
  })

  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  })
  const data = await response.json()
  if (!response.ok || !data.access_token) {
    const error = new Error(data.error_description || data.error || 'Google token refresh failed')
    error.status = 502
    error.code = 'google_token_failed'
    throw error
  }

  accessTokenCache = {
    token: data.access_token,
    expiresAt: now + (Number(data.expires_in || 3600) * 1000),
  }
  return data.access_token
}

export async function googleFetch(env, url, options = {}) {
  const method = String(options.method || 'GET').toUpperCase()
  const maxRetries = RETRYABLE_METHODS.has(method) ? 4 : 0
  let response = null

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const token = await getGoogleAccessToken(env)
    response = await fetch(url, {
      ...options,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(options.headers || {}),
      },
    })

    if (response.ok) return response

    if (!RETRYABLE_STATUSES.has(response.status) || attempt >= maxRetries) break
    await sleep(retryDelayMs(response, attempt))
  }

  const text = await response.text()
  const error = new Error(`Google API ${response.status}: ${text.slice(0, 800)}`)
  if (response.status === 429) {
    error.status = 503
    error.code = 'sheets_rate_limited'
    error.publicMessage = 'Google Sheets is temporarily busy. Cached data remains available; retry shortly.'
    error.retryAfter = Number(response.headers.get('Retry-After') || 15)
  } else {
    error.status = 502
    error.code = 'google_api_error'
  }
  throw error
}