import { DurableObject } from 'cloudflare:workers'

const MAX_RECENT_EVENTS = 120

function now() {
  return new Date().toISOString()
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
      const recent = await this.ctx.storage.get('recent') || []
      recent.push(event)
      if (recent.length > MAX_RECENT_EVENTS) recent.splice(0, recent.length - MAX_RECENT_EVENTS)
      await this.ctx.storage.put('recent', recent)

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
