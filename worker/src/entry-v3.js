import app from './entry.js'
import { errorResponse } from './http.js'
import { handleLabelFifoV26 } from './label-fifo-v26.js'
import { handleNoDeletePolicyV27 } from './no-delete-policy-v27.js'
import { handleTaskWorkflowV5 } from './task-workflow-v5.js'

const WORKER_REVISION = 'compact-training-hub-v29-v4.6.28'
const SHELL_REVISION = '4.6.28-compact-training-hub-v29'

function apiHeaders(request, response) {
  const headers = new Headers(response.headers)
  const origin = String(request.headers.get('Origin') || '')
  const allowed = new Set([
    'https://stupiaks-ops.sporkburger19.workers.dev',
    'https://localhost',
    'capacitor://localhost',
    'http://localhost:5188',
  ])
  headers.set('Access-Control-Allow-Origin', allowed.has(origin) ? origin : 'https://stupiaks-ops.sporkburger19.workers.dev')
  headers.set('Access-Control-Allow-Credentials', 'true')
  headers.set('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-ChefOps-Native, X-Requested-With')
  headers.set('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS')
  headers.set('Access-Control-Expose-Headers', 'X-ChefOps-Worker-Revision')
  headers.set('Vary', 'Origin')
  headers.set('X-ChefOps-Worker-Revision', WORKER_REVISION)
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

function withShellHeaders(request, url, response) {
  const headers = new Headers(response.headers)
  headers.set('X-ChefOps-Worker-Revision', WORKER_REVISION)
  headers.set('X-ChefOps-Shell-Revision', SHELL_REVISION)
  headers.set('Permissions-Policy', 'local-network=(self), loopback-network=(self)')

  const isNavigation = request.mode === 'navigate'
    || request.headers.get('Sec-Fetch-Mode') === 'navigate'
    || request.headers.get('Accept')?.includes('text/html')
  const isFreshnessResource = url.pathname === '/sw.js'
    || isNavigation
    || ['/labels', '/labels/settings', '/tasks', '/training', '/more'].includes(url.pathname)
    || url.pathname.startsWith('/sop/')
    || url.pathname.startsWith('/print-service/')

  if (isFreshnessResource) {
    headers.set('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
    headers.set('Pragma', 'no-cache')
    headers.set('Expires', '0')
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

export default {
  async fetch(request, env, context) {
    try {
      const url = new URL(request.url)

      if (request.method === 'OPTIONS' && url.pathname.startsWith('/api/')) {
        return apiHeaders(request, new Response(null, { status: 204 }))
      }

      const deleteResponse = handleNoDeletePolicyV27(request)
      if (deleteResponse) return apiHeaders(request, deleteResponse)

      if (url.pathname.startsWith('/api/labels/')) {
        const labelResponse = await handleLabelFifoV26(request, env, url)
        if (labelResponse) return apiHeaders(request, labelResponse)
      }
      if (url.pathname.startsWith('/api/tasks/')) {
        const taskResponse = await handleTaskWorkflowV5(request, env, url, context, app)
        if (taskResponse) return apiHeaders(request, taskResponse)
      }
      const response = await app.fetch(request, env, context)
      return withShellHeaders(request, url, response)
    } catch (error) {
      return apiHeaders(request, errorResponse(request, env, error))
    }
  },
}
