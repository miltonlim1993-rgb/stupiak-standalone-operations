import {
  createSession,
  getCurrentUser,
  sessionCookie,
  userWithProfileSetup,
  validateActualName,
} from './auth.js'
import {
  authFingerprint,
  credentialKindForRole,
  googleLoginMode,
  localAuthMode,
  localRegistrationMode,
  normalizeLoginId,
} from './local-auth-crypto.js'
import {
  activateLocalCredential,
  authenticateCredential,
  checkRateLimit,
  clearRateLimit,
  credentialSummary,
  findCredentialByUserId,
  issueLocalActivation,
  localAuthSchemaReady,
  noteRateLimitFailure,
  setLocalCredential,
  writeLocalAuthAudit,
} from './local-auth-store.js'
import {
  findDirectoryUser,
  listDirectoryRecords,
  saveDirectoryRecord,
} from './d1-directory-store.js'
import { errorResponse, json, readJson } from './http.js'

const DEFAULT_BOOTSTRAP_OWNER_EMAIL = 'miltonlim1993@gmail.com'

function localError(message, code, status = 400) {
  const error = new Error(message)
  error.code = code
  error.status = status
  return error
}

function secureEqual(left, right) {
  const a = String(left || '')
  const b = String(right || '')
  if (!a || !b || a.length !== b.length) return false
  let mismatch = 0
  for (let index = 0; index < a.length; index += 1) mismatch |= a.charCodeAt(index) ^ b.charCodeAt(index)
  return mismatch === 0
}

function isNativeAppRequest(request) {
  const origin = String(request.headers.get('Origin') || '').toLowerCase()
  const marker = String(request.headers.get('X-ChefOps-Native') || '').toLowerCase()
  return marker === 'android' || origin === 'https://localhost' || origin === 'capacitor://localhost'
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

async function fingerprints(request, loginId, env) {
  const [loginIdHash, clientHash] = await Promise.all([
    authFingerprint(normalizeLoginId(loginId), env, 'login-id'),
    authFingerprint(clientIdentity(request), env, 'client'),
  ])
  return { loginIdHash, clientHash }
}

function requireLocalEnabled(env) {
  if (localAuthMode(env) === 'disabled') {
    throw localError('Local login is disabled', 'local_auth_disabled', 503)
  }
  if (String(env.LOCAL_AUTH_PEPPER || '').length < 32) {
    throw localError('Local login is not configured', 'local_auth_not_configured', 503)
  }
}

async function authConfig(request, env) {
  const schemaReady = await localAuthSchemaReady(env)
  const pepperReady = String(env.LOCAL_AUTH_PEPPER || '').length >= 32
  const enabled = localAuthMode(env) === 'enabled' && schemaReady && pepperReady
  return json(request, env, {
    local_enabled: enabled,
    local_schema_ready: schemaReady,
    local_secret_ready: pepperReady,
    registration_enabled: enabled && localRegistrationMode(env) === 'enabled',
    google_enabled: googleLoginMode(env) !== 'disabled',
    migration_required: localAuthMode(env) === 'enabled' && !schemaReady,
    login_identifier: 'phone_or_login_id',
    staff_credential: '6_digit_pin',
    management_credential: 'strong_password',
    owner_approval_required: true,
  })
}

function syntheticEmail(userId) {
  return `local-${String(userId || '').replace(/[^a-z0-9]/gi, '').slice(0, 24)}@chefops.invalid`
}

function normalizedEmail(value) {
  const email = String(value || '').trim().toLowerCase()
  if (!email) return ''
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : ''
}

async function existingRegistration(env, loginId, email) {
  const users = await listDirectoryRecords(env, 'User', { includeDeleted: false, limit: 5000 })
  const normalized = normalizeLoginId(loginId)
  const normalizedMail = normalizedEmail(email)
  return users.find((user) => (
    normalizeLoginId(user.phone) === normalized
    || normalizeLoginId(user.email) === normalized
    || (normalizedMail && String(user.email || '').trim().toLowerCase() === normalizedMail)
  )) || null
}

async function registerLocal(request, env) {
  requireLocalEnabled(env)
  if (localRegistrationMode(env) === 'disabled') {
    throw localError('New account requests are disabled', 'local_registration_disabled', 403)
  }
  const body = await readJson(request)
  const fullName = validateActualName(body.full_name, body.email)
  const loginId = normalizeLoginId(body.phone || body.login_id)
  if (!fullName) throw localError('Enter your actual name', 'invalid_actual_name')
  if (!loginId || !loginId.startsWith('+')) {
    throw localError('Enter a valid mobile phone number', 'local_phone_invalid')
  }

  const { clientHash, loginIdHash } = await fingerprints(request, loginId, env)
  const registrationBucket = `register:${clientHash}`
  await checkRateLimit(env, registrationBucket)
  await noteRateLimitFailure(env, registrationBucket, 3)

  const email = normalizedEmail(body.email)
  const existing = await existingRegistration(env, loginId, email)
  if (!existing) {
    const id = crypto.randomUUID()
    const now = new Date().toISOString()
    await saveDirectoryRecord(env, 'User', id, {
      id,
      outlet_id: '',
      outlet_ids: '[]',
      created_date: now,
      created_by: 'local-registration@chefops.invalid',
      updated_date: now,
      updated_by: 'local-registration@chefops.invalid',
      deleted_at: '',
      version: 1,
      google_sub: '',
      email: email || syntheticEmail(id),
      full_name: fullName,
      avatar_url: '',
      role: 'staff',
      phone: loginId,
      department: String(body.department || '').trim().slice(0, 80),
      status: 'pending',
      last_login_at: '',
      name_confirmed: true,
      name_confirmed_at: now,
      name_updated_at: now,
    }, {
      actorEmail: 'local-registration@chefops.invalid',
      operation: 'create',
    })
    await writeLocalAuthAudit(env, {
      eventType: 'registration_requested',
      userId: id,
      loginIdHash,
      clientHash,
      success: true,
    })
  } else {
    await writeLocalAuthAudit(env, {
      eventType: 'registration_duplicate',
      userId: existing.id,
      loginIdHash,
      clientHash,
      success: true,
    })
  }

  return json(request, env, {
    ok: true,
    status: 'pending',
    message: 'Request received. The Owner must approve the account before activation.',
  }, 202)
}

async function activateLocal(request, env) {
  requireLocalEnabled(env)
  const body = await readJson(request)
  const loginId = normalizeLoginId(body.login_id || body.phone)
  const { clientHash, loginIdHash } = await fingerprints(request, loginId, env)
  const clientBucket = `activate-client:${clientHash}`
  const loginBucket = `activate-login:${loginIdHash}`
  await Promise.all([checkRateLimit(env, clientBucket), checkRateLimit(env, loginBucket)])

  try {
    const result = await activateLocalCredential(env, {
      loginId,
      activationCode: body.activation_code,
      secret: body.secret || body.pin || body.password,
    })
    await Promise.all([clearRateLimit(env, clientBucket), clearRateLimit(env, loginBucket)])
    await writeLocalAuthAudit(env, {
      eventType: 'credential_activated',
      userId: result.user.id,
      loginIdHash,
      clientHash,
      success: true,
      details: { credential_kind: result.credential.credential_kind },
    })
    return json(request, env, {
      ok: true,
      credential_kind: result.credential.credential_kind,
      message: 'Local login activated. You may sign in now.',
    })
  } catch (error) {
    await Promise.allSettled([
      noteRateLimitFailure(env, clientBucket, 8),
      noteRateLimitFailure(env, loginBucket, 6),
      writeLocalAuthAudit(env, {
        eventType: 'credential_activation_failed',
        loginIdHash,
        clientHash,
        success: false,
        details: { code: String(error?.code || '') },
      }),
    ])
    throw error
  }
}

async function loginLocal(request, env) {
  requireLocalEnabled(env)
  const body = await readJson(request)
  const loginId = normalizeLoginId(body.login_id || body.phone)
  const secret = String(body.secret || body.pin || body.password || '')
  const { clientHash, loginIdHash } = await fingerprints(request, loginId, env)
  const clientBucket = `login-client:${clientHash}`
  const loginBucket = `login-id:${loginIdHash}`
  await Promise.all([checkRateLimit(env, clientBucket), checkRateLimit(env, loginBucket)])

  try {
    const credential = await authenticateCredential(env, loginId, secret)
    if (!credential) throw localError('Login ID or credential is incorrect', 'local_login_invalid', 401)
    const user = await findDirectoryUser(env, { id: credential.user_id })
    if (!user || String(user.status || '').toLowerCase() !== 'active') {
      throw localError(
        String(user?.status || '').toLowerCase() === 'pending'
          ? 'Your account is waiting for Owner approval'
          : 'This account is not active',
        String(user?.status || '').toLowerCase() === 'pending' ? 'user_pending' : 'user_inactive',
        403,
      )
    }

    const token = await createSession(user, env, {
      authMethod: 'local',
      sessionVersion: Number(credential.session_version || 1),
    })
    await Promise.all([clearRateLimit(env, clientBucket), clearRateLimit(env, loginBucket)])
    await writeLocalAuthAudit(env, {
      eventType: 'local_login',
      userId: user.id,
      loginIdHash,
      clientHash,
      success: true,
      details: { credential_kind: credential.credential_kind },
    })
    const response = { user: userWithProfileSetup(user) }
    if (isNativeAppRequest(request)) response.session_token = token
    return json(request, env, response, 200, {
      'Set-Cookie': sessionCookie(token, request),
    })
  } catch (error) {
    await Promise.allSettled([
      noteRateLimitFailure(env, clientBucket, 10),
      noteRateLimitFailure(env, loginBucket, 7),
      writeLocalAuthAudit(env, {
        eventType: 'local_login_failed',
        loginIdHash,
        clientHash,
        success: false,
        details: { code: String(error?.code || '') },
      }),
    ])
    throw error
  }
}

async function setupLocal(request, env) {
  requireLocalEnabled(env)
  const user = await getCurrentUser(request, env)
  const body = await readJson(request)
  const existing = await findCredentialByUserId(env, user.id)
  if (existing && !existing.disabled_at) {
    throw localError('Local login is already configured', 'local_credential_exists', 409)
  }
  const result = await setLocalCredential(env, user, {
    loginId: body.login_id || body.phone || user.phone || user.email,
    secret: body.secret || body.pin || body.password,
  })
  await writeLocalAuthAudit(env, {
    eventType: 'credential_setup_from_session',
    userId: user.id,
    loginIdHash: await authFingerprint(result.login_id, env, 'login-id'),
    clientHash: await authFingerprint(clientIdentity(request), env, 'client'),
    success: true,
    details: { credential_kind: result.credential_kind },
  })
  return json(request, env, { ok: true, credential: result })
}

async function changeLocal(request, env) {
  requireLocalEnabled(env)
  const user = await getCurrentUser(request, env)
  const body = await readJson(request)
  const current = await findCredentialByUserId(env, user.id)
  if (!current || current.disabled_at) {
    throw localError('Local login is not configured', 'local_credential_missing', 409)
  }
  const verified = await authenticateCredential(env, current.login_id, body.current_secret)
  if (!verified || String(verified.user_id) !== String(user.id)) {
    throw localError('Current credential is incorrect', 'local_current_secret_invalid', 401)
  }
  const result = await setLocalCredential(env, user, {
    loginId: body.login_id || current.login_id,
    secret: body.new_secret,
  })
  await writeLocalAuthAudit(env, {
    eventType: 'credential_changed',
    userId: user.id,
    loginIdHash: await authFingerprint(result.login_id, env, 'login-id'),
    clientHash: await authFingerprint(clientIdentity(request), env, 'client'),
    success: true,
    details: { credential_kind: result.credential_kind },
  })
  return json(request, env, { ok: true, credential: result })
}

async function localSummary(request, env) {
  requireLocalEnabled(env)
  const user = await getCurrentUser(request, env)
  return json(request, env, await credentialSummary(env, user.id))
}

async function issueActivation(request, env, userId) {
  requireLocalEnabled(env)
  const actor = await getCurrentUser(request, env)
  if (!['manager', 'owner'].includes(String(actor.role || '').toLowerCase())) {
    throw localError('Manager approval is required', 'manager_required', 403)
  }
  const target = await findDirectoryUser(env, { id: userId })
  if (!target) throw localError('User was not found', 'directory_user_not_found', 404)
  if (['manager', 'owner'].includes(String(target.role || '').toLowerCase()) && actor.role !== 'owner') {
    throw localError('Only the Owner may issue management credentials', 'owner_required', 403)
  }
  const body = await readJson(request)
  const activation = await issueLocalActivation(env, target, {
    loginId: body.login_id || target.phone || target.email,
    actorEmail: actor.email,
    revokeExisting: body.revoke_existing !== false,
  })
  await writeLocalAuthAudit(env, {
    eventType: 'activation_issued',
    userId: target.id,
    loginIdHash: await authFingerprint(activation.login_id, env, 'login-id'),
    clientHash: await authFingerprint(clientIdentity(request), env, 'client'),
    success: true,
    details: { actor_id: actor.id, credential_kind: activation.credential_kind },
  })
  return json(request, env, { ok: true, activation })
}

async function bootstrapOwner(request, env) {
  requireLocalEnabled(env)
  const configured = String(env.LOCAL_AUTH_BOOTSTRAP_SECRET || '')
  const provided = String(request.headers.get('X-ChefOps-Local-Auth-Bootstrap-Secret') || '')
  if (!secureEqual(configured, provided)) {
    throw localError('Invalid local auth bootstrap secret', 'local_auth_bootstrap_forbidden', 403)
  }
  const body = await readJson(request)
  const email = String(env.BOOTSTRAP_OWNER_EMAIL || DEFAULT_BOOTSTRAP_OWNER_EMAIL).trim().toLowerCase()
  const owner = await findDirectoryUser(env, { email })
  if (!owner || String(owner.role || '').toLowerCase() !== 'owner') {
    throw localError('Bootstrap Owner record was not found in D1', 'local_auth_owner_not_found', 404)
  }
  const result = await setLocalCredential(env, owner, {
    loginId: body.login_id || owner.email,
    secret: body.password,
  })
  await writeLocalAuthAudit(env, {
    eventType: 'owner_bootstrap',
    userId: owner.id,
    loginIdHash: await authFingerprint(result.login_id, env, 'login-id'),
    clientHash: await authFingerprint(clientIdentity(request), env, 'client'),
    success: true,
  })
  return json(request, env, {
    ok: true,
    owner_id: owner.id,
    login_id: result.login_id,
    credential_kind: result.credential_kind,
  })
}

export async function handleLocalAuth(request, env, url) {
  const path = url.pathname
  const userAccessMatch = path.match(/^\/api\/users\/([^/]+)\/local-access$/)
  const recognized = path === '/api/auth/config'
    || path.startsWith('/api/auth/local/')
    || path === '/api/internal/local-auth/bootstrap-owner'
    || Boolean(userAccessMatch)
  if (!recognized) return null

  try {
    if (path === '/api/auth/config' && request.method === 'GET') return authConfig(request, env)
    if (path === '/api/auth/local/register' && request.method === 'POST') return registerLocal(request, env)
    if (path === '/api/auth/local/activate' && request.method === 'POST') return activateLocal(request, env)
    if (path === '/api/auth/local/login' && request.method === 'POST') return loginLocal(request, env)
    if (path === '/api/auth/local/setup' && request.method === 'POST') return setupLocal(request, env)
    if (path === '/api/auth/local/change' && request.method === 'POST') return changeLocal(request, env)
    if (path === '/api/auth/local/summary' && request.method === 'GET') return localSummary(request, env)
    if (userAccessMatch && request.method === 'POST') {
      return issueActivation(request, env, decodeURIComponent(userAccessMatch[1]))
    }
    if (path === '/api/internal/local-auth/bootstrap-owner' && request.method === 'POST') {
      return bootstrapOwner(request, env)
    }
    throw localError('Method not allowed', 'method_not_allowed', 405)
  } catch (error) {
    return errorResponse(request, env, error)
  }
}

export { credentialKindForRole }
