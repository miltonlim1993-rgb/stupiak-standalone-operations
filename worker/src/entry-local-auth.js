import app, { OutletRealtimeHub } from './entry.js'
import { corsHeaders } from './http.js'
import { handleLocalAuth } from './local-auth.js'

function isLocalAuthPath(pathname) {
  return pathname === '/api/auth/config'
    || pathname.startsWith('/api/auth/local/')
    || pathname === '/api/internal/local-auth/bootstrap-owner'
    || /^\/api\/users\/[^/]+\/local-access$/.test(pathname)
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

export default {
  ...app,

  async fetch(request, env, ctx) {
    const url = new URL(request.url)
    if (!isLocalAuthPath(url.pathname)) return app.fetch(request, env, ctx)
    if (request.method === 'OPTIONS') return localAuthPreflight(request, env)

    const response = await handleLocalAuth(request, env, url)
    if (response) return response
    return app.fetch(request, env, ctx)
  },
}

export { OutletRealtimeHub }
