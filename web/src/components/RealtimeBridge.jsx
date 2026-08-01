import { useEffect, useMemo, useRef } from 'react'
import { useAuth } from '@/lib/AuthContext'
import { parseOutletIds } from '@/lib/outlets'
import { realtimeClientId, startRealtimeConnections } from '@/lib/realtime-client'

function isEditing() {
  const element = document.activeElement
  if (!element) return false
  const tag = String(element.tagName || '').toLowerCase()
  return tag === 'input' || tag === 'textarea' || tag === 'select' || element.isContentEditable
}

export default function RealtimeBridge() {
  const { user, isAuthenticated } = useAuth()
  const reloadTimer = useRef(null)
  const role = String(user?.role || '').toLowerCase()
  const outletIds = useMemo(() => {
    if (!isAuthenticated || !user) return []
    if (role === 'owner' || role === 'manager') return ['global']
    const values = parseOutletIds(user)
    if (user.outlet_id) values.unshift(String(user.outlet_id))
    return [...new Set(values.map(String).filter(Boolean))].slice(0, 4)
  }, [isAuthenticated, role, user])

  useEffect(() => {
    if (!isAuthenticated || !outletIds.length) return undefined
    const clientId = realtimeClientId()
    const stop = startRealtimeConnections({
      outletIds,
      onState: (state) => {
        window.__chefopsRealtime = {
          ...(window.__chefopsRealtime || {}),
          [state.outlet_id]: state,
        }
        window.dispatchEvent(new CustomEvent('chefops:realtime-state', { detail: state }))
      },
      onEvent: (event) => {
        if (!event || event.origin_client_id === clientId) return
        const domEvent = new CustomEvent('chefops:realtime', {
          detail: event,
          cancelable: true,
        })
        const accepted = window.dispatchEvent(domEvent)
        if (!accepted || domEvent.defaultPrevented) return

        // Until every legacy page has its own granular state reducer, reload
        // the current route so the second device immediately sees the saved
        // result. Do not interrupt someone who is actively typing.
        if (document.visibilityState !== 'visible' || window.location.pathname === '/login') return
        if (isEditing()) {
          window.dispatchEvent(new CustomEvent('chefops:realtime-pending', { detail: event }))
          return
        }
        window.clearTimeout(reloadTimer.current)
        reloadTimer.current = window.setTimeout(() => window.location.reload(), 350)
      },
    })

    return () => {
      window.clearTimeout(reloadTimer.current)
      stop()
    }
  }, [isAuthenticated, outletIds])

  return null
}
