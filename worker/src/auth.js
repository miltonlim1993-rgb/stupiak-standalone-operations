import { createRemoteJWKSet, jwtVerify, SignJWT } from 'jose'
import { parseCookies } from './http.js'
import {
  cacheDirectoryUser,
  findDirectoryUser,
  saveDirectoryRecord,
} from './d1-directory-store.js'

const GOOGLE_JWKS = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'))
const COOKIE_NAME = 'chefops_session'

const USER_CACHE = new Map()
const USER_INFLIGHT = new Map()
const USER_CACHE_TTL_MS = 60_000
const USER_KV_TTL_SECONDS = 7 * 24 * 60 * 60
const LAST_LOGIN_WRITE_INTERVAL_MS = 6 * 60 * 60_000

function booleanValue(value) {
  return value === true || String(value || '').toLowerCase() === 'true'
}

function userKvKeyBySub(googleSub) {
  return `auth:user:sub:${String(googleSub || '').trim()}`
}

function userKvKeyByEmail(email) {
  return `auth:user:email:${String(email || '').trim().toLowerCase()}`
}

async function cachedUserFromKv(env, { googleSub = '', email = '' } = {}) {
  if (!env.APP_DATA_PACKS?.get) return null
  const keys = []
  if (googleSub) keys.push(userKvKeyBySub(googleSub))
  if (email) keys.push(userKvKeyByEmail(email))
  for (const key of keys) {
    try {
      const stored = await env.APP_DATA_PACKS.get(key, 'json')
      if (!stored?.user || Date.now() - Number(stored.cachedAt || 0) > USER_KV_TTL_SECONDS * 1000) continue
      return stored.user
    } catch (error) {
      console.error('Unable to read cached D1 auth user', error)
    }
  }
  return null
}

export function validateActualName(value, email = '') {
  const name = String(value || '').replace(/\s+/g, ' ').trim()
  const normalizedEmail = String(email || '').trim().toLowerCase()
  const blocked = new Set(['admin', 'staff', 'user', 'owner', 'manager', 'supervisor'])
  if (name.length < 2 || name.length > 80) return ''
  if (name.includes('@') || name.toLowerCase() === normalizedEmail) return ''
  if (blocked.has(name.toLowerCase())) return ''
  if (!/[\p{L}\p{M}]/u.test(name)) return ''
  return name
}

export function userWithProfileSetup(user) {
  if (!user) return user
  const validName = validateActualName(user.full_name, user.email)
  return {
    ...user,
    requires_name_setup: !booleanValue(user.name_confirmed) || !validName,
  }
}

export function confirmedActualName(user) {
  const name = validateActualName(user?.full_name, user?.email)
  if (!name || !booleanValue(user?.name_confirmed)) {
    const error = new Error('Confirm your actual name before printing labels')
    error.status = 409
    error.code = 'profile_name_required'
    throw error
  }
  return name
}

export function rememberUser(user) {
  if (!user?.google_sub) return user
  USER_CACHE.set(String(user.google_sub), { user, cachedAt: Date.now() })
  return user
}

async function rememberUserEverywhere(env, user) {
  rememberUser(user)
  await cacheDirectoryUser(env, user)
  return user
}

async function activeUserBySub(env, googleSub) {
  const key = String(googleSub || '')
  const cached = USER_CACHE.get(key)
  if (cached && Date.now() - cached.cachedAt < USER_CACHE_TTL_MS) return cached.user
  if (USER_INFLIGHT.has(key)) return USER_INFLIGHT.get(key)

  const pending = (async () => {
    try {
      const user = await findDirectoryUser(env, { googleSub: key })
      if (user) return rememberUserEverywhere(env, user)
    } catch (error) {
      console.error('D1 user lookup failed; checking last-known-good auth cache', error)
    }

    const fallback = await cachedUserFromKv(env, { googleSub: key })
    if (fallback) rememberUser(fallback)
    return fallback
  })()

  USER_INFLIGHT.set(key, pending)
  try { return await pending } finally { if (USER_INFLIGHT.get(key) === pending) USER_INFLIGHT.delete(key) }
}

function sessionKey(env) {
  if (!env.SESSION_SECRET || env.SESSION_SECRET.length < 32) {
    const error = new Error('SESSION_SECRET must contain at least 32 characters')
    error.status = 500
    throw error
  }
  return new TextEncoder().encode(env.SESSION_SECRET)
}

export async function verifyGoogleCredential(credential, env) {
  if (!credential) {
    const error = new Error('Missing Google credential')
    error.status = 400
    error.code = 'missing_google_credential'
    throw error
  }
  try {
    const { payload } = await jwtVerify(credential, GOOGLE_JWKS, {
      audience: env.GOOGLE_LOGIN_CLIENT_ID,
      issuer: ['accounts.google.com', 'https://accounts.google.com'],
    })
    return payload
  } catch {
    const error = new Error('Google sign-in token is invalid or expired')
    error.status = 401
    error.code = 'invalid_google_token'
    throw error
  }
}

export async function createSession(user, env) {
  return new SignJWT({ email: user.email, role: user.role })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(user.google_sub)
    .setIssuedAt()
    .setExpirationTime('7d')
    .sign(sessionKey(env))
}

function isNativeAppRequest(request) {
  const origin = String(request.headers.get('Origin') || '').toLowerCase()
  return origin === 'https://localhost' || origin === 'capacitor://localhost'
}

export function sessionCookie(token, request) {
  const secure = new URL(request.url).protocol === 'https:'
  const sameSite = isNativeAppRequest(request) ? 'None' : 'Lax'
  return `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=${sameSite}; Max-Age=604800${secure ? '; Secure' : ''}`
}

export function expiredSessionCookie(request) {
  const secure = new URL(request.url).protocol === 'https:'
  const sameSite = isNativeAppRequest(request) ? 'None' : 'Lax'
  return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=${sameSite}; Max-Age=0${secure ? '; Secure' : ''}`
}

function bearerToken(request) {
  const value = String(request.headers.get('Authorization') || '').trim()
  const match = value.match(/^Bearer\s+(.+)$/i)
  return match ? match[1].trim() : ''
}

export async function sessionPayload(request, env) {
  const token = bearerToken(request) || parseCookies(request)[COOKIE_NAME]
  if (!token) return null
  try {
    const { payload } = await jwtVerify(token, sessionKey(env), { algorithms: ['HS256'] })
    return payload
  } catch {
    return null
  }
}

export async function getCurrentUser(request, env, { optional = false } = {}) {
  const payload = await sessionPayload(request, env)
  if (!payload?.sub) {
    if (optional) return null
    const error = new Error('Authentication required')
    error.status = 401
    error.code = 'auth_required'
    throw error
  }
  const user = await activeUserBySub(env, payload.sub)
  if (!user || String(user.status || '').toLowerCase() !== 'active') {
    const error = new Error(user?.status === 'pending' ? 'Your account is waiting for approval' : 'User account is inactive')
    error.status = 403
    error.code = user?.status === 'pending' ? 'user_pending' : 'user_inactive'
    throw error
  }
  return user
}

async function findLoginUser(env, { googleSub, email }) {
  try {
    const d1User = await findDirectoryUser(env, { googleSub, email })
    if (d1User) return d1User
  } catch (error) {
    const fallback = await cachedUserFromKv(env, { googleSub, email })
    if (fallback) return fallback
    throw error
  }
  return cachedUserFromKv(env, { googleSub, email })
}

function shouldWriteLoginUpdate(user, { googleSub, email, fullName, avatarUrl, nowMs }) {
  const lastLoginMs = Date.parse(user.last_login_at || '')
  const staleLastLogin = !Number.isFinite(lastLoginMs) || nowMs - lastLoginMs >= LAST_LOGIN_WRITE_INTERVAL_MS
  return staleLastLogin
    || String(user.google_sub || '') !== googleSub
    || String(user.email || '').toLowerCase() !== email
    || (!validateActualName(user.full_name, email) && Boolean(fullName))
    || String(user.avatar_url || '') !== avatarUrl
}

export async function loginWithGoogle(credential, env) {
  const payload = await verifyGoogleCredential(credential, env)
  const googleSub = String(payload.sub)
  const email = String(payload.email || '').toLowerCase()
  const fullName = validateActualName(payload.name, email) || ''
  const avatarUrl = String(payload.picture || '')
  if (!email || payload.email_verified === false) {
    const error = new Error('A verified Google email address is required')
    error.status = 403
    error.code = 'email_not_verified'
    throw error
  }

  let user = await findLoginUser(env, { googleSub, email })
  const nowDate = new Date()
  const timestamp = nowDate.toISOString()

  if (user) {
    const nextUser = {
      ...user,
      google_sub: googleSub,
      email,
      full_name: validateActualName(user.full_name, email) || fullName,
      avatar_url: avatarUrl,
      last_login_at: timestamp,
      __realtime: undefined,
    }

    if (shouldWriteLoginUpdate(user, { googleSub, email, fullName, avatarUrl, nowMs: nowDate.getTime() })) {
      user = await saveDirectoryRecord(env, 'User', user.id, nextUser, {
        actorEmail: email,
        operation: 'update',
      })
    } else {
      user = nextUser
    }
  } else {
    const isBootstrapOwner = email === String(env.BOOTSTRAP_OWNER_EMAIL || '').toLowerCase()
    const fallbackOutlet = isBootstrapOwner ? String(env.BOOTSTRAP_OWNER_OUTLET_ID || 'RR-KCH') : ''
    user = {
      id: crypto.randomUUID(),
      outlet_id: fallbackOutlet,
      outlet_ids: fallbackOutlet ? JSON.stringify([fallbackOutlet]) : '[]',
      created_date: timestamp,
      created_by: email,
      updated_date: timestamp,
      updated_by: email,
      deleted_at: '',
      version: 1,
      google_sub: googleSub,
      email,
      full_name: fullName,
      avatar_url: avatarUrl,
      role: isBootstrapOwner ? 'owner' : 'staff',
      phone: '',
      department: '',
      status: isBootstrapOwner ? 'active' : 'pending',
      last_login_at: timestamp,
      name_confirmed: isBootstrapOwner,
      name_confirmed_at: isBootstrapOwner ? timestamp : '',
      name_updated_at: isBootstrapOwner ? timestamp : '',
    }
    user = await saveDirectoryRecord(env, 'User', user.id, user, {
      actorEmail: email,
      operation: 'create',
    })
  }

  await rememberUserEverywhere(env, user)

  if (String(user.status || '').toLowerCase() !== 'active') {
    const error = new Error('Registration received. A manager must approve your account before you can enter ChefOps.')
    error.status = 403
    error.code = 'user_pending'
    throw error
  }
  const token = await createSession(user, env)
  return { user: userWithProfileSetup(user), token }
}
