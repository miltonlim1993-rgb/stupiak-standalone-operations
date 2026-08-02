import { useEffect, useRef, useState } from 'react'
import OperationalTasksV2 from '@/pages/OperationalTasksV2'

const TASK_ENTITIES = new Set(['Task', 'TaskPhoto'])

function eventTouchesTasks(detail = {}) {
  const entities = Array.isArray(detail.entities)
    ? detail.entities
    : [detail.entity]
  return entities.some((entity) => TASK_ENTITIES.has(String(entity || '')))
}

export default function OperationalTasksLive() {
  const [revision, setRevision] = useState(0)
  const refreshTimer = useRef(null)
  const lastRefreshAt = useRef(0)

  useEffect(() => {
    const refresh = (delay = 80) => {
      window.clearTimeout(refreshTimer.current)
      refreshTimer.current = window.setTimeout(() => {
        lastRefreshAt.current = Date.now()
        setRevision((value) => value + 1)
      }, delay)
    }

    const onRealtime = (event) => {
      if (!eventTouchesTasks(event.detail || {})) return
      refresh(80)
    }

    const onActive = () => {
      if (document.visibilityState !== 'visible') return
      if (Date.now() - lastRefreshAt.current < 1000) return
      refresh(0)
    }

    window.addEventListener('chefops:realtime', onRealtime)
    window.addEventListener('chefops:realtime-applied', onRealtime)
    window.addEventListener('pageshow', onActive)
    window.addEventListener('focus', onActive)
    window.addEventListener('online', onActive)
    document.addEventListener('visibilitychange', onActive)

    return () => {
      window.clearTimeout(refreshTimer.current)
      window.removeEventListener('chefops:realtime', onRealtime)
      window.removeEventListener('chefops:realtime-applied', onRealtime)
      window.removeEventListener('pageshow', onActive)
      window.removeEventListener('focus', onActive)
      window.removeEventListener('online', onActive)
      document.removeEventListener('visibilitychange', onActive)
    }
  }, [])

  return <OperationalTasksV2 key={revision} />
}
