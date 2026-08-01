import { useEffect, useMemo, useRef } from 'react'
import { useAuth } from '@/lib/AuthContext'
import { parseOutletIds } from '@/lib/outlets'
import { queryClientInstance } from '@/lib/query-client'
import { realtimeClientId, startRealtimeConnections } from '@/lib/realtime-client'

export default function RealtimeBridge() {
  const { user, isAuthenticated } = useAuth()
  const refreshTimer = useRef(null)
  const pendingEntities = useRef(new Set())
  const role = String(user?.role || '').toLowerCase()
  const outletIds = useMemo(() => {
    if (!isAuthenticated || !user) return []
    const values = parseOutletIds(user)
    if (user.outlet_id) values.unshift(String(user.outlet_id))
    const assigned = [...new Set(values.map(String).filter(Boolean))]
    if (role === 'owner' || role === 'manager') return ['global', ...assigned].slice(0, 5)
    return assigned.slice(0, 4)
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

        if (event.entity) pendingEntities.current.add(String(event.entity))
        window.clearTimeout(refreshTimer.current)
        refreshTimer.current = window.setTimeout(async () => {
          const entities = [...pendingEntities.current]
          pendingEntities.current.clear()
          await queryClientInstance.invalidateQueries({ refetchType: 'active' })
          window.dispatchEvent(new CustomEvent('chefops:realtime-applied', {
            detail: {
              entities,
              outlet_id: event.outlet_id || '',
              occurred_at: event.occurred_at || new Date().toISOString(),
            },
          }))
        }, 120)
      },
    })

    return () => {
      window.clearTimeout(refreshTimer.current)
      pendingEntities.current.clear()
      stop()
    }
  }, [isAuthenticated, outletIds])

  return null
}
