import {
  credentialKindForRole,
  generateActivationCode,
  hashLocalSecret,
  normalizeLoginId,
  verifyLocalSecret,
} from './local-auth-crypto.js'
import { findDirectoryRecord } from './d1-directory-store.js'

const ACTIVATION_TTL_MS = 48 * 60 * 60 * 1000
const CREDENTIAL_FAILURE_LIMIT = 5
const ACTIVATION_FAILURE_LIMIT = 5
const RATE_WINDOW_MS = 15 * 60 * 1000
const RATE_LOCK_MS = 15 * 60 * 1000

function timestamp(value = Date.now()) {
  return new Date(value).toISOString()
}

function database(env) {
  if (!env.OPS_DB?.prepare) {
    const error = new Error('OPS D1 database is not configured')
    error.status = 503
    error.code = 'ops_database_unavailable'
    throw error
  }
  return env.OPS_DB
}

function localAuthError(message, code, status = 400) {
  const error = new Error(message)
  error.code = code
  error.status = status
  return error
}

function rowLocked(row) {
  const until = Date.parse(String(row?.locked_until || ''))
  return Number.isFinite(until) && until > Date.now()
}

function publicLockError() {
  return localAuthError('Too many attempts. Try again later.', 'local_auth_locked', 429)
}

export async function localAuthSchemaReady(env) {
  try {
    const row = await database(env).prepare(`
      SELECT COUNT(*) AS count
      FROM sqlite_master
      WHERE type = 'table'
        AND name IN ('local_credentials', 'local_auth_activations', 'local_auth_rate_limits', 'local_auth_audit')
    `).first()
    return Number(row?.count || 0) === 4
  } catch {
    return false
  }
}

export async function requireLocalAuthSchema(env) {
  if (await localAuthSchemaReady(env)) return true
  throw localAuthError(
    'Local authentication is awaiting its approved database migration',
    'local_auth_migration_required',
    503,
  )
}

export async function findCredentialByLogin(env, loginId) {
  await requireLocalAuthSchema(env)
  const normalized = normalizeLoginId(loginId)
  if (!normalized) return null
  return database(env).prepare(`
    SELECT * FROM local_credentials
    WHERE login_id = ?
    LIMIT 1
  `).bind(normalized).first()
}

export async function findCredentialByUserId(env, userId) {
  await requireLocalAuthSchema(env)
  return database(env).prepare(`
    SELECT * FROM local_credentials
    WHERE user_id = ?
    LIMIT 1
  `).bind(String(userId || '').trim()).first()
}

export async function assertLocalSessionVersion(env, userId, expectedVersion) {
  const credential = await findCredentialByUserId(env, userId)
  if (
    !credential
    || credential.disabled_at
    || Number(credential.session_version || 0) !== Number(expectedVersion || 0)
  ) {
    throw localAuthError('Your local session is no longer valid', 'local_session_revoked', 401)
  }
  return credential
}

async function credentialFailure(env, credential) {
  const attempts = Number(credential.failed_attempts || 0) + 1
  const lockedUntil = attempts >= CREDENTIAL_FAILURE_LIMIT
    ? timestamp(Date.now() + RATE_LOCK_MS)
    : ''
  await database(env).prepare(`
    UPDATE local_credentials
    SET failed_attempts = ?, locked_until = ?, updated_at = ?
    WHERE user_id = ?
  `).bind(attempts, lockedUntil, timestamp(), credential.user_id).run()
  if (lockedUntil) throw publicLockError()
}

async function activationFailure(env, activation) {
  const attempts = Number(activation.attempts || 0) + 1
  const lockedUntil = attempts >= ACTIVATION_FAILURE_LIMIT
    ? timestamp(Date.now() + RATE_LOCK_MS)
    : ''
  await database(env).prepare(`
    UPDATE local_auth_activations
    SET attempts = ?, locked_until = ?
    WHERE user_id = ?
  `).bind(attempts, lockedUntil, activation.user_id).run()
  if (lockedUntil) throw publicLockError()
}

export async function authenticateCredential(env, loginId, secret) {
  const normalized = normalizeLoginId(loginId)
  if (!normalized) return null
  const credential = await findCredentialByLogin(env, normalized)
  if (!credential || credential.disabled_at) return null
  if (rowLocked(credential)) throw publicLockError()

  const valid = await verifyLocalSecret({
    secret,
    loginId: normalized,
    purpose: `credential:${credential.credential_kind}`,
    expectedHash: credential.secret_hash,
    salt: credential.salt,
    iterations: credential.iterations,
    env,
  })
  if (!valid) {
    await credentialFailure(env, credential)
    return null
  }

  const now = timestamp()
  await database(env).prepare(`
    UPDATE local_credentials
    SET failed_attempts = 0, locked_until = '', last_login_at = ?, updated_at = ?
    WHERE user_id = ?
  `).bind(now, now, credential.user_id).run()
  return {
    ...credential,
    failed_attempts: 0,
    locked_until: '',
    last_login_at: now,
    updated_at: now,
  }
}

export async function loginIdReserved(env, loginId, { excludeUserId = '' } = {}) {
  await requireLocalAuthSchema(env)
  const normalized = normalizeLoginId(loginId)
  if (!normalized) return false
  const row = await database(env).prepare(`
    SELECT user_id FROM local_credentials WHERE login_id = ?
    UNION ALL
    SELECT user_id FROM local_auth_activations WHERE login_id = ? AND used_at = ''
    LIMIT 1
  `).bind(normalized, normalized).first()
  return Boolean(row && String(row.user_id || '') !== String(excludeUserId || ''))
}

export async function issueLocalActivation(env, user, {
  loginId,
  actorEmail = 'owner@chefops.local',
  revokeExisting = true,
} = {}) {
  await requireLocalAuthSchema(env)
  if (!user?.id) throw localAuthError('User is required', 'local_auth_user_required')
  if (String(user.status || '').toLowerCase() !== 'active') {
    throw localAuthError('Approve the user before issuing an activation code', 'local_auth_user_not_active', 409)
  }

  const normalized = normalizeLoginId(loginId || user.phone || user.email)
  if (!normalized) {
    throw localAuthError('A valid phone number or login ID is required', 'local_login_id_invalid')
  }
  if (await loginIdReserved(env, normalized, { excludeUserId: user.id })) {
    throw localAuthError('That login ID is already assigned', 'local_login_id_in_use', 409)
  }

  const code = generateActivationCode(8)
  const derived = await hashLocalSecret({
    secret: code,
    loginId: normalized,
    purpose: 'activation',
    env,
  })
  const now = timestamp()
  const expiresAt = timestamp(Date.now() + ACTIVATION_TTL_MS)
  const db = database(env)
  const statements = [
    db.prepare(`
      INSERT INTO local_auth_activations (
        user_id, login_id, code_hash, salt, iterations, expires_at,
        attempts, locked_until, created_by, created_at, used_at
      ) VALUES (?, ?, ?, ?, ?, ?, 0, '', ?, ?, '')
      ON CONFLICT(user_id) DO UPDATE SET
        login_id = excluded.login_id,
        code_hash = excluded.code_hash,
        salt = excluded.salt,
        iterations = excluded.iterations,
        expires_at = excluded.expires_at,
        attempts = 0,
        locked_until = '',
        created_by = excluded.created_by,
        created_at = excluded.created_at,
        used_at = ''
    `).bind(
      user.id,
      normalized,
      derived.hash,
      derived.salt,
      derived.iterations,
      expiresAt,
      actorEmail,
      now,
    ),
  ]

  if (revokeExisting) {
    statements.push(db.prepare(`
      UPDATE local_credentials
      SET disabled_at = ?, session_version = session_version + 1,
          failed_attempts = 0, locked_until = '', updated_at = ?
      WHERE user_id = ?
    `).bind(now, now, user.id))
  }
  await db.batch(statements)
  return {
    user_id: String(user.id),
    login_id: normalized,
    activation_code: code,
    expires_at: expiresAt,
    credential_kind: credentialKindForRole(user.role),
  }
}

export async function activateLocalCredential(env, {
  loginId,
  activationCode,
  secret,
}) {
  await requireLocalAuthSchema(env)
  const normalized = normalizeLoginId(loginId)
  if (!normalized) throw localAuthError('Enter a valid login ID', 'local_login_id_invalid')
  const activation = await database(env).prepare(`
    SELECT * FROM local_auth_activations
    WHERE login_id = ?
    LIMIT 1
  `).bind(normalized).first()

  if (!activation || activation.used_at || Date.parse(activation.expires_at) <= Date.now()) {
    throw localAuthError('Activation code is invalid or expired', 'local_activation_invalid', 400)
  }
  if (rowLocked(activation)) throw publicLockError()

  const validCode = await verifyLocalSecret({
    secret: String(activationCode || '').toUpperCase().replace(/\s+/g, ''),
    loginId: normalized,
    purpose: 'activation',
    expectedHash: activation.code_hash,
    salt: activation.salt,
    iterations: activation.iterations,
    env,
  })
  if (!validCode) {
    await activationFailure(env, activation)
    throw localAuthError('Activation code is invalid or expired', 'local_activation_invalid', 400)
  }

  const user = await findDirectoryRecord(env, 'User', activation.user_id)
  if (!user || String(user.status || '').toLowerCase() !== 'active') {
    throw localAuthError('This account is not approved for access', 'local_user_not_active', 403)
  }
  const kind = credentialKindForRole(user.role)
  const derived = await hashLocalSecret({
    secret,
    loginId: normalized,
    purpose: `credential:${kind}`,
    env,
  })
  const now = timestamp()
  const existing = await findCredentialByUserId(env, user.id)
  const sessionVersion = Number(existing?.session_version || 0) + 1
  const db = database(env)
  await db.batch([
    db.prepare(`
      INSERT INTO local_credentials (
        user_id, login_id, credential_kind, secret_hash, salt, iterations,
        must_change, failed_attempts, locked_until, session_version,
        last_login_at, password_changed_at, created_at, updated_at, disabled_at
      ) VALUES (?, ?, ?, ?, ?, ?, 0, 0, '', ?, '', ?, ?, ?, '')
      ON CONFLICT(user_id) DO UPDATE SET
        login_id = excluded.login_id,
        credential_kind = excluded.credential_kind,
        secret_hash = excluded.secret_hash,
        salt = excluded.salt,
        iterations = excluded.iterations,
        must_change = 0,
        failed_attempts = 0,
        locked_until = '',
        session_version = excluded.session_version,
        password_changed_at = excluded.password_changed_at,
        updated_at = excluded.updated_at,
        disabled_at = ''
    `).bind(
      user.id,
      normalized,
      kind,
      derived.hash,
      derived.salt,
      derived.iterations,
      sessionVersion,
      now,
      existing?.created_at || now,
      now,
    ),
    db.prepare(`
      UPDATE local_auth_activations
      SET used_at = ?, attempts = 0, locked_until = ''
      WHERE user_id = ?
    `).bind(now, user.id),
  ])
  return {
    user,
    credential: {
      user_id: user.id,
      login_id: normalized,
      credential_kind: kind,
      session_version: sessionVersion,
      must_change: false,
    },
  }
}

export async function setLocalCredential(env, user, {
  loginId,
  secret,
  mustChange = false,
}) {
  await requireLocalAuthSchema(env)
  if (!user?.id) throw localAuthError('User is required', 'local_auth_user_required')
  const normalized = normalizeLoginId(loginId || user.phone || user.email)
  if (!normalized) throw localAuthError('Enter a valid phone number or login ID', 'local_login_id_invalid')
  if (await loginIdReserved(env, normalized, { excludeUserId: user.id })) {
    throw localAuthError('That login ID is already assigned', 'local_login_id_in_use', 409)
  }
  const kind = credentialKindForRole(user.role)
  const derived = await hashLocalSecret({
    secret,
    loginId: normalized,
    purpose: `credential:${kind}`,
    env,
  })
  const existing = await findCredentialByUserId(env, user.id)
  const now = timestamp()
  const sessionVersion = Number(existing?.session_version || 0) + 1
  await database(env).prepare(`
    INSERT INTO local_credentials (
      user_id, login_id, credential_kind, secret_hash, salt, iterations,
      must_change, failed_attempts, locked_until, session_version,
      last_login_at, password_changed_at, created_at, updated_at, disabled_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, '', ?, '', ?, ?, ?, '')
    ON CONFLICT(user_id) DO UPDATE SET
      login_id = excluded.login_id,
      credential_kind = excluded.credential_kind,
      secret_hash = excluded.secret_hash,
      salt = excluded.salt,
      iterations = excluded.iterations,
      must_change = excluded.must_change,
      failed_attempts = 0,
      locked_until = '',
      session_version = excluded.session_version,
      password_changed_at = excluded.password_changed_at,
      updated_at = excluded.updated_at,
      disabled_at = ''
  `).bind(
    user.id,
    normalized,
    kind,
    derived.hash,
    derived.salt,
    derived.iterations,
    mustChange ? 1 : 0,
    sessionVersion,
    now,
    existing?.created_at || now,
    now,
  ).run()
  return {
    user_id: user.id,
    login_id: normalized,
    credential_kind: kind,
    session_version: sessionVersion,
    must_change: Boolean(mustChange),
  }
}

export async function credentialSummary(env, userId) {
  const credential = await findCredentialByUserId(env, userId)
  if (!credential) return { configured: false }
  return {
    configured: !Boolean(credential.disabled_at),
    login_id: credential.login_id,
    credential_kind: credential.credential_kind,
    must_change: Boolean(credential.must_change),
    locked_until: credential.locked_until || '',
    last_login_at: credential.last_login_at || '',
    updated_at: credential.updated_at || '',
  }
}

export async function checkRateLimit(env, bucketKey) {
  await requireLocalAuthSchema(env)
  const row = await database(env).prepare(`
    SELECT * FROM local_auth_rate_limits WHERE bucket_key = ? LIMIT 1
  `).bind(String(bucketKey || '')).first()
  if (rowLocked(row)) throw publicLockError()
  return row
}

export async function noteRateLimitFailure(env, bucketKey, limit = 8) {
  await requireLocalAuthSchema(env)
  const key = String(bucketKey || '')
  const existing = await database(env).prepare(`
    SELECT * FROM local_auth_rate_limits WHERE bucket_key = ? LIMIT 1
  `).bind(key).first()
  const nowMs = Date.now()
  const windowStart = Date.parse(existing?.window_started_at || '')
  const sameWindow = Number.isFinite(windowStart) && nowMs - windowStart < RATE_WINDOW_MS
  const attempts = sameWindow ? Number(existing?.attempts || 0) + 1 : 1
  const lockedUntil = attempts >= Math.max(3, Number(limit) || 8)
    ? timestamp(nowMs + RATE_LOCK_MS)
    : ''
  const now = timestamp(nowMs)
  await database(env).prepare(`
    INSERT INTO local_auth_rate_limits (
      bucket_key, window_started_at, attempts, locked_until, updated_at
    ) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(bucket_key) DO UPDATE SET
      window_started_at = excluded.window_started_at,
      attempts = excluded.attempts,
      locked_until = excluded.locked_until,
      updated_at = excluded.updated_at
  `).bind(key, sameWindow ? existing.window_started_at : now, attempts, lockedUntil, now).run()
  if (lockedUntil) throw publicLockError()
}

export async function clearRateLimit(env, bucketKey) {
  await requireLocalAuthSchema(env)
  await database(env).prepare('DELETE FROM local_auth_rate_limits WHERE bucket_key = ?')
    .bind(String(bucketKey || '')).run()
}

export async function writeLocalAuthAudit(env, {
  eventType,
  userId = '',
  loginIdHash = '',
  clientHash = '',
  success = false,
  details = {},
}) {
  try {
    await requireLocalAuthSchema(env)
    await database(env).prepare(`
      INSERT INTO local_auth_audit (
        event_type, user_id, login_id_hash, client_hash,
        success, details_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).bind(
      String(eventType || 'unknown'),
      String(userId || ''),
      String(loginIdHash || ''),
      String(clientHash || ''),
      success ? 1 : 0,
      JSON.stringify(details || {}),
      timestamp(),
    ).run()
  } catch (error) {
    console.error('Unable to write local auth audit event', error)
  }
}

export { localAuthError }
