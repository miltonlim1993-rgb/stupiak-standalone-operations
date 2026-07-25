import { createRemoteJWKSet, jwtVerify, SignJWT } from 'jose'
import { appendRecord, listRecords, updateRecord } from './sheets.js'
import { parseCookies } from './http.js'

const GOOGLE_JWKS = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'))
const COOKIE_NAME = 'chefops_session'

const USER_CACHE = new Map()
const USER_INFLIGHT = new Map()
const USER_CACHE_TTL_MS = 60_000


function booleanValue(value) {
  return value === true || String(value || '').toLowerCase() === 'true'
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

async function activeUserBySub(env, googleSub) {
  const key = String(googleSub || '')
  const cached = USER_CACHE.get(key)
  if (cached && Date.now() - cached.cachedAt < USER_CACHE_TTL_MS) return cached.user
  if (USER_INFLIGHT.has(key)) return USER_INFLIGHT.get(key)
  const pending = (async () => {
    const users = await listRecords(env, 'User', { filter: { google_sub: key }, limit: 1 })
    return rememberUser(users[0] || null)
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

export function sessionCookie(token, request) {
  const secure = new URL(request.url).protocol === 'https:'
  return `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800${secure ? '; Secure' : ''}`
}

export function expiredSessionCookie(request) {
  const secure = new URL(request.url).protocol === 'https:'
  return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`
}

export async function sessionPayload(request, env) {
  const token = parseCookies(request)[COOKIE_NAME]
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
  if (!user || user.status !== 'active') {
    const error = new Error(user?.status === 'pending' ? 'Your account is waiting for approval' : 'User account is inactive')
    error.status = 403
    error.code = user?.status === 'pending' ? 'user_pending' : 'user_inactive'
    throw error
  }
  return user
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

  let user = (await listRecords(env, 'User', { filter: { google_sub: googleSub }, limit: 1 }))[0]
  if (!user) {
    user = (await listRecords(env, 'User', { filter: { email }, limit: 1 }))[0]
  }

  const now = new Date().toISOString()
  if (user) {
    user = await updateRecord(env, 'User', user.id, {
      google_sub: googleSub,
      email,
      full_name: validateActualName(user.full_name, email) || fullName,
      avatar_url: avatarUrl,
      last_login_at: now,
      updated_date: now,
      updated_by: email,
      version: Number(user.version || 0) + 1,
    })
  } else {
    const isBootstrapOwner = email === String(env.BOOTSTRAP_OWNER_EMAIL || '').toLowerCase()
    user = {
      id: crypto.randomUUID(),
      outlet_id: '',
      created_date: now,
      created_by: email,
      updated_date: now,
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
      last_login_at: now,
      name_confirmed: false,
      name_confirmed_at: '',
      name_updated_at: '',
    }
    await appendRecord(env, 'User', user)
  }

  rememberUser(user)

  if (user.status !== 'active') {
    const error = new Error('Registration received. A manager must approve your account before you can enter ChefOps.')
    error.status = 403
    error.code = 'user_pending'
    throw error
  }
  const token = await createSession(user, env)
  return { user: userWithProfileSetup(user), token }
}
