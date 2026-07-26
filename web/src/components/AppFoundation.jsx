import { useEffect, useRef } from 'react'
import { opsClient } from '@/api/opsClient'
import { useAuth } from '@/lib/AuthContext'
import { getDeviceId, platformName, showSystemNotification } from '@/lib/app-device'
import { hasUsableAppPack, syncAppPack } from '@/lib/app-pack'
import { queryClientInstance } from '@/lib/query-client'

const VERSION = '4.5.1-direct-print-flow-v10'
const BOOTSTRAP_KEY = 'chefops.v4.bootstrap.public'
const LAST_PACK_CHECK_KEY = 'chefops.data-pack.last-background-check'
const PACK_RECHECK_MS = 30 * 60_000
const NOTIFICATION_CHECK_MS = 120_000

function currentYear() { return new Date().getFullYear() }

function editingSurfaceOpen() {
  const active = document.activeElement
  const tag = String(active?.tagName || '').toUpperCase()
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(tag) || active?.isContentEditable) return true

  return Boolean(document.querySelector([
    '[role="dialog"]',
    '.chefops-mobile-sheet',
    '.chefops-drawer-overlay',
    '[data-chefops-editing="true"]',
  ].join(', ')))
}

export default function AppFoundation() {
  const { user } = useAuth()
  const startedFor = useRef('')

  useEffect(() => {
    if (!user) return undefined
    const userKey = String(user.id || user.email || '')
    if (startedFor.current === userKey) return undefined
    startedFor.current = userKey

    let cancelled = false
    let notificationTimer = null
    const outletId = String(user.outlet_id || '').trim()
    localStorage.setItem('chefops.data-pack.outlet', outletId)

    const markQueriesStaleWithoutRefresh = () => {
      queryClientInstance.invalidateQueries({ refetchType: 'none' }).catch(() => undefined)
    }

    const updatePack = async ({ ignoreAge = false, allowWhileEditing = false } = {}) => {
      if (!hasUsableAppPack(outletId)) return null
      if (!allowWhileEditing && editingSurfaceOpen()) {
        localStorage.setItem('chefops.data-pack.pending-background-check', '1')
        return null
      }

      const lastCheckedAt = Number(localStorage.getItem(LAST_PACK_CHECK_KEY) || 0)
      if (!ignoreAge && Date.now() - lastCheckedAt < PACK_RECHECK_MS) return null

      try {
        const manifest = await syncAppPack({ outletId, force: false })
        if (cancelled) return null
        localStorage.setItem(LAST_PACK_CHECK_KEY, String(Date.now()))
        localStorage.removeItem('chefops.data-pack.pending-background-check')
        localStorage.setItem('chefops.data.version', manifest.data_version || manifest.version || VERSION)
        return manifest
      } catch (error) {
        console.warn('ChefOps data patch is using the last downloaded version', error)
        return null
      }
    }

    const publishNotifications = async () => {
      try {
        const rows = await opsClient.notifications.list({ unreadOnly: true, limit: 50 })
        if (cancelled) return
        window.__chefopsNotifications = rows || []

        const seenKey = `chefops.notifications.seen.${userKey}`
        const seen = new Set(JSON.parse(localStorage.getItem(seenKey) || '[]'))
        const fresh = (rows || []).filter((row) => !seen.has(row.id))
        let shouldRefreshPack = false
        let shouldInvalidateData = false

        for (const row of fresh) {
          try {
            const metadata = JSON.parse(row.metadata_json || '{}')
            if (Array.isArray(metadata.invalidate) && metadata.invalidate.length) {
              navigator.serviceWorker?.controller?.postMessage({ type: 'CLEAR_DATA_CACHE' })
              shouldInvalidateData = true
              shouldRefreshPack = true
            }
            if (metadata.data_pack_update || metadata.data_pack_version) shouldRefreshPack = true
          } catch {}
        }

        // Mark cached queries stale, but never refetch an active page while a user is working.
        if (shouldInvalidateData) markQueriesStaleWithoutRefresh()
        if (shouldRefreshPack) await updatePack({ ignoreAge: true })

        for (const row of fresh.slice(0, 3)) await showSystemNotification(row)
        ;(rows || []).forEach((row) => seen.add(row.id))
        localStorage.setItem(seenKey, JSON.stringify([...seen].slice(-500)))
        window.dispatchEvent(new CustomEvent('chefops:notifications', { detail: rows || [] }))
      } catch {}
    }

    const boot = async () => {
      if (!hasUsableAppPack(outletId)) return
      const manifest = await updatePack({ ignoreAge: true, allowWhileEditing: true })

      try {
        const payload = await opsClient.app.bootstrap({ year: currentYear() })
        if (cancelled) return
        localStorage.setItem(BOOTSTRAP_KEY, JSON.stringify({
          app_version: payload.app_version,
          data_version: payload.data_version,
          data_pack_version: payload.data_pack?.version || manifest?.version || '',
          payment_methods: payload.payment_methods || [],
          settings: payload.settings || {},
          notification_mode: payload.notification_mode,
          cached_at: new Date().toISOString(),
        }))
        window.dispatchEvent(new CustomEvent('chefops:bootstrap', { detail: payload }))
      } catch (error) {
        console.warn('ChefOps bootstrap is using the downloaded data patch', error)
      }

      await publishNotifications()

      const deviceStampKey = `chefops.device.registered.${userKey}`
      const lastRegistered = Number(localStorage.getItem(deviceStampKey) || 0)
      if (Date.now() - lastRegistered > 12 * 60 * 60_000) {
        try {
          await opsClient.app.registerDevice({
            device_id: getDeviceId(),
            platform: platformName(),
            app_version: VERSION,
            notification_permission: 'Notification' in window ? Notification.permission : 'unsupported',
          })
          localStorage.setItem(deviceStampKey, String(Date.now()))
        } catch (error) {
          console.warn('Unable to register this device', error)
        }
      }
    }

    const resume = () => {
      if (document.visibilityState === 'hidden') return
      publishNotifications()
      updatePack()
    }

    const onPackReady = (event) => {
      const manifest = event?.detail?.manifest
      if (manifest) {
        localStorage.setItem('chefops.data.version', manifest.data_version || manifest.version || VERSION)
      }
      // The current screen remains untouched. New configuration is used on the
      // next page entry or explicit refresh instead of remounting active forms.
      markQueriesStaleWithoutRefresh()
      window.dispatchEvent(new CustomEvent('chefops:configuration-ready', { detail: event?.detail || null }))
    }

    const onVisible = () => {
      if (document.visibilityState === 'visible') resume()
    }

    if (hasUsableAppPack(outletId)) boot()
    window.addEventListener('chefops:data-pack-updated', onPackReady)
    window.addEventListener('online', resume)
    document.addEventListener('visibilitychange', onVisible)
    navigator.storage?.persist?.().catch(() => undefined)

    notificationTimer = window.setInterval(() => {
      if (hasUsableAppPack(outletId) && document.visibilityState !== 'hidden') publishNotifications()
    }, NOTIFICATION_CHECK_MS)

    return () => {
      cancelled = true
      window.removeEventListener('chefops:data-pack-updated', onPackReady)
      window.removeEventListener('online', resume)
      document.removeEventListener('visibilitychange', onVisible)
      if (notificationTimer) window.clearInterval(notificationTimer)
    }
  }, [user])

  return null
}

export function cachedBootstrap() {
  try { return JSON.parse(localStorage.getItem(BOOTSTRAP_KEY) || 'null') } catch { return null }
}
