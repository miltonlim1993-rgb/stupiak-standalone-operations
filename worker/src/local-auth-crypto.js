const DEFAULT_ITERATIONS = 210_000
const PEPPERED_HMAC_PREFIX = 'ph1:'
const ACTIVATION_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const COMMON_PINS = new Set([
  '000000', '111111', '222222', '333333', '444444',
  '555555', '666666', '777777', '888888', '999999',
  '123456', '654321',
])

function bytesToBase64Url(value) {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/g, '')
}

function base64UrlToBytes(value) {
  const normalized = String(value || '').replaceAll('-', '+').replaceAll('_', '/')
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=')
  const binary = atob(padded)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}

function randomBytes(length) {
  const bytes = new Uint8Array(length)
  crypto.getRandomValues(bytes)
  return bytes
}

function authError(message, code, status = 400) {
  const error = new Error(message)
  error.code = code
  error.status = status
  return error
}

function phoneLogin(value) {
  const compact = String(value || '').trim().replace(/[\s().-]+/g, '')
  if (!/^\+?\d+$/.test(compact)) return ''
  let digits = compact.replace(/^\+/, '')
  if (digits.startsWith('0')) digits = `60${digits.slice(1)}`
  else if (!digits.startsWith('60') && digits.length >= 9 && digits.length <= 11) digits = `60${digits}`
  if (digits.length < 10 || digits.length > 15) return ''
  return `+${digits}`
}

function emailLogin(value) {
  const email = String(value || '').trim().toLowerCase()
  if (!email || email.length > 254 || /\s/.test(email)) return ''
  return /^[^@]+@[^@]+\.[^@]+$/.test(email) ? email : ''
}

export function normalizeLoginId(value) {
  const raw = String(value || '').trim()
  if (!raw) return ''
  const phone = phoneLogin(raw)
  if (phone) return phone
  const email = emailLogin(raw)
  if (email) return email
  const normalized = raw.toLowerCase().replace(/\s+/g, '')
  if (!/^[a-z0-9][a-z0-9._-]{2,63}$/.test(normalized)) return ''
  return normalized
}

export function displayLoginId(value) {
  const normalized = normalizeLoginId(value)
  if (!normalized) return ''
  if (!normalized.startsWith('+')) return normalized
  if (normalized.length <= 7) return normalized
  return `${normalized.slice(0, 4)}••••${normalized.slice(-3)}`
}

export function credentialKindForRole(role) {
  return ['owner', 'manager'].includes(String(role || '').trim().toLowerCase())
    ? 'password'
    : 'pin'
}

export function validatePin(value) {
  const pin = String(value || '')
  if (!/^\d{6}$/.test(pin)) {
    throw authError('PIN must contain exactly 6 digits', 'local_pin_invalid')
  }
  if (COMMON_PINS.has(pin)) {
    throw authError('Choose a PIN that is not repeated digits or 123456', 'local_pin_too_common')
  }
  return pin
}

export function validatePassword(value) {
  const password = String(value || '')
  if (password.length < 8 || password.length > 128 || password.trim().length < 8) {
    throw authError('Password must contain at least 8 characters', 'local_password_length')
  }
  return password
}

export function validateCredentialSecret(kind, value, loginId = '') {
  return kind === 'password'
    ? validatePassword(value, loginId)
    : validatePin(value, loginId)
}

function pepper(env) {
  const value = String(env.LOCAL_AUTH_PEPPER || '')
  if (value.length < 32) {
    throw authError('Local authentication is not configured', 'local_auth_not_configured', 503)
  }
  return value
}

async function deriveLegacyPbkdf2({ secret, loginId, purpose, salt, iterations, env }) {
  const normalizedLogin = normalizeLoginId(loginId)
  const material = new TextEncoder().encode(
    `${String(purpose || 'credential')}\u0000${normalizedLogin}\u0000${String(secret || '')}\u0000${pepper(env)}`,
  )
  const key = await crypto.subtle.importKey('raw', material, 'PBKDF2', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits({
    name: 'PBKDF2',
    hash: 'SHA-256',
    salt,
    iterations,
  }, key, 256)
  return new Uint8Array(bits)
}

async function derivePepperedHmac({ secret, loginId, purpose, salt, env }) {
  const normalizedLogin = normalizeLoginId(loginId)
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(pepper(env)),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const message = new TextEncoder().encode(
    `${String(purpose || 'credential')}\u0000${normalizedLogin}\u0000${String(secret || '')}\u0000${bytesToBase64Url(salt)}`,
  )
  const signature = await crypto.subtle.sign('HMAC', key, message)
  return new Uint8Array(signature)
}

export async function hashLocalSecret({
  secret,
  loginId,
  purpose = 'credential',
  salt = randomBytes(16),
  env,
}) {
  const derived = await derivePepperedHmac({ secret, loginId, purpose, salt, env })
  return {
    hash: `${PEPPERED_HMAC_PREFIX}${bytesToBase64Url(derived)}`,
    salt: bytesToBase64Url(salt),
    iterations: DEFAULT_ITERATIONS,
  }
}

function constantTimeEqual(left, right) {
  if (left.length !== right.length) return false
  let mismatch = 0
  for (let index = 0; index < left.length; index += 1) mismatch |= left[index] ^ right[index]
  return mismatch === 0
}

export async function verifyLocalSecret({
  secret,
  loginId,
  purpose = 'credential',
  expectedHash,
  salt,
  iterations,
  env,
}) {
  try {
    const saltBytes = base64UrlToBytes(salt)
    const stored = String(expectedHash || '')
    if (stored.startsWith(PEPPERED_HMAC_PREFIX)) {
      const actual = await derivePepperedHmac({
        secret,
        loginId,
        purpose,
        salt: saltBytes,
        env,
      })
      return constantTimeEqual(actual, base64UrlToBytes(stored.slice(PEPPERED_HMAC_PREFIX.length)))
    }

    const actual = await deriveLegacyPbkdf2({
      secret,
      loginId,
      purpose,
      salt: saltBytes,
      iterations: Math.max(120_000, Number(iterations) || DEFAULT_ITERATIONS),
      env,
    })
    return constantTimeEqual(actual, base64UrlToBytes(stored))
  } catch {
    return false
  }
}

export function generateActivationCode(length = 8) {
  const bytes = randomBytes(Math.max(8, Number(length) || 8))
  let code = ''
  for (let index = 0; index < Math.max(8, Number(length) || 8); index += 1) {
    code += ACTIVATION_ALPHABET[bytes[index] % ACTIVATION_ALPHABET.length]
  }
  return code
}

export async function authFingerprint(value, env, purpose = 'audit') {
  const data = new TextEncoder().encode(`${purpose}\u0000${String(value || '')}\u0000${pepper(env)}`)
  const digest = await crypto.subtle.digest('SHA-256', data)
  return bytesToBase64Url(digest).slice(0, 32)
}

export function localAuthMode(env) {
  const configured = String(env.LOCAL_AUTH_MODE || 'enabled').trim().toLowerCase()
  return configured === 'disabled' ? 'disabled' : 'enabled'
}

export function googleLoginMode(env) {
  const configured = String(env.GOOGLE_LOGIN_MODE || 'fallback').trim().toLowerCase()
  return configured === 'disabled' ? 'disabled' : 'fallback'
}

export function localRegistrationMode(env) {
  return String(env.LOCAL_AUTH_REGISTRATION || 'enabled').trim().toLowerCase() === 'disabled'
    ? 'disabled'
    : 'enabled'
}

export { authError, DEFAULT_ITERATIONS, PEPPERED_HMAC_PREFIX }
