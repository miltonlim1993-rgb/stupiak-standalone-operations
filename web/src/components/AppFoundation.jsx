import { useEffect, useRef } from 'react'
import { opsClient } from '@/api/opsClient'
import { useAuth } from '@/lib/AuthContext'
import { getDeviceId, platformName, showSystemNotification } from '@/lib/app-device'
import { hasUsableAppPack, syncAppPack } from '@/lib/app-pack'

const VERSION = '4.5.1-task-issue-media-drafts-rules-routes'
const BOOTSTRAP_KEY = 'chefops.v4.bootstrap.public'

function currentYear() { return new Date().getFullYear() }

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
    let packTimer = null
    const outletId = String(user.outlet_id || '').trim()
    localStorage.setItem('chefops.data-pack.outlet', outletId)

    const updatePack = async (force = false) => {
      try {
        const manifest = await syncAppPack({ outletId, force })
        if (cancelled) return null
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
        for (const row of fresh) {
          try {
            const metadata = JSON.parse(row.metadata_json || '{}')
            if (Array.isArray(metadata.invalidate) && metadata.invalidate.length) {
              navigator.serviceWorker?.controller?.postMessage({ type: 'CLEAR_DATA_CACHE' })
              shouldRefreshPack = true
            }
            if (metadata.data_pack_update || metadata.data_pack_version) shouldRefreshPack = true
          } catch {}
        }
        if (shouldRefreshPack) await updatePack(true)
        for (const row of fresh.slice(0, 3)) await showSystemNotification(row)
        ;(rows || []).forEach((row) => seen.add(row.id))
        localStorage.setItem(seenKey, JSON.stringify([...seen].slice(-500)))
        window.dispatchEvent(new CustomEvent('chefops:notifications', { detail: rows || [] }))
      } catch {}
    }

    const boot = async () => {
      if (!hasUsableAppPack(outletId)) return
      const manifest = await updatePack(false)
      let payload = null
      try {
        payload = await opsClient.app.bootstrap({ year: currentYear() })
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

    const onPackReady = () => boot()
    if (hasUsableAppPack(outletId)) boot()
    window.addEventListener('chefops:data-pack-updated', onPackReady)
    navigator.storage?.persist?.().catch(() => undefined)
    notificationTimer = window.setInterval(() => { if (hasUsableAppPack(outletId)) publishNotifications() }, 120_000)
    packTimer = window.setInterval(() => { if (hasUsableAppPack(outletId)) updatePack(false) }, 15 * 60_000)
    return () => {
      cancelled = true
      window.removeEventListener('chefops:data-pack-updated', onPackReady)
      if (notificationTimer) window.clearInterval(notificationTimer)
      if (packTimer) window.clearInterval(packTimer)
    }
  }, [user])

  return null
}

export function cachedBootstrap() {
  try { return JSON.parse(localStorage.getItem(BOOTSTRAP_KEY) || 'null') } catch { return null }
}
