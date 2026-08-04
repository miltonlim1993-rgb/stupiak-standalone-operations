const configuredApiUrl = String(import.meta.env.VITE_API_BASE_URL || '').trim()
const API_BASE_URL = (
  configuredApiUrl
  || (import.meta.env.DEV ? 'http://localhost:8787' : window.location.origin)
).replace(/\/$/, '')
const PENDING_TOKEN_KEY = 'chefops.auth.pending-approval-token'

export class LocalAuthError extends Error {
  constructor(message, status, code, details) {
    super(message)
    this.name = 'LocalAuthError'
    this.status = status
    this.code = code
    this.details = details
  }
}

function pendingToken() {
  try { return sessionStorage.getItem(PENDING_TOKEN_KEY) || '' } catch { return '' }
}

function savePendingToken(value) {
  try {
    if (value) sessionStorage.setItem(PENDING_TOKEN_KEY, value)
    else sessionStorage.removeItem(PENDING_TOKEN_KEY)
  } catch {}
}

async function request(path, { method = 'GET', body, headers: inputHeaders } = {}) {
  const headers = new Headers(inputHeaders || {})
  const init = {
    method,
    headers,
    credentials: 'include',
    cache: 'no-store',
  }
  if (body !== undefined) {
    headers.set('Content-Type', 'application/json')
    init.body = JSON.stringify(body)
  }
  const response = await fetch(`${API_BASE_URL}${path}`, init)
  const contentType = String(response.headers.get('content-type') || '')
  const data = contentType.includes('application/json')
    ? await response.json()
    : await response.text()
  if (!response.ok) {
    throw new LocalAuthError(
      data?.error || data?.message || `Request failed (${response.status})`,
      response.status,
      data?.code,
      data?.details,
    )
  }
  return data
}

export const localAuthClient = {
  config: () => request('/api/auth/config'),
  startEmail: async ({ email }) => {
    try {
      const result = await request('/api/auth/local/email/start', {
        method: 'POST',
        body: { email },
      })
      if (result?.pending_token) savePendingToken(result.pending_token)
      return result
    } catch (error) {
      if (Number(error?.status || 0) === 409) {
        return {
          ok: true,
          status: 'credential_setup_required',
          email,
          message: error.message,
        }
      }
      throw error
    }
  },
  emailStatus: async () => {
    const token = pendingToken()
    const result = await request('/api/auth/local/email/status', {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    })
    if (!['pending', 'credential_setup_required'].includes(result?.status)) savePendingToken('')
    return result
  },
  emailSetup: async ({ secret }) => {
    const token = pendingToken()
    const result = await request('/api/auth/local/email/setup', {
      method: 'POST',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      body: { secret },
    })
    if (result?.status === 'active') savePendingToken('')
    return result
  },
  emailLogin: ({ email, secret }) => request('/api/auth/local/email/login', {
    method: 'POST',
    body: { email, secret },
  }),
  clearPendingApproval: () => savePendingToken(''),
  login: ({ loginId, secret }) => request('/api/auth/local/login', {
    method: 'POST',
    body: { login_id: loginId, secret },
  }),
  register: ({ fullName, phone, email = '', department = '' }) => request('/api/auth/local/register', {
    method: 'POST',
    body: {
      full_name: fullName,
      phone,
      email,
      department,
    },
  }),
  activate: ({ loginId, activationCode, secret }) => request('/api/auth/local/activate', {
    method: 'POST',
    body: {
      login_id: loginId,
      activation_code: activationCode,
      secret,
    },
  }),
  setup: ({ loginId, secret }) => request('/api/auth/local/setup', {
    method: 'POST',
    body: { login_id: loginId, secret },
  }),
  change: ({ currentSecret, newSecret, loginId = '' }) => request('/api/auth/local/change', {
    method: 'POST',
    body: {
      current_secret: currentSecret,
      new_secret: newSecret,
      login_id: loginId,
    },
  }),
  summary: () => request('/api/auth/local/summary'),
  issueActivation: (userId, { loginId = '', revokeExisting = true } = {}) => request(
    `/api/users/${encodeURIComponent(userId)}/local-access`,
    {
      method: 'POST',
      body: {
        login_id: loginId,
        revoke_existing: revokeExisting,
      },
    },
  ),
}
