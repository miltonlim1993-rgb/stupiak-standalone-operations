import app from './entry.js'
import { errorResponse } from './http.js'
import { handleTaskWorkflowV5 } from './task-workflow-v5.js'

const WORKER_REVISION = 'windows-queue-direct-ip-v23-v4.6.21'
const SHELL_REVISION = '4.6.21-windows-queue-direct-ip-v23'

function taskApiHeaders(request, response) {
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
  headers.set('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS')
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
    || ['/labels', '/labels/settings', '/more'].includes(url.pathname)

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
      if (url.pathname.startsWith('/api/tasks/')) {
        const taskResponse = await handleTaskWorkflowV5(request, env)
        if (taskResponse) return taskApiHeaders(request, taskResponse)
      }
      const response = await app.fetch(request, env, context)
      return withShellHeaders(request, url, response)
    } catch (error) {
      return errorResponse(error)
    }
  },
}
