import { useEffect, useRef, useState } from 'react'
import OperationalTasksV2 from '@/pages/OperationalTasksV2'

const TASK_ENTITIES = new Set(['Task', 'TaskPhoto'])

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

function isTaskPhotoInteraction(target) {
  return target instanceof Element && Boolean(
    target.matches('input[type="file"]')
    || target.closest('[data-task-photo-ui]')
  )
}

function isTaskDraftInteraction(target) {
  if (!(target instanceof Element)) return false
  const drawer = target.closest('.chefops-drawer-content')
  if (!drawer) return false
  if (target.closest('.chefops-drawer-header')) return false
  if (isTaskPhotoInteraction(target)) return false
  if (target.matches('input, textarea, select')) return true
  const button = target.closest('button')
  if (!button) return false
  const label = String(button.textContent || '').trim()
  if (!label) return false
  return ![
    '保存进度',
    '完成任务',
    '查看标准做法',
    '删除',
  ].some((action) => label.includes(action))
}

function visibleTaskError() {
  return [...document.querySelectorAll('.text-destructive')]
    .map((node) => String(node.textContent || '').trim())
    .find(Boolean) || ''
}

function buttonBusy(button) {
  const label = String(button?.textContent || '').toLowerCase()
  return Boolean(
    button?.disabled
    || button?.getAttribute?.('aria-busy') === 'true'
    || label.includes('saving')
    || label.includes('保存中')
  )
}

export default function OperationalTasksLive() {
  const [revision, setRevision] = useState(0)
  const refreshTimer = useRef(null)
  const lastRefreshAt = useRef(0)
  const pendingRefresh = useRef(false)
  const scheduledSave = useRef(null)
  const scheduledSaveType = useRef('')
  const settleObserver = useRef(null)
  const changeRevision = useRef(0)
  const savedRevision = useRef(0)
  const saveInFlight = useRef(false)
  const pendingCloseButton = useRef(null)
  const bypassClose = useRef(false)

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

    const cancelScheduledSave = () => {
      if (!scheduledSave.current) return
      if (scheduledSaveType.current === 'idle' && window.cancelIdleCallback) {
        window.cancelIdleCallback(scheduledSave.current)
      } else {
        window.cancelAnimationFrame(scheduledSave.current)
      }
      scheduledSave.current = null
      scheduledSaveType.current = ''
    }

    const closeAfterSave = () => {
      const closeButton = pendingCloseButton.current
      pendingCloseButton.current = null
      if (!closeButton?.isConnected) return
      bypassClose.current = true
      closeButton.click()
      window.requestAnimationFrame(() => {
        bypassClose.current = false
        completeDeferredRefresh()
      })
    }

    const finishSave = ({ success, savingRevision }) => {
      settleObserver.current?.disconnect()
      settleObserver.current = null
      saveInFlight.current = false

      if (success) {
        savedRevision.current = Math.max(savedRevision.current, savingRevision)
        if (pendingCloseButton.current) closeAfterSave()
      } else {
        pendingCloseButton.current = null
      }

      if (changeRevision.current > savedRevision.current) scheduleSave({ immediate: true })
    }

    const waitForAvailableSaveButton = (drawer) => {
      settleObserver.current?.disconnect()
      settleObserver.current = new MutationObserver(() => {
        const currentButton = buttonWithText(activeTaskDrawer(), '保存进度')
        if (!currentButton || buttonBusy(currentButton)) return
        settleObserver.current?.disconnect()
        settleObserver.current = null
        scheduleSave({ immediate: true })
      })
      settleObserver.current.observe(drawer, {
        subtree: true,
        childList: true,
        characterData: true,
        attributes: true,
        attributeFilter: ['disabled', 'aria-busy', 'class'],
      })
    }

    const runSave = () => {
      scheduledSave.current = null
      scheduledSaveType.current = ''

      const drawer = activeTaskDrawer()
      const saveButton = buttonWithText(drawer, '保存进度')
      if (!drawer || !saveButton) return
      if (changeRevision.current <= savedRevision.current) {
        if (pendingCloseButton.current) closeAfterSave()
        return
      }
      if (saveInFlight.current) return
      if (buttonBusy(saveButton)) {
        waitForAvailableSaveButton(drawer)
        return
      }

      const savingRevision = changeRevision.current
      let sawBusy = false
      let settled = false
      saveInFlight.current = true

      const inspect = () => {
        if (settled) return
        const currentDrawer = activeTaskDrawer()
        const currentButton = buttonWithText(currentDrawer, '保存进度')
        if (!currentDrawer || !currentButton) return
        if (buttonBusy(currentButton)) {
          sawBusy = true
          return
        }
        if (!sawBusy) return
        settled = true
        finishSave({ success: !visibleTaskError(), savingRevision })
      }

      settleObserver.current?.disconnect()
      settleObserver.current = new MutationObserver(inspect)
      settleObserver.current.observe(drawer, {
        subtree: true,
        childList: true,
        characterData: true,
        attributes: true,
        attributeFilter: ['disabled', 'aria-busy', 'class'],
      })

      saveButton.click()
      queueMicrotask(inspect)
      window.requestAnimationFrame(() => {
        const currentButton = buttonWithText(activeTaskDrawer(), '保存进度')
        if (buttonBusy(currentButton)) sawBusy = true
        window.requestAnimationFrame(() => {
          if (settled || sawBusy) {
            inspect()
            return
          }
          settled = true
          finishSave({ success: !visibleTaskError(), savingRevision })
        })
      })
    }

    function scheduleSave({ immediate = false } = {}) {
      cancelScheduledSave()
      if (immediate) {
        runSave()
        return
      }

      if (typeof window.requestIdleCallback === 'function') {
        scheduledSaveType.current = 'idle'
        scheduledSave.current = window.requestIdleCallback(runSave)
      } else {
        scheduledSaveType.current = 'frame'
        scheduledSave.current = window.requestAnimationFrame(runSave)
      }
    }

    const markDraftChanged = (event, { immediate = false } = {}) => {
      if (!isTaskDraftInteraction(event.target)) return
      changeRevision.current += 1
      scheduleSave({ immediate })
    }

    const onDraftInput = (event) => markDraftChanged(event)
    const onDraftChange = (event) => markDraftChanged(event, { immediate: true })
    const onDraftFocusOut = (event) => {
      if (!(event.target instanceof Element)) return
      if (isTaskPhotoInteraction(event.target)) return
      if (!event.target.closest('.chefops-drawer-content')) return
      if (changeRevision.current > savedRevision.current) scheduleSave({ immediate: true })
    }

    const onDrawerClick = (event) => {
      const target = event.target
      if (!(target instanceof Element)) return
      const closeButton = target.closest('.chefops-drawer-header button[aria-label="Close"]')
      if (closeButton) {
        if (bypassClose.current || changeRevision.current <= savedRevision.current) return
        event.preventDefault()
        event.stopPropagation()
        event.stopImmediatePropagation()
        pendingCloseButton.current = closeButton
        scheduleSave({ immediate: true })
        return
      }
      markDraftChanged(event, { immediate: true })
    }

    const onTaskPageClick = (event) => {
      if (window.location.pathname !== '/tasks') return
      if (event.target instanceof Element && event.target.closest('.chefops-drawer-content')) return
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
        if (!saveInFlight.current && changeRevision.current > savedRevision.current) {
          scheduleSave({ immediate: true })
        }
        return
      }
      refresh(80)
    }

    const onActive = () => {
      if (document.visibilityState !== 'visible') return
      if (activeTaskDrawer()) {
        if (changeRevision.current > savedRevision.current) scheduleSave({ immediate: true })
        return
      }
      if (Date.now() - lastRefreshAt.current < 1000) return
      refresh(0)
    }

    const flushDraft = () => {
      if (changeRevision.current > savedRevision.current) scheduleSave({ immediate: true })
    }

    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        flushDraft()
        return
      }
      onActive()
    }

    document.addEventListener('input', onDraftInput, true)
    document.addEventListener('change', onDraftChange, true)
    document.addEventListener('focusout', onDraftFocusOut, true)
    document.addEventListener('click', onDrawerClick, true)
    document.addEventListener('click', onTaskPageClick, true)
    window.addEventListener('chefops:realtime', onRealtime)
    window.addEventListener('chefops:realtime-applied', onRealtime)
    window.addEventListener('pageshow', onActive)
    window.addEventListener('pagehide', flushDraft)
    window.addEventListener('focus', onActive)
    window.addEventListener('online', onActive)
    document.addEventListener('visibilitychange', onVisibility)

    return () => {
      window.clearTimeout(refreshTimer.current)
      cancelScheduledSave()
      settleObserver.current?.disconnect()
      document.removeEventListener('input', onDraftInput, true)
      document.removeEventListener('change', onDraftChange, true)
      document.removeEventListener('focusout', onDraftFocusOut, true)
      document.removeEventListener('click', onDrawerClick, true)
      document.removeEventListener('click', onTaskPageClick, true)
      window.removeEventListener('chefops:realtime', onRealtime)
      window.removeEventListener('chefops:realtime-applied', onRealtime)
      window.removeEventListener('pageshow', onActive)
      window.removeEventListener('pagehide', flushDraft)
      window.removeEventListener('focus', onActive)
      window.removeEventListener('online', onActive)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [])

  return <OperationalTasksV2 key={revision} />
}
