import {
  createSession,
  expiredSessionCookie,
  getCurrentUser,
  loginWithGoogle,
  rememberUser,
  sessionCookie,
  userWithProfileSetup,
  validateActualName,
  verifyGoogleCredential,
} from './auth.js'
import { errorResponse, json, readJson } from './http.js'

const AUTH_CACHE_TTL_SECONDS = 7 * 24 * 60 * 60

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

function authCacheEntries(user) {
  const payload = JSON.stringify({ user, cachedAt: Date.now() })
  const entries = [[`auth:user:sub:${String(user.google_sub || '').trim()}`, payload]]
  if (user.email) entries.push([`auth:user:email:${String(user.email).trim().toLowerCase()}`, payload])
  return entries
}

async function cacheBootstrapOwner(env, user) {
  rememberUser(user)
  if (!env.APP_DATA_PACKS?.put) return
  await Promise.all(authCacheEntries(user).map(([key, value]) => (
    env.APP_DATA_PACKS.put(key, value, { expirationTtl: AUTH_CACHE_TTL_SECONDS })
  ))).catch((error) => console.error('Unable to cache bootstrap owner login', error))
}

async function bootstrapOwnerLogin(credential, env, originalError) {
  if (!temporaryDirectoryError(originalError)) throw originalError

  const payload = await verifyGoogleCredential(credential, env)
  const email = String(payload.email || '').trim().toLowerCase()
  const bootstrapEmail = String(env.BOOTSTRAP_OWNER_EMAIL || '').trim().toLowerCase()
  if (!email || email !== bootstrapEmail || payload.email_verified === false) throw originalError

  const timestamp = new Date().toISOString()
  const googleSub = String(payload.sub || '').trim()
  const user = {
    id: `bootstrap-owner-${googleSub}`,
    outlet_id: '',
    outlet_ids: '',
    created_date: timestamp,
    created_by: email,
    updated_date: timestamp,
    updated_by: email,
    deleted_at: '',
    version: 1,
    google_sub: googleSub,
    email,
    full_name: validateActualName(payload.name, email) || 'Milton',
    avatar_url: String(payload.picture || ''),
    role: 'owner',
    phone: '',
    department: '',
    status: 'active',
    last_login_at: timestamp,
    name_confirmed: true,
    name_confirmed_at: timestamp,
    name_updated_at: timestamp,
  }
  await cacheBootstrapOwner(env, user)
  const token = await createSession(user, env)
  return { user: userWithProfileSetup(user), token, directory_fallback: 'bootstrap_owner' }
}

async function googleLogin(request, env) {
  const { credential } = await readJson(request)
  let result
  try {
    result = await loginWithGoogle(credential, env)
  } catch (error) {
    result = await bootstrapOwnerLogin(credential, env, error)
  }

  const response = { user: result.user }
  if (isNativeAppRequest(request)) response.session_token = result.token
  if (result.directory_fallback) response.directory_fallback = result.directory_fallback
  return json(request, env, response, 200, {
    'Set-Cookie': sessionCookie(result.token, request),
  })
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
      const user = await getCurrentUser(request, env)
      return json(request, env, userWithProfileSetup(user))
    }
    return null
  } catch (error) {
    if (temporaryDirectoryError(error) && !error.publicMessage) {
      error.publicMessage = 'Account directory is temporarily unavailable. Approved users with a cached profile can continue; please retry shortly.'
      error.code = error.code || 'auth_directory_unavailable'
    }
    return errorResponse(request, env, error)
  }
}
