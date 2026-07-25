import app from './index.js'
import { loginWithGoogle, sessionCookie } from './auth.js'
import { errorResponse, json, readJson } from './http.js'
import { ensureEntitySheet } from './sheets.js'

const WORKER_REVISION = 'native-session-v2'

function isApiPath(pathname) {
  return pathname === '/api' || pathname.startsWith('/api/')
}

function isNativeAppRequest(request) {
  const origin = String(request.headers.get('Origin') || '').toLowerCase()
  const marker = String(request.headers.get('X-ChefOps-Native') || '').toLowerCase()
  return marker === 'android' || origin === 'https://localhost' || origin === 'capacitor://localhost'
}

function allowedOrigins(env) {
  const configured = String(env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)

  return new Set([
    ...configured,
    'https://stupiaks-ops.sporkburger19.workers.dev',
    'https://localhost',
    'capacitor://localhost',
    'http://localhost:5188',
  ])
}

function apiCorsHeaders(request, env) {
  const origin = String(request.headers.get('Origin') || '')
  const allowed = allowedOrigins(env)
  const allowOrigin = allowed.has(origin)
    ? origin
    : (allowed.has('https://stupiaks-ops.sporkburger19.workers.dev')
        ? 'https://stupiaks-ops.sporkburger19.workers.dev'
        : 'null')

  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-ChefOps-Native, X-Requested-With',
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
    'Access-Control-Max-Age': '600',
    'Access-Control-Expose-Headers': 'X-ChefOps-Worker-Revision',
    'Vary': 'Origin',
    'X-ChefOps-Worker-Revision': WORKER_REVISION,
  }
}

function withApiHeaders(request, env, response) {
  const headers = new Headers(response.headers)
  for (const [key, value] of Object.entries(apiCorsHeaders(request, env))) {
    headers.set(key, value)
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

async function handleNativeGoogleLogin(request, env, pathname) {
  if (
    pathname !== '/api/auth/google'
    || request.method !== 'POST'
    || !isNativeAppRequest(request)
  ) return null

  try {
    await ensureEntitySheet(env, 'User')
    const { credential } = await readJson(request)
    const { user, token } = await loginWithGoogle(credential, env)
    return json(request, env, {
      user,
      session_token: token,
    }, 200, {
      'Set-Cookie': sessionCookie(token, request),
    })
  } catch (error) {
    return errorResponse(request, env, error)
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url)

    if (isApiPath(url.pathname)) {
      if (request.method === 'OPTIONS') {
        return new Response(null, {
          status: 204,
          headers: apiCorsHeaders(request, env),
        })
      }

      const nativeLoginResponse = await handleNativeGoogleLogin(request, env, url.pathname)
      if (nativeLoginResponse) return withApiHeaders(request, env, nativeLoginResponse)

      const response = await app.fetch(request, env, ctx)
      return withApiHeaders(request, env, response)
    }

    return env.ASSETS.fetch(request)
  },

  async scheduled(event, env, ctx) {
    if (typeof app.scheduled === 'function') {
      return app.scheduled(event, env, ctx)
    }
  },
}
