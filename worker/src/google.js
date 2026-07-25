let accessTokenCache = null

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
  const token = await getGoogleAccessToken(env)
  const response = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(options.headers || {}),
    },
  })
  if (!response.ok) {
    const text = await response.text()
    const error = new Error(`Google API ${response.status}: ${text.slice(0, 800)}`)
    if (response.status === 429) {
      error.status = 503
      error.code = 'sheets_rate_limited'
      error.publicMessage = 'Google Sheets is temporarily busy. Cached data remains available; retry in about one minute.'
      error.retryAfter = Number(response.headers.get('Retry-After') || 60)
    } else {
      error.status = 502
      error.code = 'google_api_error'
    }
    throw error
  }
  return response
}
