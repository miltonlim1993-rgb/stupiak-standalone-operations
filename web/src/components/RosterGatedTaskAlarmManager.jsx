import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { AlarmClock, BellRing, Loader2, Settings2, ShieldAlert } from 'lucide-react'
import { opsClient } from '@/api/opsClient'
import { useAuth } from '@/lib/AuthContext'
import { parseOutletIds } from '@/lib/outlets'
import {
  cancelTaskAlertsForTask,
  collectTaskAlerts,
  collectTrainingAlerts,
  enableTaskAlerts,
  getTaskAlertPermissionState,
  isNativeAndroid,
  markAlertAudioEnabled,
  openTaskAlertSettings,
  showWebTaskNotification,
  stopNativeTaskAlarm,
  syncTaskAlertSchedule,
  taskWorkHasStarted,
} from '@/lib/task-alerts'
import { alertAllowedByRoster, buildScheduledRosterKeys } from '@/lib/roster-alert-gate'

const FIRED_PREFIX = 'chefops.task-alerts.fired.'
const SYNC_INTERVAL_MS = 2 * 60 * 1000

function kuchingDate(offsetDays = 0) {
  const date = new Date(Date.now() + offsetDays * 86_400_000)
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kuching',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date)
}

function cleanupFiredAlerts() {
  const cutoff = Date.now() - 14 * 86_400_000
  for (let index = localStorage.length - 1; index >= 0; index -= 1) {
    const key = localStorage.key(index)
    if (!key?.startsWith(FIRED_PREFIX)) continue
    if (Number(localStorage.getItem(key) || 0) < cutoff) localStorage.removeItem(key)
  }
}

function wasFired(alertId) {
  return Boolean(localStorage.getItem(`${FIRED_PREFIX}${alertId}`))
}

function markFired(alertId) {
  localStorage.setItem(`${FIRED_PREFIX}${alertId}`, String(Date.now()))
}

function uniqueAlerts(alerts) {
  const map = new Map()
  for (const alert of alerts || []) {
    if (!alert?.id) continue
    map.set(alert.id, alert)
  }
  return [...map.values()].sort((a, b) => Number(a.triggerAt) - Number(b.triggerAt))
}

function eventTouchesTask(detail = {}) {
  if (String(detail.entity || '') === 'Task') return true
  return Array.isArray(detail.entities) && detail.entities.map(String).includes('Task')
}

function taskFromEvent(detail = {}) {
  const payload = detail?.payload || {}
  const candidates = [
    payload.task,
    payload.record,
    payload.summary?.task,
    payload.summary?.record,
  ]
  return candidates.find((value) => value && typeof value === 'object') || null
}

function taskFinished(task) {
  return String(task?.status || '').toLowerCase() === 'done'
    || String(task?.access_state || '').toUpperCase() === 'DONE'
}

export default function RosterGatedTaskAlarmManager() {
  const { user, isAuthenticated } = useAuth()
  const navigate = useNavigate()
  const [permission, setPermission] = useState(null)
  const [permissionBusy, setPermissionBusy] = useState(false)
  const [activeAlert, setActiveAlert] = useState(null)
  const [syncError, setSyncError] = useState('')
  const timersRef = useRef([])
  const audioRef = useRef({ context: null, interval: null })
  const activeAlertRef = useRef(null)
  const syncRunningRef = useRef(false)
  const realtimeSyncTimerRef = useRef(null)

  const refreshPermission = useCallback(async () => {
    const state = await getTaskAlertPermissionState()
    setPermission(state)
    return state
  }, [])

  const stopTone = useCallback(() => {
    if (audioRef.current.interval) clearInterval(audioRef.current.interval)
    audioRef.current.interval = null
    try { navigator.vibrate?.(0) } catch {}
  }, [])

  const clearActiveAlert = useCallback(async () => {
    const current = activeAlertRef.current
    activeAlertRef.current = null
    setActiveAlert(null)
    stopTone()
    if (current?.id) await stopNativeTaskAlarm(current.id)
  }, [stopTone])

  const ensureAudioContext = useCallback(async () => {
    const AudioContext = window.AudioContext || window.webkitAudioContext
    if (!AudioContext) return null
    if (!audioRef.current.context) audioRef.current.context = new AudioContext()
    if (audioRef.current.context.state === 'suspended') await audioRef.current.context.resume()
    return audioRef.current.context
  }, [])

  const startTone = useCallback(async () => {
    stopTone()
    const context = await ensureAudioContext().catch(() => null)
    if (!context) return
    const beep = () => {
      try {
        const oscillator = context.createOscillator()
        const gain = context.createGain()
        oscillator.type = 'square'
        oscillator.frequency.setValueAtTime(880, context.currentTime)
        oscillator.frequency.exponentialRampToValueAtTime(660, context.currentTime + 0.32)
        gain.gain.setValueAtTime(0.0001, context.currentTime)
        gain.gain.exponentialRampToValueAtTime(0.2, context.currentTime + 0.02)
        gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.38)
        oscillator.connect(gain)
        gain.connect(context.destination)
        oscillator.start()
        oscillator.stop(context.currentTime + 0.4)
      } catch {}
    }
    beep()
    audioRef.current.interval = window.setInterval(beep, 820)
    try { navigator.vibrate?.([700, 250, 700, 250, 1200]) } catch {}
  }, [ensureAudioContext, stopTone])

  const fireAlert = useCallback(async (alert) => {
    if (!alert?.id || wasFired(alert.id)) return
    markFired(alert.id)
    activeAlertRef.current = alert
    setActiveAlert(alert)
    await showWebTaskNotification(alert).catch(() => false)
    await startTone()
  }, [startTone])

  const installWebTimers = useCallback((alerts) => {
    for (const timer of timersRef.current) clearTimeout(timer)
    timersRef.current = []
    if (isNativeAndroid()) return
    for (const alert of alerts) {
      if (wasFired(alert.id)) continue
      const delay = Math.max(0, Number(alert.triggerAt) - Date.now())
      if (delay > 2_147_000_000) continue
      timersRef.current.push(window.setTimeout(() => fireAlert(alert), delay))
    }
  }, [fireAlert])

  const syncAlerts = useCallback(async () => {
    if (!isAuthenticated || !user || syncRunningRef.current) return
    syncRunningRef.current = true
    setSyncError('')
    try {
      const outletIds = [...new Set([
        ...parseOutletIds(user),
        String(user.outlet_id || ''),
      ].filter(Boolean))]
      const dates = [kuchingDate(0), kuchingDate(1), kuchingDate(2)]
      const taskRequests = outletIds.flatMap((outletId) => dates.map((date) => (
        opsClient.tasks.operationalBootstrap({ outletId, date, refresh: false })
          .then((data) => data?.tasks || [])
          .catch(() => [])
      )))
      const rosterRequests = outletIds.flatMap((outletId) => dates.map((date) => (
        opsClient.entities.Attendance.filter(
          { outlet_id: outletId, date },
          'staff_name,clock_in',
          300,
          { year: Number(date.slice(0, 4)) },
        )
          .then((rows) => ({ outletId, date, rows: rows || [], failed: false }))
          .catch((error) => ({ outletId, date, rows: [], failed: true, error }))
      )))

      const [taskGroups, rosterGroups, assignments, courses, progress] = await Promise.all([
        Promise.all(taskRequests),
        Promise.all(rosterRequests),
        opsClient.entities.TrainingAssignment.list('due_date', 3000).catch(() => []),
        opsClient.entities.TrainingCourse.list('category,title', 1000).catch(() => []),
        opsClient.entities.TrainingProgress.list('updated_at', 3000).catch(() => []),
      ])

      const allTasks = taskGroups.flat()
      const claimedTaskIds = new Set(allTasks
        .filter((task) => taskWorkHasStarted(task) || taskFinished(task))
        .map((task) => String(task?.id || '').trim())
        .filter(Boolean))
      await Promise.all([...claimedTaskIds].map((taskId) => cancelTaskAlertsForTask(taskId)))

      const scheduledKeys = buildScheduledRosterKeys({ rosterGroups, user })
      const allAlerts = uniqueAlerts([
        ...collectTaskAlerts(allTasks),
        ...collectTrainingAlerts({ assignments, courses, progress, userEmail: user.email }),
      ])
      const eligibleAlerts = allAlerts.filter((alert) => alertAllowedByRoster(alert, scheduledKeys))
      const scheduled = await syncTaskAlertSchedule(eligibleAlerts)
      installWebTimers(scheduled)

      const current = activeAlertRef.current
      if (current?.taskId && claimedTaskIds.has(String(current.taskId))) await clearActiveAlert()
      else if (current && !scheduled.some((alert) => alert.id === current.id)) await clearActiveAlert()
      cleanupFiredAlerts()

      const allRosterReadsFailed = rosterGroups.length > 0 && rosterGroups.every((group) => group.failed)
      if (allRosterReadsFailed) setSyncError('Duty Roster 暂时无法读取；为避免误响，所有闹钟已取消。')
      window.__chefopsRosterAlarmGate = {
        checkedAt: new Date().toISOString(),
        scheduledKeys: [...scheduledKeys],
        candidateAlerts: allAlerts.length,
        eligibleAlerts: scheduled.length,
        claimedTaskIds: [...claimedTaskIds],
        strict: true,
      }
    } catch (error) {
      await syncTaskAlertSchedule([]).catch(() => undefined)
      installWebTimers([])
      await clearActiveAlert()
      setSyncError(error?.message || 'Unable to verify Duty Roster; alarms were cancelled')
    } finally {
      syncRunningRef.current = false
    }
  }, [clearActiveAlert, installWebTimers, isAuthenticated, user])

  useEffect(() => {
    if (!isAuthenticated) return undefined
    refreshPermission()
    syncAlerts()
    const interval = window.setInterval(syncAlerts, SYNC_INTERVAL_MS)
    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        refreshPermission()
        syncAlerts()
      }
    }
    window.addEventListener('focus', onVisible)
    window.addEventListener('online', syncAlerts)
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      window.clearInterval(interval)
      window.removeEventListener('focus', onVisible)
      window.removeEventListener('online', syncAlerts)
      document.removeEventListener('visibilitychange', onVisible)
      for (const timer of timersRef.current) clearTimeout(timer)
      timersRef.current = []
      stopTone()
    }
  }, [isAuthenticated, refreshPermission, stopTone, syncAlerts])

  useEffect(() => {
    if (!isAuthenticated) return undefined

    const onTaskMutation = (event) => {
      const detail = event?.detail || {}
      if (!eventTouchesTask(detail)) return
      const task = taskFromEvent(detail)
      const taskId = String(task?.id || task?.__realtime?.entity_id || '').trim()
      if (taskId && (taskWorkHasStarted(task) || taskFinished(task))) {
        cancelTaskAlertsForTask(taskId).catch(() => undefined)
        if (String(activeAlertRef.current?.taskId || '') === taskId) clearActiveAlert()
      }
      window.clearTimeout(realtimeSyncTimerRef.current)
      realtimeSyncTimerRef.current = window.setTimeout(() => syncAlerts(), 120)
    }

    window.addEventListener('chefops:realtime', onTaskMutation)
    window.addEventListener('chefops:realtime-applied', onTaskMutation)
    window.addEventListener('chefops:task-state-changed', onTaskMutation)
    return () => {
      window.clearTimeout(realtimeSyncTimerRef.current)
      window.removeEventListener('chefops:realtime', onTaskMutation)
      window.removeEventListener('chefops:realtime-applied', onTaskMutation)
      window.removeEventListener('chefops:task-state-changed', onTaskMutation)
    }
  }, [clearActiveAlert, isAuthenticated, syncAlerts])

  useEffect(() => {
    const openTarget = (event) => {
      const targetPage = event?.detail?.targetPage || window.__chefopsPendingAlertTarget
      if (!targetPage) return
      window.__chefopsPendingAlertTarget = ''
      clearActiveAlert()
      navigate(targetPage)
    }
    window.addEventListener('chefops:native-alert-open', openTarget)
    if (window.__chefopsPendingAlertTarget) openTarget({ detail: { targetPage: window.__chefopsPendingAlertTarget } })
    return () => window.removeEventListener('chefops:native-alert-open', openTarget)
  }, [clearActiveAlert, navigate])

  async function enable() {
    setPermissionBusy(true)
    setSyncError('')
    try {
      await ensureAudioContext()
      markAlertAudioEnabled(true)
      await enableTaskAlerts()
      await refreshPermission()
      await syncAlerts()
    } catch (error) {
      setSyncError(error?.message || 'Unable to enable reminders')
    } finally {
      setPermissionBusy(false)
    }
  }

  async function acknowledge(open = false) {
    const alert = activeAlertRef.current
    await clearActiveAlert()
    if (open && alert?.targetPage) navigate(alert.targetPage)
  }

  if (!isAuthenticated) return null

  return (
    <>
      {activeAlert ? (
        <div className="fixed inset-0 z-[220] flex items-center justify-center bg-black/85 p-5" role="alertdialog" aria-modal="true" aria-label="Task alarm">
          <div className="w-full max-w-md overflow-hidden rounded-[28px] border-4 border-[#f2aa00] bg-white shadow-2xl">
            <div className="bg-[#f2aa00] px-6 py-5 text-black">
              <div className="flex items-center gap-3">
                <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-black text-[#f2aa00]"><BellRing className="h-7 w-7 animate-pulse" /></span>
                <div><p className="text-xs font-black uppercase tracking-[0.18em]">Scheduled Staff Alarm</p><p className="mt-1 text-lg font-black">任务 / SOP 提醒</p></div>
              </div>
            </div>
            <div className="space-y-5 p-6">
              <div><h2 className="text-2xl font-black leading-tight text-black">{activeAlert.title}</h2><p className="mt-3 text-sm font-medium leading-6 text-slate-600">{activeAlert.message}</p></div>
              <div className="flex items-start gap-2 rounded-2xl bg-amber-50 p-3 text-xs font-semibold leading-5 text-amber-900"><ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />只有当天 Duty Roster 有排班的员工会收到此响铃。有人开始任务后，同一任务的其余提醒会自动取消。</div>
              <div className="grid gap-3">
                <button type="button" onClick={() => acknowledge(true)} className="rounded-2xl bg-black px-4 py-3 text-sm font-black text-white">打开任务 / SOP</button>
                <button type="button" onClick={() => acknowledge(false)} className="rounded-2xl border-2 border-black px-4 py-3 text-sm font-black text-black">已处理，停止声音</button>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {permission && !permission.enabled ? (
        <div className="fixed bottom-[84px] left-3 right-3 z-[85] mx-auto max-w-md rounded-2xl border border-amber-300 bg-white p-3 shadow-xl md:bottom-5 md:left-auto md:right-5 md:w-[390px]">
          <div className="flex items-start gap-3">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-amber-100 text-amber-800"><AlarmClock className="h-5 w-5" /></span>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-black">启用排班员工 Task / SOP 闹钟</p>
              <p className="mt-1 text-xs leading-5 text-slate-600">只有 Duty Roster 当天列为 Scheduled 的账号会安装闹钟；未排班账号不会响。</p>
              {syncError ? <p className="mt-1 text-[11px] font-semibold text-rose-600">{syncError}</p> : null}
              <div className="mt-3 flex gap-2">
                <button type="button" onClick={enable} disabled={permissionBusy} className="inline-flex h-9 items-center justify-center rounded-xl bg-black px-3 text-xs font-black text-white disabled:opacity-60">
                  {permissionBusy ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <BellRing className="mr-1 h-4 w-4" />}启用提醒
                </button>
                {permission.platform === 'android' ? <button type="button" onClick={() => openTaskAlertSettings()} className="inline-flex h-9 items-center justify-center rounded-xl border px-3 text-xs font-bold"><Settings2 className="mr-1 h-4 w-4" />系统设置</button> : null}
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </>
  )
}