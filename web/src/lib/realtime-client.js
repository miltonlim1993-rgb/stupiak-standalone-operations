import { getRealtimeClientId } from '@/lib/client-id'

const configuredApiUrl = String(import.meta.env.VITE_API_BASE_URL || '').trim()
const API_BASE_URL = (configuredApiUrl || (import.meta.env.DEV ? 'http://localhost:8787' : window.location.origin)).replace(/\/$/, '')
const CLIENT_ID = getRealtimeClientId()
const HEARTBEAT_TIMEOUT_MS = 75_000

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
    const controller = controllers.get(outletId) || {
      socket: null,
      timer: null,
      ping: null,
      attempt: 0,
      generation: 0,
      lastMessageAt: 0,
    }
    controllers.set(outletId, controller)
    controller.attempt = attempt
    controller.generation += 1
    const generation = controller.generation
    clearTimeout(controller.timer)
    clearInterval(controller.ping)
    controller.timer = null
    controller.ping = null

    try {
      emitState(outletId, attempt ? 'reconnecting' : 'connecting', { attempt })
      const ticket = await issueTicket(outletId)
      if (stopped || controller.generation !== generation) return
      const params = new URLSearchParams({
        ticket,
        outlet_id: outletId,
        client_id: CLIENT_ID,
      })
      const socket = new WebSocket(`${websocketBase()}/api/realtime/connect?${params}`)
      controller.socket = socket

      socket.addEventListener('open', () => {
        if (controller.socket !== socket || controller.generation !== generation) return
        controller.attempt = 0
        controller.lastMessageAt = Date.now()
        emitState(outletId, 'connected')
        controller.ping = window.setInterval(() => {
          if (controller.socket !== socket) return
          if (Date.now() - controller.lastMessageAt > HEARTBEAT_TIMEOUT_MS) {
            try { socket.close(4001, 'Heartbeat timeout') } catch {}
            return
          }
          if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'ping' }))
        }, 25_000)
      })

      socket.addEventListener('message', (message) => {
        if (controller.socket !== socket || controller.generation !== generation) return
        controller.lastMessageAt = Date.now()
        let event = null
        try { event = JSON.parse(String(message.data || '')) } catch {}
        if (!event || event.type === 'pong' || event.type === 'realtime.connected') return
        onEvent?.(event)
      })

      const reconnect = () => {
        clearInterval(controller.ping)
        controller.ping = null
        if (stopped || controller.socket !== socket || controller.generation !== generation) return
        controller.socket = null
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
      if (stopped || controller.generation !== generation) return
      controller.socket = null
      emitState(outletId, 'error', { error: error.message || String(error) })
      const nextAttempt = Math.min(attempt + 1, 8)
      const delay = Math.min(30_000, 1_000 * (2 ** nextAttempt)) + Math.floor(Math.random() * 750)
      controller.timer = window.setTimeout(() => connect(outletId, nextAttempt), delay)
    }
  }

  const ensureConnections = () => {
    if (stopped || !navigator.onLine || document.visibilityState === 'hidden') return
    targets.forEach((outletId) => {
      const controller = controllers.get(outletId)
      if (!controller) {
        void connect(outletId, 0)
        return
      }

      const socket = controller.socket
      if (socket?.readyState === WebSocket.CONNECTING) return
      if (socket?.readyState === WebSocket.OPEN) {
        if (Date.now() - controller.lastMessageAt <= HEARTBEAT_TIMEOUT_MS) return
        try { socket.close(4001, 'Heartbeat stale') } catch {}
        return
      }
      if (controller.timer) return
      void connect(outletId, 0)
    })
  }

  const onVisible = () => {
    if (document.visibilityState === 'visible') ensureConnections()
  }

  targets.forEach((outletId) => { void connect(outletId) })
  window.addEventListener('online', ensureConnections)
  window.addEventListener('pageshow', ensureConnections)
  window.addEventListener('focus', ensureConnections)
  document.addEventListener('visibilitychange', onVisible)

  return () => {
    stopped = true
    window.removeEventListener('online', ensureConnections)
    window.removeEventListener('pageshow', ensureConnections)
    window.removeEventListener('focus', ensureConnections)
    document.removeEventListener('visibilitychange', onVisible)
    for (const controller of controllers.values()) {
      controller.generation += 1
      clearTimeout(controller.timer)
      clearInterval(controller.ping)
      controller.timer = null
      controller.ping = null
      try { controller.socket?.close(1000, 'Client stopped') } catch {}
    }
    controllers.clear()
  }
}

export function realtimeClientId() {
  return CLIENT_ID
}
