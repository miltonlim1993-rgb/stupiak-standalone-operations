import { getCurrentUser, sessionPayload } from './auth.js'
import { errorResponse, json, readJson } from './http.js'
import { assignedOutletIds, assertOutletAccess } from './permissions.js'

const TICKET_TTL_SECONDS = 90
const MAX_EVENT_BYTES = 192 * 1024
const MAX_RECENT_EVENTS = 120
const MUTATING_METHODS = new Set(['POST', 'PATCH', 'PUT', 'DELETE'])

function now() {
  return new Date().toISOString()
}

function outletKey(value = '') {
  return String(value || '').trim() || 'global'
}

function ticketKey(value) {
  return `realtime:ticket:${String(value || '').trim()}`
}

function allowedOutlets(user) {
  const values = new Set(assignedOutletIds(user).map(String).filter(Boolean))
  if (user?.outlet_id) values.add(String(user.outlet_id))
  if (['owner', 'manager'].includes(String(user?.role || '').toLowerCase())) values.add('global')
  return [...values]
}

function compactPayload(payload) {
  try {
    const text = JSON.stringify(payload ?? null)
    if (text.length <= MAX_EVENT_BYTES) return payload
    return {
      truncated: true,
      summary: typeof payload === 'object' && payload
        ? Object.fromEntries(Object.entries(payload).filter(([key]) => ['id', 'outlet_id', 'status', 'entity', 'task', 'record'].includes(key)))
        : String(payload).slice(0, 500),
    }
  } catch {
    return { truncated: true }
  }
}

function entityFromPath(pathname) {
  const generic = pathname.match(/^\/api\/entities\/([^/]+)/)
  if (generic) return decodeURIComponent(generic[1])
  if (pathname.startsWith('/api/tasks/')) return 'Task'
  if (pathname.startsWith('/api/stock-counts/')) return 'StockCount'
  if (pathname.startsWith('/api/close-up/')) return 'CloseUp'
  if (pathname.startsWith('/api/labels/')) return 'FoodLabel'
  if (pathname.startsWith('/api/notifications')) return 'Notification'
  if (pathname.startsWith('/api/attendance/')) return 'Attendance'
  if (pathname.startsWith('/api/users/')) return 'User'
  if (pathname.startsWith('/api/inventory/')) return 'OutletStockList'
  if (pathname.startsWith('/api/files/upload')) return 'DriveFile'
  return 'Workspace'
}

function actionFromRequest(request, pathname) {
  if (request.method === 'DELETE') return 'deleted'
  if (/\/read$/.test(pathname)) return 'read'
  if (/\/reprint$/.test(pathname)) return 'reprinted'
  if (/\/finish$/.test(pathname)) return 'finished'
  if (/\/access$/.test(pathname)) return 'access_updated'
  if (/\/import$/.test(pathname)) return 'imported'
  if (/\/batch$/.test(pathname)) return 'batch_saved'
  if (/\/upsert$/.test(pathname)) return 'upserted'
  if (/\/action$/.test(pathname)) return 'updated'
  if (request.method === 'POST') return 'created'
  return 'updated'
}

function shouldBroadcast(request, pathname, response) {
  if (!MUTATING_METHODS.has(request.method)) return false
  if (!response || response.status < 200 || response.status >= 300) return false
  if (pathname.startsWith('/api/realtime/')) return false
  if (pathname.startsWith('/api/auth/')) return false
  if (pathname.startsWith('/api/app/v4/pack/')) return false
  if (pathname === '/api/internal/data-pack/dirty') return false
  return true
}

function collectOutletIds(value, result = new Set(), depth = 0) {
  if (depth > 5 || value == null) return result
  if (Array.isArray(value)) {
    value.slice(0, 200).forEach((item) => collectOutletIds(item, result, depth + 1))
    return result
  }
  if (typeof value !== 'object') return result
  for (const [key, nested] of Object.entries(value)) {
    if ((key === 'outlet_id' || key === 'outletId') && nested) result.add(String(nested))
    else if (depth < 5 && nested && typeof nested === 'object') collectOutletIds(nested, result, depth + 1)
  }
  return result
}

async function parseResponsePayload(response) {
  const type = String(response.headers.get('content-type') || '')
  if (!type.includes('application/json')) return null
  try { return await response.clone().json() } catch { return null }
}

async function broadcastToOutlet(env, outletId, event) {
  if (!env.OUTLET_REALTIME?.getByName) return
  const stub = env.OUTLET_REALTIME.getByName(outletKey(outletId))
  await stub.fetch('https://chefops-realtime.internal/broadcast', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-ChefOps-Realtime-Internal': '1' },
    body: JSON.stringify(event),
  })
}

export async function publishMutationEvent(request, env, pathname, response) {
  if (!shouldBroadcast(request, pathname, response)) return
  const payload = await parseResponsePayload(response)
  let user = null
  try { user = await getCurrentUser(request, env, { optional: true }) } catch {}
  const outlets = collectOutletIds(payload)
  if (!outlets.size && user?.outlet_id) outlets.add(String(user.outlet_id))
  if (!outlets.size) outlets.add('global')

  const event = {
    id: crypto.randomUUID(),
    type: 'workspace.mutation',
    entity: entityFromPath(pathname),
    action: actionFromRequest(request, pathname),
    path: pathname,
    method: request.method,
    occurred_at: now(),
    actor: user ? {
      id: user.id || '',
      email: user.email || '',
      name: user.full_name || user.email || '',
      role: user.role || '',
    } : null,
    payload: compactPayload(payload),
  }

  const targets = new Set([...outlets].map(outletKey))
  targets.add('global')
  await Promise.all([...targets].map((outletId) => broadcastToOutlet(env, outletId, { ...event, outlet_id: outletId })))
}

async function issueTicket(request, env) {
  const user = await getCurrentUser(request, env)
  const body = await readJson(request).catch(() => ({}))
  const requested = Array.isArray(body.outlet_ids)
    ? body.outlet_ids.map(String).filter(Boolean)
    : [String(body.outlet_id || user.outlet_id || '').trim()].filter(Boolean)
  const permitted = allowedOutlets(user)
  const outlets = requested.length
    ? requested.filter((outletId) => outletId === 'global' || permitted.includes(outletId))
    : permitted
  if (!outlets.length) outlets.push('global')
  for (const outletId of outlets) {
    if (outletId !== 'global' && !['owner', 'manager'].includes(String(user.role || '').toLowerCase())) {
      assertOutletAccess(user, outletId)
    }
  }

  const ticket = crypto.randomUUID()
  const value = {
    ticket,
    user_id: user.id || '',
    user_email: user.email || '',
    user_name: user.full_name || user.email || '',
    role: user.role || '',
    outlets,
    expires_at: Date.now() + TICKET_TTL_SECONDS * 1000,
  }
  if (!env.APP_DATA_PACKS?.put) {
    const error = new Error('Realtime ticket storage is unavailable')
    error.status = 503
    error.code = 'realtime_ticket_unavailable'
    throw error
  }
  await env.APP_DATA_PACKS.put(ticketKey(ticket), JSON.stringify(value), { expirationTtl: TICKET_TTL_SECONDS })
  return json(request, env, { ticket, outlets, expires_in: TICKET_TTL_SECONDS })
}

async function readTicket(env, ticket) {
  if (!ticket || !env.APP_DATA_PACKS?.get) return null
  const key = ticketKey(ticket)
  const value = await env.APP_DATA_PACKS.get(key, 'json')
  if (!value || Number(value.expires_at || 0) < Date.now()) return null
  await env.APP_DATA_PACKS.delete(key).catch(() => {})
  return value
}

async function connect(request, env, url) {
  if (String(request.headers.get('Upgrade') || '').toLowerCase() !== 'websocket') {
    const error = new Error('WebSocket upgrade required')
    error.status = 426
    error.code = 'websocket_required'
    throw error
  }
  const ticket = await readTicket(env, url.searchParams.get('ticket'))
  const outletId = outletKey(url.searchParams.get('outlet_id'))
  if (!ticket || (!ticket.outlets.includes(outletId) && !ticket.outlets.includes('global'))) {
    const error = new Error('Realtime ticket is invalid or expired')
    error.status = 401
    error.code = 'realtime_ticket_invalid'
    throw error
  }
  if (!env.OUTLET_REALTIME?.getByName) {
    const error = new Error('Realtime binding is unavailable')
    error.status = 503
    error.code = 'realtime_binding_unavailable'
    throw error
  }
  const stub = env.OUTLET_REALTIME.getByName(outletId)
  const headers = new Headers(request.headers)
  headers.set('X-ChefOps-Realtime-User-Id', ticket.user_id)
  headers.set('X-ChefOps-Realtime-User-Email', ticket.user_email)
  headers.set('X-ChefOps-Realtime-User-Name', ticket.user_name)
  headers.set('X-ChefOps-Realtime-Role', ticket.role)
  headers.set('X-ChefOps-Realtime-Outlet', outletId)
  headers.set('X-ChefOps-Realtime-Client', String(url.searchParams.get('client_id') || ''))
  return stub.fetch(new Request(request, { headers }))
}

export async function handleRealtimeApi(request, env, url) {
  if (!url.pathname.startsWith('/api/realtime/')) return null
  try {
    if (url.pathname === '/api/realtime/ticket' && request.method === 'POST') return issueTicket(request, env)
    if (url.pathname === '/api/realtime/connect' && request.method === 'GET') return connect(request, env, url)
    if (url.pathname === '/api/realtime/status' && request.method === 'GET') {
      const user = await getCurrentUser(request, env)
      return json(request, env, {
        ok: true,
        transport: 'durable-object-websocket-hibernation',
        user_id: user.id || '',
        outlets: allowedOutlets(user),
        configured: Boolean(env.OUTLET_REALTIME?.getByName),
      })
    }
    const error = new Error('Realtime endpoint not found')
    error.status = 404
    error.code = 'realtime_not_found'
    throw error
  } catch (error) {
    return errorResponse(request, env, error)
  }
}

export class OutletRealtimeHub {
  constructor(ctx) {
    this.ctx = ctx
  }

  async fetch(request) {
    const url = new URL(request.url)
    if (url.pathname === '/broadcast' && request.method === 'POST') {
      if (request.headers.get('X-ChefOps-Realtime-Internal') !== '1') return new Response('Forbidden', { status: 403 })
      const event = await request.json()
      const recent = await this.ctx.storage.get('recent') || []
      recent.push(event)
      if (recent.length > MAX_RECENT_EVENTS) recent.splice(0, recent.length - MAX_RECENT_EVENTS)
      await this.ctx.storage.put('recent', recent)
      const text = JSON.stringify(event)
      for (const socket of this.ctx.getWebSockets()) {
        try { socket.send(text) } catch {}
      }
      return Response.json({ ok: true, delivered: this.ctx.getWebSockets().length })
    }

    if (String(request.headers.get('Upgrade') || '').toLowerCase() !== 'websocket') {
      return new Response('Expected WebSocket', { status: 426 })
    }

    const pair = new WebSocketPair()
    const [client, server] = Object.values(pair)
    this.ctx.acceptWebSocket(server)
    const attachment = {
      user_id: request.headers.get('X-ChefOps-Realtime-User-Id') || '',
      email: request.headers.get('X-ChefOps-Realtime-User-Email') || '',
      name: request.headers.get('X-ChefOps-Realtime-User-Name') || '',
      role: request.headers.get('X-ChefOps-Realtime-Role') || '',
      outlet_id: request.headers.get('X-ChefOps-Realtime-Outlet') || 'global',
      client_id: request.headers.get('X-ChefOps-Realtime-Client') || '',
      connected_at: now(),
    }
    try { server.serializeAttachment(attachment) } catch {}
    server.send(JSON.stringify({ type: 'realtime.connected', occurred_at: now(), outlet_id: attachment.outlet_id }))
    return new Response(null, { status: 101, webSocket: client })
  }

  async webSocketMessage(socket, message) {
    let input = null
    try { input = JSON.parse(typeof message === 'string' ? message : new TextDecoder().decode(message)) } catch {}
    if (input?.type === 'ping') {
      socket.send(JSON.stringify({ type: 'pong', occurred_at: now() }))
    }
  }

  async webSocketClose(socket, code, reason) {
    try { socket.close(code, reason) } catch {}
  }

  async webSocketError(socket) {
    try { socket.close(1011, 'Realtime socket error') } catch {}
  }
}
