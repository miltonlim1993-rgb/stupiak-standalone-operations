import { useEffect, useMemo, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { Loader2, LockKeyhole } from 'lucide-react'
import { getRealtimeClientId } from '@/lib/client-id'

const LOCKED_PATHS = new Set([
  '/api/tasks/operational/action',
  '/api/stock-counts/batch',
])
const MAX_WAIT_MS = 95_000

function sleep(milliseconds) {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds))
}

function apiPath(input) {
  try {
    const raw = typeof input === 'string' || input instanceof URL ? String(input) : input?.url
    return new URL(raw, window.location.href).pathname
  } catch {
    return ''
  }
}

function dispatchLock(detail) {
  window.dispatchEvent(new CustomEvent('chefops:submission-lock', { detail }))
}

function lockDetail(data = {}, path = '') {
  const details = data.details || {}
  return {
    state: 'waiting',
    scope_key: details.scope_key || '',
    resource_type: details.resource_type || (path.includes('/stock-counts/') ? 'stock' : 'task'),
    resource_id: details.resource_id || '',
    resource_label: details.resource_label || (path.includes('/stock-counts/') ? '库存盘点' : '任务'),
    action: details.action || 'save',
    outlet_id: details.outlet_id || '',
    owner: {
      name: details.owner_name || '其他员工',
      email: details.owner_email || '',
    },
    acquired_at: details.acquired_at || '',
    expires_at: details.expires_at || '',
    retry_after_ms: Number(details.retry_after_ms || 900),
  }
}

function installLockAwareFetch() {
  const current = window.__chefopsSubmissionLockFetchPatch
  if (current) {
    current.refs += 1
    return () => {
      current.refs -= 1
      if (current.refs <= 0 && window.fetch === current.patched) {
        window.fetch = current.original
        delete window.__chefopsSubmissionLockFetchPatch
      }
    }
  }

  const original = window.fetch.bind(window)
  const clientId = getRealtimeClientId()
  const patched = async (input, init = {}) => {
    const path = apiPath(input)
    const method = String(init.method || input?.method || 'GET').toUpperCase()
    const reusableBody = typeof input === 'string' || input instanceof URL
    if (!LOCKED_PATHS.has(path) || method !== 'POST' || !reusableBody) {
      return original(input, init)
    }

    const headers = new Headers(init.headers || {})
    headers.set('X-ChefOps-Client-Id', clientId)
    const requestInit = { ...init, headers }
    const startedAt = Date.now()
    let waitingScope = ''

    while (Date.now() - startedAt < MAX_WAIT_MS) {
      const response = await original(input, requestInit)
      if (response.status !== 423) {
        if (waitingScope) dispatchLock({ state: 'released', scope_key: waitingScope })
        return response
      }

      const data = await response.clone().json().catch(() => ({}))
      if (data?.code !== 'submission_locked') {
        if (waitingScope) dispatchLock({ state: 'released', scope_key: waitingScope })
        return response
      }

      const detail = lockDetail(data, path)
      waitingScope = detail.scope_key || waitingScope
      dispatchLock(detail)
      await sleep(Math.max(500, Math.min(detail.retry_after_ms || 900, 2_000)))
    }

    if (waitingScope) dispatchLock({ state: 'released', scope_key: waitingScope })
    return original(input, requestInit)
  }

  window.__chefopsSubmissionLockFetchPatch = {
    refs: 1,
    original,
    patched,
  }
  window.fetch = patched

  return () => {
    const state = window.__chefopsSubmissionLockFetchPatch
    if (!state) return
    state.refs -= 1
    if (state.refs <= 0 && window.fetch === state.patched) {
      window.fetch = state.original
      delete window.__chefopsSubmissionLockFetchPatch
    }
  }
}

function relevantForPath(lock, pathname) {
  const type = String(lock?.resource_type || '').toLowerCase()
  if (type === 'task') return pathname.startsWith('/tasks')
  if (type === 'stock') return pathname.startsWith('/stock')
  return false
}

export default function SubmissionLockOverlay() {
  const location = useLocation()
  const [locks, setLocks] = useState(() => new Map())

  useEffect(() => installLockAwareFetch(), [])

  useEffect(() => {
    const put = (detail) => {
      const scopeKey = String(detail?.scope_key || '')
      if (!scopeKey) return
      setLocks((current) => {
        const next = new Map(current)
        next.set(scopeKey, detail)
        return next
      })
    }
    const remove = (scopeKey) => {
      if (!scopeKey) return
      setLocks((current) => {
        if (!current.has(scopeKey)) return current
        const next = new Map(current)
        next.delete(scopeKey)
        return next
      })
    }

    const onLocalLock = (event) => {
      const detail = event?.detail || {}
      if (detail.state === 'released') remove(String(detail.scope_key || ''))
      else put(detail)
    }
    const onRealtime = (event) => {
      const detail = event?.detail || {}
      if (detail.type === 'submission_lock.acquired') put(detail)
      if (detail.type === 'submission_lock.released') remove(String(detail.scope_key || ''))
    }

    window.addEventListener('chefops:submission-lock', onLocalLock)
    window.addEventListener('chefops:realtime', onRealtime)
    return () => {
      window.removeEventListener('chefops:submission-lock', onLocalLock)
      window.removeEventListener('chefops:realtime', onRealtime)
    }
  }, [])

  useEffect(() => {
    const timers = []
    for (const [scopeKey, lock] of locks.entries()) {
      const expiresAt = Date.parse(String(lock?.expires_at || ''))
      if (!Number.isFinite(expiresAt)) continue
      const delay = Math.max(0, expiresAt - Date.now() + 1_000)
      timers.push(window.setTimeout(() => {
        setLocks((current) => {
          if (!current.has(scopeKey)) return current
          const next = new Map(current)
          next.delete(scopeKey)
          return next
        })
      }, delay))
    }
    return () => timers.forEach((timer) => window.clearTimeout(timer))
  }, [locks])

  const activeLock = useMemo(() => (
    [...locks.values()].find((lock) => relevantForPath(lock, location.pathname)) || null
  ), [location.pathname, locks])

  const ownerName = activeLock?.owner?.name || activeLock?.owner_name || '其他员工'
  const stock = String(activeLock?.resource_type || '').toLowerCase() === 'stock'
  const actionText = activeLock?.action === 'complete' ? '完成任务' : '保存'

  return (
    <>
      <style>{`
        button.w-full.rounded-2xl.border.bg-card.p-4.text-left.shadow-sm > div.flex.gap-3 > span.rounded-full.bg-muted {
          align-self: flex-start;
          flex: 0 0 auto;
          min-width: max-content;
          white-space: nowrap;
        }
      `}</style>
      {activeLock ? (
        <div className="fixed inset-0 z-[10000] flex items-center justify-center bg-background/70 p-5 backdrop-blur-[2px]" role="status" aria-live="assertive">
          <div className="w-full max-w-sm rounded-3xl border bg-card p-6 text-center shadow-2xl">
            <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/15 text-primary">
              <LockKeyhole className="h-7 w-7" />
            </div>
            <h2 className="mt-4 text-lg font-bold">{stock ? '库存盘点正在提交' : `任务正在${actionText}`}</h2>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">
              {ownerName} 正在保存同一份资料。为避免重复或互相覆盖，此页面已暂时锁定。
            </p>
            <div className="mt-5 flex items-center justify-center gap-2 rounded-2xl bg-muted px-4 py-3 text-sm font-semibold">
              <Loader2 className="h-4 w-4 animate-spin" />
              对方完成后会自动解锁并继续
            </div>
          </div>
        </div>
      ) : null}
    </>
  )
}
