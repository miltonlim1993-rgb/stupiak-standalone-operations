import app, { OutletRealtimeHub } from './entry-local-auth.js'
import { json } from './http.js'

const STAGING_BLOCKS = [
  { method: 'POST', pattern: /^\/api\/close-up\/[^/]+\/sync$/ },
  { method: 'POST', pattern: /^\/api\/realtime\/data\/sync\/retry$/ },
  { method: '*', pattern: /^\/api\/integrations\/statvara(?:\/|$)/ },
  { method: 'POST', pattern: /^\/api\/internal\/data-pack\/dirty$/ },
]

function isBlockedExternalSideEffect(request, url) {
  const method = String(request.method || 'GET').toUpperCase()
  return STAGING_BLOCKS.some((rule) => (
    (rule.method === '*' || rule.method === method) && rule.pattern.test(url.pathname)
  ))
}

function withStagingHeaders(response) {
  if (!response || response.status === 101) return response
  const headers = new Headers(response.headers)
  headers.set('X-Stupiak-Environment', 'staging')
  headers.set('X-Stupiak-Production-Data', 'false')
  headers.set('Cache-Control', headers.get('Cache-Control') || 'no-store')
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

export default {
  ...app,

  async fetch(request, env, ctx) {
    const url = new URL(request.url)

    if (url.pathname === '/api/staging/info' && request.method === 'GET') {
      return withStagingHeaders(json(request, env, {
        ok: true,
        environment: 'staging',
        production: false,
        synthetic_test_data: true,
        external_side_effects: false,
        google_sheet_runtime: false,
        statvara_sync: false,
        worker: 'stupiaks-ops-staging',
      }))
    }

    if (isBlockedExternalSideEffect(request, url)) {
      return withStagingHeaders(json(request, env, {
        ok: false,
        error: 'External side effects are disabled in the staging OPS environment.',
        code: 'staging_external_side_effect_disabled',
        environment: 'staging',
      }, 409))
    }

    return withStagingHeaders(await app.fetch(request, env, ctx))
  },
}

export { OutletRealtimeHub }
