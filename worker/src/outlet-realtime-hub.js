import { DurableObject } from 'cloudflare:workers'

const MAX_RECENT_EVENTS = 24
const MAX_RECENT_BYTES = 256 * 1024
const MAX_PERSISTED_EVENT_BYTES = 24 * 1024

function now() {
  return new Date().toISOString()
}

function jsonBytes(value) {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength
  } catch {
    return Number.POSITIVE_INFINITY
  }
}

function persistedEvent(event) {
  if (jsonBytes(event) <= MAX_PERSISTED_EVENT_BYTES) return event
  return {
    id: String(event?.id || ''),
    type: String(event?.type || 'workspace.mutation'),
    entity: String(event?.entity || 'Workspace'),
    action: String(event?.action || 'updated'),
    path: String(event?.path || ''),
    method: String(event?.method || ''),
    occurred_at: String(event?.occurred_at || now()),
    outlet_id: String(event?.outlet_id || 'global'),
    origin_client_id: String(event?.origin_client_id || ''),
    actor: event?.actor ? {
      id: String(event.actor.id || ''),
      email: String(event.actor.email || ''),
      name: String(event.actor.name || ''),
      role: String(event.actor.role || ''),
    } : null,
    payload: { truncated: true },
    persisted_truncated: true,
  }
}

function boundedRecent(value, event) {
  const recent = Array.isArray(value) ? value.slice(-MAX_RECENT_EVENTS) : []
  recent.push(persistedEvent(event))
  while (
    recent.length > MAX_RECENT_EVENTS
    || (recent.length > 1 && jsonBytes(recent) > MAX_RECENT_BYTES)
  ) {
    recent.shift()
  }
  if (jsonBytes(recent) > MAX_RECENT_BYTES) return []
  return recent
}

export class OutletRealtimeHub extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env)
  }

  async fetch(request) {
    const url = new URL(request.url)
    if (url.pathname === '/broadcast' && request.method === 'POST') {
      if (request.headers.get('X-ChefOps-Realtime-Internal') !== '1') {
        return new Response('Forbidden', { status: 403 })
      }
      const event = await request.json()

      try {
        let stored = []
        try {
          stored = await this.ctx.storage.get('recent') || []
        } catch (error) {
          console.error('Unable to read realtime recent-event cache; resetting it', error)
          await this.ctx.storage.delete('recent').catch(() => {})
        }
        const recent = boundedRecent(stored, event)
        if (recent.length) await this.ctx.storage.put('recent', recent)
        else await this.ctx.storage.delete('recent').catch(() => {})
      } catch (error) {
        // Recent-event persistence is optional. Never block the mutation or live
        // websocket delivery because Durable Object SQLite reached a value limit.
        console.error('Realtime recent-event persistence skipped', error)
        await this.ctx.storage.delete('recent').catch(() => {})
      }

      const text = JSON.stringify(event)
      const sockets = this.ctx.getWebSockets()
      for (const socket of sockets) {
        try { socket.send(text) } catch {}
      }
      return Response.json({ ok: true, delivered: sockets.length })
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
    server.serializeAttachment(attachment)
    server.send(JSON.stringify({
      type: 'realtime.connected',
      occurred_at: now(),
      outlet_id: attachment.outlet_id,
    }))
    return new Response(null, { status: 101, webSocket: client })
  }

  async webSocketMessage(socket, message) {
    let input = null
    try {
      input = JSON.parse(typeof message === 'string' ? message : new TextDecoder().decode(message))
    } catch {}
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
