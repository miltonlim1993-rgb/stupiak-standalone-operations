import { useCallback, useEffect, useRef } from 'react'
import { opsClient } from '@/api/opsClient'
import { useAuth } from '@/lib/AuthContext'
import { getAppPackStatus, syncAppPack } from '@/lib/app-pack'
import { parseOutletIds } from '@/lib/outlets'
import { configureRosterTaskAssignment } from '@/lib/roster-task-assignment'

const TASK_SNAPSHOT_PREFIX = 'chefops.roster-task-assignment.tasks.v2.'
const TASK_REFRESH_INTERVAL_MS = 60_000
const PACKAGE_FORCE_INTERVAL_MS = 5 * 60_000
const AUTO_REFRESH_MARKER_KEY = 'chefops.automatic-task-refresh.version'
const AUTO_REFRESH_VERSION = '4.5.11'

function kuchingDate() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kuching',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date())
}

function clearAssignedTaskSnapshots() {
  const removed = []
  for (let index = localStorage.length - 1; index >= 0; index -= 1) {
    const key = localStorage.key(index)
    if (!key?.startsWith(TASK_SNAPSHOT_PREFIX)) continue
    localStorage.removeItem(key)
    removed.push(key)
  }
  return removed.length
}

function firstLaunchNeedsSnapshotReset() {
  const previous = localStorage.getItem(AUTO_REFRESH_MARKER_KEY)
  if (previous === AUTO_REFRESH_VERSION) return false
  localStorage.setItem(AUTO_REFRESH_MARKER_KEY, AUTO_REFRESH_VERSION)
  return true
}

export default function RosterTaskAssignmentManager() {
  const { user, isAuthenticated } = useAuth()
  const refreshRunning = useRef(false)
  const lastPackageForceAt = useRef(0)
  configureRosterTaskAssignment(isAuthenticated ? user : null)

  const refreshLatestTasks = useCallback(async ({ forcePackage = false, invalidateSnapshots = false } = {}) => {
    if (!isAuthenticated || !user || refreshRunning.current || !navigator.onLine) return
    const outletIds = [...new Set([
      ...parseOutletIds(user),
      String(user.outlet_id || ''),
    ].filter(Boolean))]
    if (!outletIds.length) return

    refreshRunning.current = true
    try {
      let packageChanged = false
      const packageOutletId = String(user.outlet_id || outletIds[0] || '')
      const shouldForcePackage = forcePackage
        || Date.now() - lastPackageForceAt.current >= PACKAGE_FORCE_INTERVAL_MS

      if (packageOutletId && shouldForcePackage) {
        const before = getAppPackStatus()
        const beforeVersion = String(before.version || before.current_version || '')
        const beforeDownloadedAt = String(before.last_downloaded_at || '')
        await syncAppPack({ outletId: packageOutletId, force: true })
        lastPackageForceAt.current = Date.now()
        const after = getAppPackStatus()
        packageChanged = beforeVersion !== String(after.version || '')
          || beforeDownloadedAt !== String(after.last_downloaded_at || '')
      }

      if (invalidateSnapshots || packageChanged) clearAssignedTaskSnapshots()

      const date = kuchingDate()
      await Promise.all(outletIds.map((outletId) => (
        // A forced bootstrap is deliberately used here. It refreshes the Sheet-backed
        // task record and rebuilds the instant roster-assigned snapshot in background.
        opsClient.tasks.operationalBootstrap({ outletId, date, refresh: true })
          .catch(() => undefined)
      )))

      window.__chefopsAutomaticTaskRefresh = {
        checkedAt: new Date().toISOString(),
        date,
        outletIds,
        packageChanged,
        snapshotsInvalidated: Boolean(invalidateSnapshots || packageChanged),
      }
    } finally {
      refreshRunning.current = false
    }
  }, [isAuthenticated, user?.email, user?.full_name, user?.outlet_id, user?.outlet_ids, user?.role])

  useEffect(() => {
    if (!isAuthenticated || !user) return undefined

    // The first 4.5.11 launch removes snapshots created by older APKs. This covers
    // devices that had already downloaded the package but still retained old Tasks.
    const resetOldSnapshots = firstLaunchNeedsSnapshotReset()

    // Do not start the old refresh=false warm-up first. A refresh=false build could
    // win the in-flight cache race and put the previous Task package back on screen.
    refreshLatestTasks({ forcePackage: true, invalidateSnapshots: resetOldSnapshots })

    const onActive = () => {
      if (document.visibilityState === 'visible') refreshLatestTasks()
    }
    const onPackageUpdated = () => {
      // Template/config-only changes may not alter the task row timestamp. Remove the
      // old instant snapshot so the newly downloaded package becomes visible at once.
      refreshLatestTasks({ invalidateSnapshots: true })
    }
    const interval = window.setInterval(() => refreshLatestTasks(), TASK_REFRESH_INTERVAL_MS)

    window.addEventListener('focus', onActive)
    window.addEventListener('online', onActive)
    window.addEventListener('chefops:data-pack-updated', onPackageUpdated)
    document.addEventListener('visibilitychange', onActive)
    return () => {
      window.clearInterval(interval)
      window.removeEventListener('focus', onActive)
      window.removeEventListener('online', onActive)
      window.removeEventListener('chefops:data-pack-updated', onPackageUpdated)
      document.removeEventListener('visibilitychange', onActive)
    }
  }, [isAuthenticated, refreshLatestTasks, user?.email])

  return null
}
