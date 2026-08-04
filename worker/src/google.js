const accessTokenCache = new Map()

const RETRYABLE_METHODS = new Set(['GET', 'HEAD', 'PUT'])
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504])
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'
const GOOGLE_SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets'
const GOOGLE_DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive'

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

function serviceAccountConfigured(env) {
  return Boolean(
    String(env.GOOGLE_SERVICE_ACCOUNT_EMAIL || '').trim()
    && String(env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY || '').trim(),
  )
}

function oauthRefreshConfigured(env) {
  return Boolean(
    String(env.GOOGLE_DATA_CLIENT_ID || '').trim()
    && String(env.GOOGLE_DATA_CLIENT_SECRET || '').trim()
    && String(env.GOOGLE_DATA_REFRESH_TOKEN || '').trim(),
  )
}

function normalizedMode(value) {
  const mode = String(value || '').trim().toLowerCase().replaceAll('-', '_')
  if (['service_account', 'oauth_refresh_token', 'disabled'].includes(mode)) return mode
  return ''
}

export function googleAuthMode(env, purpose = 'data') {
  const target = String(purpose || 'data').toLowerCase() === 'drive' ? 'drive' : 'data'
  const configuredMode = normalizedMode(
    target === 'drive' ? env.GOOGLE_DRIVE_AUTH_MODE : env.GOOGLE_DATA_AUTH_MODE,
  )

  if (configuredMode === 'disabled') return 'disabled'
  if (configuredMode === 'service_account') {
    return serviceAccountConfigured(env) ? 'service_account' : 'unconfigured'
  }
  if (configuredMode === 'oauth_refresh_token') {
    return oauthRefreshConfigured(env) ? 'oauth_refresh_token' : 'unconfigured'
  }

  if (target === 'drive') {
    if (oauthRefreshConfigured(env)) return 'oauth_refresh_token'
    if (serviceAccountConfigured(env)) return 'service_account'
    return 'unconfigured'
  }

  if (serviceAccountConfigured(env)) return 'service_account'
  if (oauthRefreshConfigured(env)) return 'oauth_refresh_token'
  return 'unconfigured'
}

function purposeForUrl(url) {
  const value = String(url || '')
  return value.includes('googleapis.com/drive/') || value.includes('googleapis.com/upload/drive/')
    ? 'drive'
    : 'data'
}

function base64Url(bytes) {
  const value = typeof bytes === 'string' ? new TextEncoder().encode(bytes) : new Uint8Array(bytes)
  let binary = ''
  for (const byte of value) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/g, '')
}

function pemBytes(value) {
  const normalized = String(value || '')
    .replaceAll('\\n', '\n')
    .replace(/-----BEGIN PRIVATE KEY-----/g, '')
    .replace(/-----END PRIVATE KEY-----/g, '')
    .replace(/\s+/g, '')
  if (!normalized) throw new Error('Google service-account private key is empty')
  const binary = atob(normalized)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes.buffer
}

async function serviceAccountAssertion(env, scope) {
  const now = Math.floor(Date.now() / 1000)
  const header = base64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
  const claims = base64Url(JSON.stringify({
    iss: String(env.GOOGLE_SERVICE_ACCOUNT_EMAIL || '').trim(),
    scope,
    aud: GOOGLE_TOKEN_URL,
    iat: now,
    exp: now + 3600,
  }))
  const unsigned = `${header}.${claims}`
  const key = await crypto.subtle.importKey(
    'pkcs8',
    pemBytes(env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const signature = await crypto.subtle.sign(
    { name: 'RSASSA-PKCS1-v1_5' },
    key,
    new TextEncoder().encode(unsigned),
  )
  return `${unsigned}.${base64Url(signature)}`
}

async function serviceAccountAccessToken(env, purpose) {
  const scope = purpose === 'drive' ? GOOGLE_DRIVE_SCOPE : GOOGLE_SHEETS_SCOPE
  const assertion = await serviceAccountAssertion(env, scope)
  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  })
  const data = await response.json()
  if (!response.ok || !data.access_token) {
    const error = new Error(data.error_description || data.error || 'Google service-account token exchange failed')
    error.status = 502
    error.code = 'google_service_account_token_failed'
    throw error
  }
  return data
}

async function oauthRefreshAccessToken(env) {
  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.GOOGLE_DATA_CLIENT_ID,
      client_secret: env.GOOGLE_DATA_CLIENT_SECRET,
      refresh_token: env.GOOGLE_DATA_REFRESH_TOKEN,
      grant_type: 'refresh_token',
    }),
  })
  const data = await response.json()
  if (!response.ok || !data.access_token) {
    const error = new Error(data.error_description || data.error || 'Google token refresh failed')
    error.status = 502
    error.code = 'google_token_failed'
    throw error
  }
  return data
}

export async function getGoogleAccessToken(env, { purpose = 'data' } = {}) {
  const target = String(purpose || 'data').toLowerCase() === 'drive' ? 'drive' : 'data'
  const mode = googleAuthMode(env, target)
  if (mode === 'disabled' || mode === 'unconfigured') {
    const error = new Error(`Google ${target} authentication is ${mode}`)
    error.status = 503
    error.code = `google_${target}_auth_${mode}`
    throw error
  }

  const identity = mode === 'service_account'
    ? String(env.GOOGLE_SERVICE_ACCOUNT_EMAIL || '').trim()
    : String(env.GOOGLE_DATA_CLIENT_ID || '').trim()
  const cacheKey = `${mode}:${target}:${identity}`
  const now = Date.now()
  const cached = accessTokenCache.get(cacheKey)
  if (cached && cached.expiresAt > now + 60_000) return cached.token

  const data = mode === 'service_account'
    ? await serviceAccountAccessToken(env, target)
    : await oauthRefreshAccessToken(env)

  accessTokenCache.set(cacheKey, {
    token: data.access_token,
    expiresAt: now + (Number(data.expires_in || 3600) * 1000),
  })
  return data.access_token
}

export async function googleFetch(env, url, options = {}) {
  const method = String(options.method || 'GET').toUpperCase()
  const maxRetries = RETRYABLE_METHODS.has(method) ? 4 : 0
  const purpose = purposeForUrl(url)
  let response = null

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const token = await getGoogleAccessToken(env, { purpose })
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
