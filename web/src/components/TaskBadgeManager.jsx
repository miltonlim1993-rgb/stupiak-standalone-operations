import { useEffect, useRef } from 'react'
import { useLocation } from 'react-router-dom'
import { useAuth } from '@/lib/AuthContext'
import { getPackedEntity } from '@/lib/app-pack'

const CHECK_MS = 2 * 60_000

function list(value) {
  if (Array.isArray(value)) return value.map(String).filter(Boolean)
  const text = String(value || '').trim()
  if (!text) return []
  try {
    const parsed = JSON.parse(text)
    if (Array.isArray(parsed)) return parsed.map(String).filter(Boolean)
  } catch {}
  return text.split(/[;,]/).map((item) => item.trim()).filter(Boolean)
}

function activeTemplate(row, user, outletId) {
  if (!row || row.deleted_at) return false
  const active = row.is_active === true || String(row.is_active || '').toLowerCase() === 'true'
  if (!active) return false

  const outlets = [...new Set([
    ...list(row.outlet_ids),
    ...list(row.outlet_id),
  ])]
  if (outlets.length && outletId && !outlets.includes(String(outletId))) return false

  const assignedUser = String(row.assigned_to_user_id || '').trim()
  if (assignedUser && assignedUser !== String(user?.id || '')) return false

  const assignedRole = String(row.assigned_to_role || '').trim().toLowerCase()
  if (assignedRole && !['all', 'any', 'everyone', '*'].includes(assignedRole) && assignedRole !== String(user?.role || '').toLowerCase()) return false
  return true
}

function key(prefix, userKey, outletId) {
  return `chefops.task-badge.${prefix}.${userKey}.${outletId || 'global'}`
}

function readArray(storageKey) {
  try {
    const value = JSON.parse(localStorage.getItem(storageKey) || '[]')
    return Array.isArray(value) ? value.map(String) : []
  } catch {
    return []
  }
}

function publish(ids) {
  const unique = [...new Set(ids.map(String).filter(Boolean))]
  window.__chefopsTaskBadgeCount = unique.length
  window.dispatchEvent(new CustomEvent('chefops:task-badge', {
    detail: { count: unique.length, ids: unique },
  }))
}

export default function TaskBadgeManager() {
  const { user } = useAuth()
  const location = useLocation()
  const running = useRef(false)

  useEffect(() => {
    if (!user) return undefined
    const userKey = String(user.id || user.email || 'user')
    const outletId = String(user.outlet_id || '').trim()
    const seenKey = key('seen', userKey, outletId)
    const unreadKey = key('unread', userKey, outletId)
    let cancelled = false

    const inspect = async ({ markSeen = false } = {}) => {
      if (running.current || cancelled) return
      running.current = true
      try {
        const rows = await getPackedEntity('TaskTemplate', {
          sort: 'display_order,name',
          limit: 5000,
          outletId,
        })
        if (cancelled || !Array.isArray(rows)) return
        const currentIds = rows.filter((row) => activeTemplate(row, user, outletId)).map((row) => String(row.id || '')).filter(Boolean)
        const current = new Set(currentIds)
        const hasBaseline = localStorage.getItem(seenKey) !== null

        if (markSeen || !hasBaseline) {
          localStorage.setItem(seenKey, JSON.stringify(currentIds))
          localStorage.setItem(unreadKey, '[]')
          publish([])
          return
        }

        const seen = new Set(readArray(seenKey))
        const existingUnread = readArray(unreadKey).filter((id) => current.has(id))
        const newlyPublished = currentIds.filter((id) => !seen.has(id))
        const unread = [...new Set([...existingUnread, ...newlyPublished])]
        localStorage.setItem(unreadKey, JSON.stringify(unread))
        publish(unread)
      } catch (error) {
        console.warn('Unable to inspect newly published tasks', error)
        publish(readArray(unreadKey))
      } finally {
        running.current = false
      }
    }

    const onPack = () => inspect({ markSeen: location.pathname.startsWith('/tasks') })
    const onVisible = () => {
      if (document.visibilityState === 'visible') inspect({ markSeen: location.pathname.startsWith('/tasks') })
    }

    inspect({ markSeen: location.pathname.startsWith('/tasks') })
    window.addEventListener('chefops:data-pack-updated', onPack)
    window.addEventListener('chefops:configuration-ready', onPack)
    window.addEventListener('online', onPack)
    document.addEventListener('visibilitychange', onVisible)
    const timer = window.setInterval(onPack, CHECK_MS)

    return () => {
      cancelled = true
      window.removeEventListener('chefops:data-pack-updated', onPack)
      window.removeEventListener('chefops:configuration-ready', onPack)
      window.removeEventListener('online', onPack)
      document.removeEventListener('visibilitychange', onVisible)
      window.clearInterval(timer)
    }
  }, [user, location.pathname])

  return null
}
