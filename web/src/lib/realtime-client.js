import { getRealtimeClientId } from '@/lib/client-id'

const configuredApiUrl = String(import.meta.env.VITE_API_BASE_URL || '').trim()
const API_BASE_URL = (configuredApiUrl || (import.meta.env.DEV ? 'http://localhost:8787' : window.location.origin)).replace(/\/$/, '')
const CLIENT_ID = getRealtimeClientId()

function websocketBase() {
  const url = new URL(API_BASE_URL, window.location.href)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  return url.origin
}

async function issueTicket(outletId) {
  const response = await fetch(`${API_BASE_URL}/api/realtime/ticket`, {
    method: 'POST',
    credentials: 'include',
    cache: 'no-store',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ outlet_id: outletId }),
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok || !data.ticket) {
    throw new Error(data.error || data.message || `Realtime ticket failed (${response.status})`)
  }
  return data.ticket
}

function uniqueOutlets(values = []) {
  return [...new Set(values.map((value) => String(value || '').trim()).filter(Boolean))]
}

export function startRealtimeConnections({ outletIds = [], onEvent, onState } = {}) {
  const targets = uniqueOutlets(outletIds)
  const controllers = new Map()
  let stopped = false

  const emitState = (outletId, state, detail = {}) => {
    onState?.({ outlet_id: outletId, state, ...detail })
  }

  const connect = async (outletId, attempt = 0) => {
    if (stopped) return
    const controller = controllers.get(outletId) || { socket: null, timer: null, ping: null, attempt: 0 }
    controllers.set(outletId, controller)
    controller.attempt = attempt
    clearTimeout(controller.timer)
    clearInterval(controller.ping)

    try {
      emitState(outletId, attempt ? 'reconnecting' : 'connecting', { attempt })
      const ticket = await issueTicket(outletId)
      if (stopped) return
      const params = new URLSearchParams({
        ticket,
        outlet_id: outletId,
        client_id: CLIENT_ID,
      })
      const socket = new WebSocket(`${websocketBase()}/api/realtime/connect?${params}`)
      controller.socket = socket

      socket.addEventListener('open', () => {
        controller.attempt = 0
        emitState(outletId, 'connected')
        controller.ping = window.setInterval(() => {
          if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'ping' }))
        }, 25_000)
      })

      socket.addEventListener('message', (message) => {
        let event = null
        try { event = JSON.parse(String(message.data || '')) } catch {}
        if (!event || event.type === 'pong' || event.type === 'realtime.connected') return
        onEvent?.(event)
      })

      const reconnect = () => {
        clearInterval(controller.ping)
        if (stopped || controller.socket !== socket) return
        emitState(outletId, 'disconnected')
        const nextAttempt = Math.min(controller.attempt + 1, 8)
        const delay = Math.min(30_000, 1_000 * (2 ** nextAttempt)) + Math.floor(Math.random() * 750)
        controller.timer = window.setTimeout(() => connect(outletId, nextAttempt), delay)
      }
      socket.addEventListener('close', reconnect)
      socket.addEventListener('error', () => {
        try { socket.close() } catch {}
      })
    } catch (error) {
      emitState(outletId, 'error', { error: error.message || String(error) })
      const nextAttempt = Math.min(attempt + 1, 8)
      const delay = Math.min(30_000, 1_000 * (2 ** nextAttempt)) + Math.floor(Math.random() * 750)
      controller.timer = window.setTimeout(() => connect(outletId, nextAttempt), delay)
    }
  }

  targets.forEach((outletId) => connect(outletId))

  return () => {
    stopped = true
    for (const controller of controllers.values()) {
      clearTimeout(controller.timer)
      clearInterval(controller.ping)
      try { controller.socket?.close(1000, 'Client stopped') } catch {}
    }
    controllers.clear()
  }
}

export function realtimeClientId() {
  return CLIENT_ID
}
