import app, { OutletRealtimeHub } from './entry.js'
import { handleLocalAuth } from './local-auth.js'

function isLocalAuthPath(pathname) {
  return pathname === '/api/auth/config'
    || pathname.startsWith('/api/auth/local/')
    || pathname === '/api/internal/local-auth/bootstrap-owner'
    || /^\/api\/users\/[^/]+\/local-access$/.test(pathname)
}

export default {
  ...app,

  async fetch(request, env, ctx) {
    const url = new URL(request.url)
    if (!isLocalAuthPath(url.pathname) || request.method === 'OPTIONS') {
      return app.fetch(request, env, ctx)
    }

    const response = await handleLocalAuth(request, env, url)
    if (response) return response
    return app.fetch(request, env, ctx)
  },
}

export { OutletRealtimeHub }
