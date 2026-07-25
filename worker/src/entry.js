import app from './index.js'

function isApiPath(pathname) {
  return pathname === '/api' || pathname.startsWith('/api/')
}

function isNativeAppRequest(request) {
  const origin = String(request.headers.get('Origin') || '').toLowerCase()
  return origin === 'https://localhost' || origin === 'capacitor://localhost'
}

function sessionTokenFromCookie(value) {
  const match = String(value || '').match(/(?:^|;\s*)chefops_session=([^;]+)/)
  if (!match) return ''
  try { return decodeURIComponent(match[1]) } catch { return match[1] }
}

async function exposeNativeSessionToken(request, response, pathname) {
  if (
    pathname !== '/api/auth/google'
    || request.method !== 'POST'
    || !isNativeAppRequest(request)
    || !response.ok
  ) return response

  const token = sessionTokenFromCookie(response.headers.get('Set-Cookie'))
  if (!token) return response

  const data = await response.clone().json().catch(() => null)
  if (!data || typeof data !== 'object') return response

  const headers = new Headers(response.headers)
  headers.delete('Content-Length')

  return new Response(JSON.stringify({ ...data, session_token: token }), {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url)

    if (isApiPath(url.pathname)) {
      const response = await app.fetch(request, env, ctx)
      return exposeNativeSessionToken(request, response, url.pathname)
    }

    return env.ASSETS.fetch(request)
  },

  async scheduled(event, env, ctx) {
    if (typeof app.scheduled === 'function') {
      return app.scheduled(event, env, ctx)
    }
  },
}
