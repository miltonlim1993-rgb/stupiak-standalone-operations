import { SignJWT, jwtVerify } from 'jose'

import {
  createSession,
  sessionCookie,
  userWithProfileSetup,
} from './auth.js'
import {
  findDirectoryUser,
  saveDirectoryRecord,
} from './d1-directory-store.js'
import { json, parseCookies, readJson } from './http.js'
import {
  authFingerprint,
  localAuthMode,
  localRegistrationMode,
} from './local-auth-crypto.js'
import {
  authenticateCredential,
  checkRateLimit,
  clearRateLimit,
  findCredentialByUserId,
  localAuthSchemaReady,
  noteRateLimitFailure,
  writeLocalAuthAudit,
} from './local-auth-store.js'

const PENDING_COOKIE_NAME = 'chefops_pending_approval'
const PENDING_SESSION_SECONDS = 48 * 60 * 60

function authError(message, code, status = 400) {
  const error = new Error(message)
  error.code = code
  error.status = status
  return error
}

function normalizedEmail(value) {
  const email = String(value || '').trim().toLowerCase()
  if (!email || email.length > 254) return ''
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : ''
}

function displayNameFromEmail(email) {
  const local = String(email || '').split('@')[0]
  const words = local
    .replace(/[._+-]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 5)
    .map((word) => `${word.slice(0, 1).toUpperCase()}${word.slice(1).toLowerCase()}`)
  const name = words.join(' ').trim()
  return name.length >= 2 ? name.slice(0, 80) : 'New Staff'
}

function sessionKey(env) {
  const secret = String(env.SESSION_SECRET || '')
  if (secret.length < 32) {
    throw authError('Session signing is not configured', 'session_secret_missing', 500)
  }
  return new TextEncoder().encode(secret)
}

function nativeRequest(request) {
  const origin = String(request.headers.get('Origin') || '').toLowerCase()
  const marker = String(request.headers.get('X-ChefOps-Native') || '').toLowerCase()
  return marker === 'android' || origin === 'https://localhost' || origin === 'capacitor://localhost'
}

function pendingCookie(token, request, maxAge = PENDING_SESSION_SECONDS) {
  const secure = new URL(request.url).protocol === 'https:'
  const sameSite = nativeRequest(request) ? 'None' : 'Lax'
  return `${PENDING_COOKIE_NAME}=${encodeURIComponent(token)}; Path=/api/auth/local/email; HttpOnly; SameSite=${sameSite}; Max-Age=${maxAge}${secure ? '; Secure' : ''}`
}

function expiredPendingCookie(request) {
  return pendingCookie('', request, 0)
}

function bearerToken(request) {
  const value = String(request.headers.get('Authorization') || '').trim()
  const match = value.match(/^Bearer\s+(.+)$/i)
  return match ? match[1].trim() : ''
}

async function createPendingToken(user, env) {
  return new SignJWT({
    uid: String(user.id),
    email: String(user.email || '').toLowerCase(),
    auth_method: 'pending_email_approval',
  })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(String(user.id))
    .setIssuedAt()
    .setExpirationTime(`${PENDING_SESSION_SECONDS}s`)
    .sign(sessionKey(env))
}

async function pendingPayload(request, env) {
  const token = bearerToken(request) || parseCookies(request)[PENDING_COOKIE_NAME]
  if (!token) throw authError('Approval waiting session was not found', 'pending_approval_session_missing', 401)
  try {
    const { payload } = await jwtVerify(token, sessionKey(env), { algorithms: ['HS256'] })
    if (payload.auth_method !== 'pending_email_approval' || !payload.uid || !payload.email) {
      throw new Error('Invalid pending session claims')
    }
    return payload
  } catch {
    throw authError('Approval waiting session is invalid or expired', 'pending_approval_session_invalid', 401)
  }
}

function clientIdentity(request) {
  const forwarded = String(
    request.headers.get('CF-Connecting-IP')
    || request.headers.get('X-Forwarded-For')
    || '',
  ).split(',')[0].trim()
  const userAgent = String(request.headers.get('User-Agent') || '').slice(0, 240)
  return `${forwarded || 'unknown'}|${userAgent}`
}

async function fingerprints(request, email, env) {
  return Promise.all([
    authFingerprint(email, env, 'email-login'),
    authFingerprint(clientIdentity(request), env, 'client'),
  ]).then(([emailHash, clientHash]) => ({ emailHash, clientHash }))
}

async function requireReady(env) {
  if (localAuthMode(env) === 'disabled') {
    throw authError('Local login is disabled', 'local_auth_disabled', 503)
  }
  if (String(env.LOCAL_AUTH_PEPPER || '').length < 32) {
    throw authError('Local login is not configured', 'local_auth_not_configured', 503)
  }
  if (!(await localAuthSchemaReady(env))) {
    throw authError('Local login database is not ready', 'local_auth_migration_required', 503)
  }
}

async function createPendingUser(env, email) {
  const id = crypto.randomUUID()
  const now = new Date().toISOString()
  return saveDirectoryRecord(env, 'User', id, {
    id,
    outlet_id: '',
    outlet_ids: '[]',
    created_date: now,
    created_by: 'email-approval@chefops.invalid',
    updated_date: now,
    updated_by: 'email-approval@chefops.invalid',
    deleted_at: '',
    version: 1,
    google_sub: '',
    email,
    full_name: displayNameFromEmail(email),
    avatar_url: '',
    role: 'staff',
    phone: '',
    department: '',
    status: 'pending',
    last_login_at: '',
    name_confirmed: false,
    name_confirmed_at: '',
    name_updated_at: '',
  }, {
    actorEmail: 'email-approval@chefops.invalid',
    operation: 'create',
  })
}

async function startEmailApproval(request, env) {
  await requireReady(env)
  if (localRegistrationMode(env) === 'disabled') {
    throw authError('New account requests are disabled', 'local_registration_disabled', 403)
  }
  const body = await readJson(request)
  const email = normalizedEmail(body.email)
  if (!email) throw authError('Enter a valid email address', 'local_email_invalid')

  const { emailHash, clientHash } = await fingerprints(request, email, env)
  const bucket = `email-start:${clientHash}`
  await checkRateLimit(env, bucket)
  await noteRateLimitFailure(env, bucket, 8)

  let user = await findDirectoryUser(env, { email })
  if (!user) {
    user = await createPendingUser(env, email)
    await writeLocalAuthAudit(env, {
      eventType: 'email_approval_requested',
      userId: user.id,
      loginIdHash: emailHash,
      clientHash,
      success: true,
    })
  }

  const status = String(user.status || 'pending').toLowerCase()
  if (status === 'pending') {
    const token = await createPendingToken(user, env)
    await clearRateLimit(env, bucket)
    return json(request, env, {
      ok: true,
      status: 'pending',
      email,
      pending_token: token,
      poll_after_seconds: 3,
      message: 'Request sent. Keep this page open while the Owner approves your account.',
    }, 202, {
      'Set-Cookie': pendingCookie(token, request),
    })
  }

  if (status !== 'active') {
    await clearRateLimit(env, bucket)
    return json(request, env, {
      ok: true,
      status,
      email,
      message: status === 'rejected'
        ? 'This access request was rejected. Contact the Owner.'
        : 'This account is not active. Contact the Owner.',
    })
  }

  const credential = await findCredentialByUserId(env, user.id)
  await clearRateLimit(env, bucket)
  if (credential && !credential.disabled_at) {
    return json(request, env, {
      ok: true,
      status: 'credential_required',
      email,
      credential_kind: credential.credential_kind,
      message: credential.credential_kind === 'pin'
        ? 'Enter your six-digit PIN.'
        : 'Enter your password.',
    })
  }

  return json(request, env, {
    ok: true,
    status: 'credential_setup_required',
    email,
    message: 'This approved account has no local credential on this device. Use the temporary Google fallback or ask the Owner to reset local access.',
  }, 409)
}

async function emailCredentialLogin(request, env) {
  await requireReady(env)
  const body = await readJson(request)
  const email = normalizedEmail(body.email)
  const secret = String(body.secret || body.pin || body.password || '')
  if (!email) throw authError('Enter a valid email address', 'local_email_invalid')

  const { emailHash, clientHash } = await fingerprints(request, email, env)
  const clientBucket = `email-login-client:${clientHash}`
  const loginBucket = `email-login:${emailHash}`
  await Promise.all([checkRateLimit(env, clientBucket), checkRateLimit(env, loginBucket)])

  try {
    const user = await findDirectoryUser(env, { email })
    const status = String(user?.status || '').toLowerCase()
    if (!user || status !== 'active') {
      throw authError(
        status === 'pending' ? 'Your account is waiting for Owner approval' : 'This account is not active',
        status === 'pending' ? 'user_pending' : 'user_inactive',
        403,
      )
    }
    const current = await findCredentialByUserId(env, user.id)
    if (!current || current.disabled_at) {
      throw authError('Local PIN or password is not configured for this account', 'local_credential_missing', 409)
    }
    const credential = await authenticateCredential(env, current.login_id, secret)
    if (!credential || String(credential.user_id) !== String(user.id)) {
      throw authError('Email, PIN or password is incorrect', 'local_login_invalid', 401)
    }

    const token = await createSession(user, env, {
      authMethod: 'local',
      sessionVersion: Number(credential.session_version || 1),
    })
    await Promise.all([clearRateLimit(env, clientBucket), clearRateLimit(env, loginBucket)])
    await writeLocalAuthAudit(env, {
      eventType: 'email_local_login',
      userId: user.id,
      loginIdHash: emailHash,
      clientHash,
      success: true,
      details: { credential_kind: credential.credential_kind },
    })
    const response = { user: userWithProfileSetup(user) }
    if (nativeRequest(request)) response.session_token = token
    return json(request, env, response, 200, {
      'Set-Cookie': sessionCookie(token, request),
    })
  } catch (error) {
    await Promise.allSettled([
      noteRateLimitFailure(env, clientBucket, 10),
      noteRateLimitFailure(env, loginBucket, 7),
      writeLocalAuthAudit(env, {
        eventType: 'email_local_login_failed',
        loginIdHash: emailHash,
        clientHash,
        success: false,
        details: { code: String(error?.code || '') },
      }),
    ])
    throw error
  }
}

async function emailApprovalStatus(request, env) {
  await requireReady(env)
  const payload = await pendingPayload(request, env)
  const user = await findDirectoryUser(env, { id: String(payload.uid) })
  if (!user || String(user.email || '').toLowerCase() !== String(payload.email || '').toLowerCase()) {
    throw authError('Approval request was not found', 'pending_approval_user_missing', 404)
  }

  const status = String(user.status || 'pending').toLowerCase()
  if (status === 'pending') {
    return json(request, env, {
      ok: true,
      status: 'pending',
      email: user.email,
      message: 'Waiting for Owner approval.',
    })
  }
  if (status !== 'active') {
    return json(request, env, {
      ok: true,
      status,
      email: user.email,
      message: status === 'rejected'
        ? 'This request was rejected by the Owner.'
        : 'This account is not active.',
    }, 200, {
      'Set-Cookie': expiredPendingCookie(request),
    })
  }

  const token = await createSession(user, env, { authMethod: 'approved_email' })
  const credential = await findCredentialByUserId(env, user.id)
  await writeLocalAuthAudit(env, {
    eventType: 'email_approval_session_promoted',
    userId: user.id,
    loginIdHash: await authFingerprint(user.email, env, 'email-login'),
    clientHash: await authFingerprint(clientIdentity(request), env, 'client'),
    success: true,
    details: { local_credential_ready: Boolean(credential && !credential.disabled_at) },
  })
  const response = {
    ok: true,
    status: 'active',
    user: {
      ...userWithProfileSetup(user),
      requires_local_credential_setup: !credential || Boolean(credential.disabled_at),
    },
  }
  if (nativeRequest(request)) response.session_token = token
  return json(request, env, response, 200, {
    'Set-Cookie': [
      sessionCookie(token, request),
      expiredPendingCookie(request),
    ].join(', '),
  })
}

export async function handleEmailApprovalAuth(request, env, url = new URL(request.url)) {
  const path = url.pathname
  if (path === '/api/auth/local/email/start' && request.method === 'POST') {
    return startEmailApproval(request, env)
  }
  if (path === '/api/auth/local/email/login' && request.method === 'POST') {
    return emailCredentialLogin(request, env)
  }
  if (path === '/api/auth/local/email/status' && request.method === 'GET') {
    return emailApprovalStatus(request, env)
  }
  return null
}
