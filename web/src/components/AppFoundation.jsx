import { useEffect, useRef } from 'react'

import { opsClient } from '@/api/opsClient'
import { useAuth } from '@/lib/AuthContext'
import { getDeviceId, platformName, showSystemNotification } from '@/lib/app-device'
import {
  checkDataPackageV2Update,
  getDataPackageV2Module,
  getInstalledDataPackage,
} from '@/lib/data-package-v2-runtime'
import { queryClientInstance } from '@/lib/query-client'

const VERSION = '4.5.1-data-package-v2'
const BOOTSTRAP_KEY = 'chefops.v4.bootstrap.public'
const NOTIFICATION_CHECK_MS = 120_000

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

    const publishLocalBootstrap = async () => {
      const installed = await getInstalledDataPackage(outletId)
      if (!installed?.manifest?.version || cancelled) return null
      const core = await getDataPackageV2Module('core', outletId) || {}
      const payload = {
        app_version: VERSION,
        data_version: installed.manifest.data_version || installed.manifest.version,
        data_pack_version: installed.manifest.version,
        payment_methods: core.payment_methods || [],
        settings: core.settings || {},
        notification_mode: 'in-app-and-local-system',
        cached_at: new Date().toISOString(),
      }
      localStorage.setItem(BOOTSTRAP_KEY, JSON.stringify(payload))
      localStorage.setItem('chefops.data.version', payload.data_version)
      window.dispatchEvent(new CustomEvent('chefops:bootstrap', { detail: payload }))
      return payload
    }

    const announcePackageUpdate = async () => {
      try {
        const update = await checkDataPackageV2Update(outletId)
        if (cancelled || !update.update_available) return
        localStorage.setItem(`chefops.data-package-v2.available.${outletId}`, JSON.stringify({
          version: update.available_version,
          installed_version: update.installed_version,
          total_bytes: update.manifest?.total_bytes || 0,
          published_at: update.manifest?.published_at || '',
          checked_at: new Date().toISOString(),
        }))
        window.dispatchEvent(new CustomEvent('chefops:data-package-v2-update-available', { detail: update }))
      } catch {
        // Existing verified local release remains authoritative while offline.
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
        let shouldInvalidateData = false
        let shouldCheckPackage = false

        for (const row of fresh) {
          try {
            const metadata = JSON.parse(row.metadata_json || '{}')
            if (Array.isArray(metadata.invalidate) && metadata.invalidate.length) {
              navigator.serviceWorker?.controller?.postMessage({ type: 'CLEAR_DATA_CACHE' })
              shouldInvalidateData = true
            }
            if (metadata.data_pack_update || metadata.data_pack_version || metadata.data_package_v2) {
              shouldCheckPackage = true
            }
          } catch {}
        }

        if (shouldInvalidateData) markQueriesStaleWithoutRefresh()
        if (shouldCheckPackage) await announcePackageUpdate()

        for (const row of fresh.slice(0, 3)) await showSystemNotification(row)
        ;(rows || []).forEach((row) => seen.add(row.id))
        localStorage.setItem(seenKey, JSON.stringify([...seen].slice(-500)))
        window.dispatchEvent(new CustomEvent('chefops:notifications', { detail: rows || [] }))
      } catch {}
    }

    const registerDevice = async () => {
      const installed = await getInstalledDataPackage(outletId)
      if (!installed?.manifest?.version) return
      const deviceStampKey = `chefops.device.registered.${userKey}`
      const lastRegistered = Number(localStorage.getItem(deviceStampKey) || 0)
      if (Date.now() - lastRegistered <= 12 * 60 * 60_000) return

      try {
        await opsClient.app.registerDevice({
          device_id: getDeviceId(),
          platform: platformName(),
          app_version: VERSION,
          data_package_version: installed.manifest.version,
          data_package_installed_at: installed.installed_at || '',
          notification_permission: 'Notification' in window ? Notification.permission : 'unsupported',
        })
        localStorage.setItem(deviceStampKey, String(Date.now()))
      } catch (error) {
        console.warn('Unable to register this device', error)
      }
    }

    const boot = async () => {
      const installed = await getInstalledDataPackage(outletId)
      if (!installed?.manifest?.version) return
      await publishLocalBootstrap()
      await publishNotifications()
      await registerDevice()
    }

    const onPackageReady = async (event) => {
      const eventOutlet = String(event?.detail?.outlet_id || '')
      if (eventOutlet && eventOutlet !== outletId && eventOutlet !== 'global') return
      await publishLocalBootstrap()
      markQueriesStaleWithoutRefresh()
      window.dispatchEvent(new CustomEvent('chefops:configuration-ready', { detail: event?.detail || null }))
      await registerDevice()
    }

    const onVisible = () => {
      if (document.visibilityState === 'visible') publishNotifications()
    }

    boot()
    window.addEventListener('chefops:data-package-v2-activated', onPackageReady)
    window.addEventListener('online', publishNotifications)
    document.addEventListener('visibilitychange', onVisible)
    navigator.storage?.persist?.().catch(() => undefined)

    notificationTimer = window.setInterval(() => {
      if (document.visibilityState !== 'hidden') publishNotifications()
    }, NOTIFICATION_CHECK_MS)

    return () => {
      cancelled = true
      window.removeEventListener('chefops:data-package-v2-activated', onPackageReady)
      window.removeEventListener('online', publishNotifications)
      document.removeEventListener('visibilitychange', onVisible)
      if (notificationTimer) window.clearInterval(notificationTimer)
    }
  }, [user])

  return null
}

export function cachedBootstrap() {
  try { return JSON.parse(localStorage.getItem(BOOTSTRAP_KEY) || 'null') } catch { return null }
}
