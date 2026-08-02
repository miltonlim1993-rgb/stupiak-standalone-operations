import {
  createSession,
  expiredSessionCookie,
  getCurrentUser,
  loginWithGoogle,
  rememberUser,
  sessionCookie,
  sessionPayload,
  userWithProfileSetup,
  validateActualName,
  verifyGoogleCredential,
} from './auth.js'
import { errorResponse, json, readJson } from './http.js'

const AUTH_CACHE_TTL_SECONDS = 7 * 24 * 60 * 60
const DEFAULT_BOOTSTRAP_OWNER_EMAIL = 'miltonlim1993@gmail.com'
const DEFAULT_BOOTSTRAP_OWNER_OUTLET_ID = 'RR-KCH'

function isNativeAppRequest(request) {
  const origin = String(request.headers.get('Origin') || '').toLowerCase()
  const marker = String(request.headers.get('X-ChefOps-Native') || '').toLowerCase()
  return marker === 'android' || origin === 'https://localhost' || origin === 'capacitor://localhost'
}

function temporaryDirectoryError(error) {
  return error?.code === 'sheets_rate_limited'
    || error?.code === 'google_api_error'
    || Number(error?.status || 0) >= 500
}

function userKvKeyBySub(googleSub) {
  return `auth:user:sub:${String(googleSub || '').trim()}`
}

function userKvKeyByEmail(email) {
  return `auth:user:email:${String(email || '').trim().toLowerCase()}`
}

function normalizeUserScope(user, env) {
  if (!user) return user
  const email = String(user.email || '').trim().toLowerCase()
  const bootstrapEmail = String(env.BOOTSTRAP_OWNER_EMAIL || DEFAULT_BOOTSTRAP_OWNER_EMAIL).trim().toLowerCase()
  const outletId = String(user.outlet_id || '').trim()
  const outletIds = String(user.outlet_ids || '').trim()
  if (email !== bootstrapEmail || String(user.role || '').toLowerCase() !== 'owner' || outletId || outletIds) return user

  const fallbackOutlet = String(env.BOOTSTRAP_OWNER_OUTLET_ID || DEFAULT_BOOTSTRAP_OWNER_OUTLET_ID).trim()
  return fallbackOutlet
    ? { ...user, outlet_id: fallbackOutlet, outlet_ids: fallbackOutlet }
    : user
}

function authCacheEntries(user) {
  const payload = JSON.stringify({ user, cachedAt: Date.now() })
  const entries = [[userKvKeyBySub(user.google_sub), payload]]
  if (user.email) entries.push([userKvKeyByEmail(user.email), payload])
  return entries
}

async function readCachedUser(env, { googleSub = '', email = '' } = {}) {
  if (!env.APP_DATA_PACKS?.get) return null
  const keys = []
  if (googleSub) keys.push(userKvKeyBySub(googleSub))
  if (email) keys.push(userKvKeyByEmail(email))
  for (const key of keys) {
    try {
      const stored = await env.APP_DATA_PACKS.get(key, 'json')
      if (!stored?.user) continue
      if (Date.now() - Number(stored.cachedAt || 0) > AUTH_CACHE_TTL_SECONDS * 1000) continue
      return normalizeUserScope(stored.user, env)
    } catch (error) {
      console.error('Unable to read cached auth user', error)
    }
  }
  return null
}

async function cacheUser(env, user) {
  const scopedUser = normalizeUserScope(user, env)
  rememberUser(scopedUser)
  if (!env.APP_DATA_PACKS?.put) return scopedUser
  await Promise.all(authCacheEntries(scopedUser).map(([key, value]) => (
    env.APP_DATA_PACKS.put(key, value, { expirationTtl: AUTH_CACHE_TTL_SECONDS })
  ))).catch((error) => console.error('Unable to cache auth user', error))
  return scopedUser
}

async function bootstrapOwnerLogin(credential, env, originalError) {
  if (!temporaryDirectoryError(originalError)) throw originalError

  const payload = await verifyGoogleCredential(credential, env)
  const email = String(payload.email || '').trim().toLowerCase()
  const bootstrapEmail = String(env.BOOTSTRAP_OWNER_EMAIL || DEFAULT_BOOTSTRAP_OWNER_EMAIL).trim().toLowerCase()
  if (!email || email !== bootstrapEmail || payload.email_verified === false) throw originalError

  const timestamp = new Date().toISOString()
  const googleSub = String(payload.sub || '').trim()
  const cached = await readCachedUser(env, { googleSub, email })
  const fallbackOutlet = String(env.BOOTSTRAP_OWNER_OUTLET_ID || DEFAULT_BOOTSTRAP_OWNER_OUTLET_ID).trim()
  const user = normalizeUserScope({
    ...(cached || {}),
    id: cached?.id || `bootstrap-owner-${googleSub}`,
    outlet_id: cached?.outlet_id || fallbackOutlet,
    outlet_ids: cached?.outlet_ids || fallbackOutlet,
    created_date: cached?.created_date || timestamp,
    created_by: cached?.created_by || email,
    updated_date: timestamp,
    updated_by: email,
    deleted_at: '',
    version: Number(cached?.version || 1),
    google_sub: googleSub,
    email,
    full_name: validateActualName(cached?.full_name, email)
      || validateActualName(payload.name, email)
      || 'Milton',
    avatar_url: String(payload.picture || cached?.avatar_url || ''),
    role: 'owner',
    phone: cached?.phone || '',
    department: cached?.department || '',
    status: 'active',
    last_login_at: timestamp,
    name_confirmed: true,
    name_confirmed_at: cached?.name_confirmed_at || timestamp,
    name_updated_at: cached?.name_updated_at || timestamp,
  }, env)
  const scopedUser = await cacheUser(env, user)
  const token = await createSession(scopedUser, env)
  return { user: userWithProfileSetup(scopedUser), token, directory_fallback: 'bootstrap_owner' }
}

async function cachedGoogleLogin(credential, env) {
  const payload = await verifyGoogleCredential(credential, env)
  const googleSub = String(payload.sub || '').trim()
  const email = String(payload.email || '').trim().toLowerCase()
  if (!email || payload.email_verified === false) return null

  const cached = await readCachedUser(env, { googleSub, email })
  if (!cached || String(cached.status || '').toLowerCase() !== 'active') return null
  if (cached.email && String(cached.email).toLowerCase() !== email) return null

  const timestamp = new Date().toISOString()
  const user = normalizeUserScope({
    ...cached,
    google_sub: googleSub,
    email,
    full_name: validateActualName(cached.full_name, email)
      || validateActualName(payload.name, email)
      || '',
    avatar_url: String(payload.picture || cached.avatar_url || ''),
    last_login_at: timestamp,
  }, env)
  const scopedUser = await cacheUser(env, user)
  const token = await createSession(scopedUser, env)
  return { user: userWithProfileSetup(scopedUser), token, directory_fallback: 'cloudflare_cache' }
}

async function googleLogin(request, env) {
  const { credential } = await readJson(request)
  let result = await cachedGoogleLogin(credential, env)
  if (!result) {
    try {
      result = await loginWithGoogle(credential, env)
    } catch (error) {
      result = await bootstrapOwnerLogin(credential, env, error)
    }
  }

  const scopedUser = await cacheUser(env, result.user)
  const response = { user: userWithProfileSetup(scopedUser) }
  if (isNativeAppRequest(request)) response.session_token = result.token
  if (result.directory_fallback) response.directory_fallback = result.directory_fallback
  return json(request, env, response, 200, {
    'Set-Cookie': sessionCookie(result.token, request),
  })
}

async function currentUserFromCloudflare(request, env) {
  const payload = await sessionPayload(request, env)
  if (!payload?.sub) return null
  const user = await readCachedUser(env, {
    googleSub: String(payload.sub || ''),
    email: String(payload.email || ''),
  })
  if (!user) return null
  if (String(user.status || '').toLowerCase() !== 'active') {
    const error = new Error(user.status === 'pending'
      ? 'Your account is waiting for approval'
      : 'User account is inactive')
    error.status = 403
    error.code = user.status === 'pending' ? 'user_pending' : 'user_inactive'
    throw error
  }
  const scopedUser = await cacheUser(env, user)
  return scopedUser
}

export async function handleCloudflareAuth(request, env, url) {
  const path = url.pathname
  if (!path.startsWith('/api/auth/')) return null

  try {
    if (path === '/api/auth/google' && request.method === 'POST') {
      return await googleLogin(request, env)
    }
    if (path === '/api/auth/logout' && request.method === 'POST') {
      return json(request, env, { ok: true }, 200, {
        'Set-Cookie': expiredSessionCookie(request),
      })
    }
    if (path === '/api/auth/me' && request.method === 'GET') {
      const user = await currentUserFromCloudflare(request, env)
        || await getCurrentUser(request, env)
      const scopedUser = await cacheUser(env, user)
      return json(request, env, userWithProfileSetup(scopedUser))
    }
    return null
  } catch (error) {
    if (temporaryDirectoryError(error) && !error.publicMessage) {
      error.publicMessage = 'Account directory is temporarily unavailable. Your signed-in session was kept; please retry shortly.'
      error.code = error.code || 'auth_directory_unavailable'
    }
    return errorResponse(request, env, error)
  }
}
