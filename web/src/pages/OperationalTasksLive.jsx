import { useEffect, useRef, useState } from 'react'
import OperationalTasksV2 from '@/pages/OperationalTasksV2'

const TASK_ENTITIES = new Set(['Task', 'TaskPhoto'])
const AUTOSAVE_DELAY_MS = 900
const SAVE_TIMEOUT_MS = 20_000

function eventTouchesTasks(detail = {}) {
  const entities = Array.isArray(detail.entities)
    ? detail.entities
    : [detail.entity]
  return entities.some((entity) => TASK_ENTITIES.has(String(entity || '')))
}

function activeTaskDrawer() {
  return document.querySelector('.chefops-drawer-content[data-state="open"]')
    || document.querySelector('.chefops-drawer-content')
}

function buttonWithText(root, text) {
  return [...(root?.querySelectorAll?.('button') || [])]
    .find((button) => String(button.textContent || '').trim().includes(text)) || null
}

function isTaskDraftInteraction(target) {
  if (!(target instanceof Element)) return false
  const drawer = target.closest('.chefops-drawer-content')
  if (!drawer) return false
  if (target.closest('.chefops-drawer-header')) return false
  if (target.matches('input, textarea, select')) return true
  const button = target.closest('button')
  if (!button) return false
  const label = String(button.textContent || '').trim()
  if (!label) return false
  return ![
    '保存进度',
    '完成任务',
    '拍照',
    '加拍照片',
    '查看标准做法',
    '删除',
  ].some((action) => label.includes(action))
}

function visibleTaskError() {
  return [...document.querySelectorAll('.text-destructive')]
    .map((node) => String(node.textContent || '').trim())
    .find(Boolean) || ''
}

export default function OperationalTasksLive() {
  const [revision, setRevision] = useState(0)
  const [autosaveState, setAutosaveState] = useState('')
  const refreshTimer = useRef(null)
  const lastRefreshAt = useRef(0)
  const pendingRefresh = useRef(false)
  const autosaveTimer = useRef(null)
  const autosaveSettleTimer = useRef(null)
  const changeRevision = useRef(0)
  const savedRevision = useRef(0)
  const saveInFlight = useRef(false)

  useEffect(() => {
    const refresh = (delay = 80) => {
      window.clearTimeout(refreshTimer.current)
      refreshTimer.current = window.setTimeout(() => {
        if (activeTaskDrawer()) {
          pendingRefresh.current = true
          return
        }
        pendingRefresh.current = false
        lastRefreshAt.current = Date.now()
        setRevision((value) => value + 1)
      }, delay)
    }

    const completeDeferredRefresh = () => {
      if (!pendingRefresh.current || activeTaskDrawer()) return
      refresh(40)
    }

    const saveDraft = ({ immediate = false } = {}) => {
      window.clearTimeout(autosaveTimer.current)
      const run = () => {
        const drawer = activeTaskDrawer()
        const saveButton = buttonWithText(drawer, '保存进度')
        if (!drawer || !saveButton || saveButton.disabled) {
          if (drawer && changeRevision.current > savedRevision.current) {
            autosaveTimer.current = window.setTimeout(() => saveDraft(), 500)
          }
          return
        }
        if (saveInFlight.current || changeRevision.current <= savedRevision.current) return

        const savingRevision = changeRevision.current
        const startedAt = Date.now()
        let sawBusy = false
        saveInFlight.current = true
        setAutosaveState('saving')
        saveButton.click()

        const inspect = () => {
          const currentButton = buttonWithText(activeTaskDrawer(), '保存进度')
          if (currentButton?.disabled) sawBusy = true
          const timedOut = Date.now() - startedAt >= SAVE_TIMEOUT_MS
          const completed = sawBusy && currentButton && !currentButton.disabled

          if (!completed && !timedOut) {
            autosaveSettleTimer.current = window.setTimeout(inspect, 150)
            return
          }

          saveInFlight.current = false
          const error = visibleTaskError()
          if (completed && !error) {
            savedRevision.current = Math.max(savedRevision.current, savingRevision)
            setAutosaveState('saved')
            window.setTimeout(() => setAutosaveState(''), 1600)
          } else {
            setAutosaveState('error')
          }
          if (changeRevision.current > savedRevision.current && !error) saveDraft()
        }

        window.clearTimeout(autosaveSettleTimer.current)
        autosaveSettleTimer.current = window.setTimeout(inspect, 80)
      }

      if (immediate) run()
      else autosaveTimer.current = window.setTimeout(run, AUTOSAVE_DELAY_MS)
    }

    const markDraftChanged = (event) => {
      if (!isTaskDraftInteraction(event.target)) return
      changeRevision.current += 1
      setAutosaveState('pending')
      saveDraft()
    }

    const onDrawerClick = (event) => {
      const target = event.target
      if (!(target instanceof Element)) return
      const closeButton = target.closest('.chefops-drawer-header button[aria-label="Close"]')
      if (closeButton && changeRevision.current > savedRevision.current) {
        saveDraft({ immediate: true })
        window.setTimeout(completeDeferredRefresh, 2200)
        return
      }
      markDraftChanged(event)
    }

    const onTaskPageClick = (event) => {
      if (window.location.pathname !== '/tasks') return
      if (event.target instanceof Element && event.target.closest('.chefops-drawer-content')) return
      // Opening a pending task changes it to in_progress. Trigger an immediate
      // alarm resync on this device as well as the WebSocket broadcast sent to
      // the rest of the outlet devices.
      window.setTimeout(() => {
        window.dispatchEvent(new CustomEvent('chefops:task-state-changed', {
          detail: { entity: 'Task' },
        }))
      }, 650)
    }

    const onRealtime = (event) => {
      if (!eventTouchesTasks(event.detail || {})) return
      if (activeTaskDrawer()) {
        pendingRefresh.current = true
        if (changeRevision.current > savedRevision.current) saveDraft()
        return
      }
      refresh(80)
    }

    const onActive = () => {
      if (document.visibilityState !== 'visible') return
      if (activeTaskDrawer()) {
        if (changeRevision.current > savedRevision.current) saveDraft()
        return
      }
      if (Date.now() - lastRefreshAt.current < 1000) return
      refresh(0)
    }

    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        if (changeRevision.current > savedRevision.current) saveDraft({ immediate: true })
        return
      }
      onActive()
    }

    document.addEventListener('input', markDraftChanged, true)
    document.addEventListener('change', markDraftChanged, true)
    document.addEventListener('click', onDrawerClick, true)
    document.addEventListener('click', onTaskPageClick, true)
    window.addEventListener('chefops:realtime', onRealtime)
    window.addEventListener('chefops:realtime-applied', onRealtime)
    window.addEventListener('pageshow', onActive)
    window.addEventListener('focus', onActive)
    window.addEventListener('online', onActive)
    document.addEventListener('visibilitychange', onVisibility)

    return () => {
      window.clearTimeout(refreshTimer.current)
      window.clearTimeout(autosaveTimer.current)
      window.clearTimeout(autosaveSettleTimer.current)
      document.removeEventListener('input', markDraftChanged, true)
      document.removeEventListener('change', markDraftChanged, true)
      document.removeEventListener('click', onDrawerClick, true)
      document.removeEventListener('click', onTaskPageClick, true)
      window.removeEventListener('chefops:realtime', onRealtime)
      window.removeEventListener('chefops:realtime-applied', onRealtime)
      window.removeEventListener('pageshow', onActive)
      window.removeEventListener('focus', onActive)
      window.removeEventListener('online', onActive)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [])

  return (
    <>
      <OperationalTasksV2 key={revision} />
      {autosaveState ? (
        <div className={`pointer-events-none fixed bottom-[82px] left-1/2 z-[360] -translate-x-1/2 rounded-full px-3 py-1.5 text-[11px] font-bold text-white shadow-lg ${autosaveState === 'error' ? 'bg-rose-700' : 'bg-black/85'}`}>
          {autosaveState === 'pending'
            ? '草稿等待自动保存'
            : autosaveState === 'saving'
              ? '正在自动保存草稿…'
              : autosaveState === 'saved'
                ? '草稿已自动保存'
                : '草稿自动保存失败，将在下次修改时重试'}
        </div>
      ) : null}
    </>
  )
}