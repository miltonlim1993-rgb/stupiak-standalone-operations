import app, { OutletRealtimeHub } from './entry.js'
import { getCurrentUser } from './auth.js'
import { handleEmailApprovalAuth } from './email-approval-auth.js'
import { corsHeaders, errorResponse } from './http.js'
import { handleLocalAuth } from './local-auth.js'
import { handleStatvaraOpsApi } from './statvara-ops-api.js'

function isLocalAccessPath(pathname) {
  return /^\/api\/users\/[^/]+\/local-access$/.test(pathname)
}

function isLocalAuthPath(pathname) {
  return pathname === '/api/auth/config'
    || pathname.startsWith('/api/auth/local/')
    || pathname === '/api/internal/local-auth/bootstrap-owner'
    || isLocalAccessPath(pathname)
}

function localAuthPreflight(request, env) {
  const headers = new Headers(corsHeaders(request, env))
  headers.set(
    'Access-Control-Allow-Headers',
    'Authorization, Content-Type, X-ChefOps-Native, X-ChefOps-Local-Auth-Bootstrap-Secret, X-Requested-With',
  )
  headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  headers.set('Access-Control-Max-Age', '600')
  return new Response(null, { status: 204, headers })
}

function preservePromotedSessionCookie(response) {
  const raw = String(response?.headers?.get('Set-Cookie') || '')
  const marker = ', chefops_pending_approval='
  const markerIndex = raw.indexOf(marker)
  if (markerIndex < 0) return response

  const headers = new Headers(response.headers)
  headers.set('Set-Cookie', raw.slice(0, markerIndex))
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

function withLocalSetupDiagnostic(error, url) {
  if (url.pathname !== '/api/auth/local/email/setup') return error
  const status = Number(error?.status || 500)
  if (status < 500) return error

  const reference = crypto.randomUUID()
  const code = String(error?.code || 'local_credential_setup_failed')
  const originalMessage = String(error?.message || error)
  console.error('Local credential setup failed', {
    reference,
    path: url.pathname,
    code,
    message: originalMessage,
    stack: String(error?.stack || ''),
  })

  const diagnostic = new Error(originalMessage)
  diagnostic.status = status
  diagnostic.code = code
  diagnostic.publicMessage = `Unable to save your password right now. Reference: ${reference.slice(0, 8)}`
  return diagnostic
}

async function enforceOwnerActivation(request, env, url) {
  if (!isLocalAccessPath(url.pathname)) return null
  try {
    const actor = await getCurrentUser(request, env)
    if (String(actor?.role || '').toLowerCase() !== 'owner') {
      const error = new Error('Only the Owner may issue or reset local login access')
      error.status = 403
      error.code = 'owner_required'
      throw error
    }
    return null
  } catch (error) {
    return errorResponse(request, env, error)
  }
}

function runtimeEnv(env, ctx) {
  const value = Object.create(env)
  Object.defineProperty(value, '__CHEFOPS_CTX', { value: ctx, enumerable: false })
  return value
}

export default {
  ...app,

  async fetch(request, env, ctx) {
    const url = new URL(request.url)

    if (url.pathname.startsWith('/api/ops/v1')) {
      try {
        const response = await handleStatvaraOpsApi(request, runtimeEnv(env, ctx), url)
        if (response) return response
      } catch (error) {
        return errorResponse(request, env, error)
      }
    }

    if (!isLocalAuthPath(url.pathname)) return app.fetch(request, env, ctx)
    if (request.method === 'OPTIONS') return localAuthPreflight(request, env)

    const ownerGuard = await enforceOwnerActivation(request, env, url)
    if (ownerGuard) return ownerGuard

    try {
      const emailResponse = await handleEmailApprovalAuth(request, env, url)
      if (emailResponse) return preservePromotedSessionCookie(emailResponse)

      const response = await handleLocalAuth(request, env, url)
      if (response) return response
      return app.fetch(request, env, ctx)
    } catch (error) {
      return errorResponse(request, env, withLocalSetupDiagnostic(error, url))
    }
  },
}

export { OutletRealtimeHub }
