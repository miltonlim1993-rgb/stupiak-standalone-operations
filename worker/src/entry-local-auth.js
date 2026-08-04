import app, { OutletRealtimeHub } from './entry.js'
import { getCurrentUser } from './auth.js'
import { handleEmailApprovalAuth } from './email-approval-auth.js'
import { corsHeaders, errorResponse } from './http.js'
import { handleLocalAuth } from './local-auth.js'

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

export default {
  ...app,

  async fetch(request, env, ctx) {
    const url = new URL(request.url)
    if (!isLocalAuthPath(url.pathname)) return app.fetch(request, env, ctx)
    if (request.method === 'OPTIONS') return localAuthPreflight(request, env)

    const ownerGuard = await enforceOwnerActivation(request, env, url)
    if (ownerGuard) return ownerGuard

    try {
      const emailResponse = await handleEmailApprovalAuth(request, env, url)
      if (emailResponse) return emailResponse

      const response = await handleLocalAuth(request, env, url)
      if (response) return response
      return app.fetch(request, env, ctx)
    } catch (error) {
      return errorResponse(request, env, error)
    }
  },
}

export { OutletRealtimeHub }
