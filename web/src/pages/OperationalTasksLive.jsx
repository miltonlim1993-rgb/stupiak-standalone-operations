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

function explicitSaveButton(target) {
  if (!(target instanceof Element)) return null
  const button = target.closest('button')
  const label = String(button?.textContent || '').trim()
  return ['保存进度', '完成任务'].some((action) => label.includes(action))
    ? button
    : null
}

export default function OperationalTasksLive() {
  const [revision, setRevision] = useState(0)
  const refreshTimer = useRef(null)
  const lastRefreshAt = useRef(0)
  const pendingRefresh = useRef(false)
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

    const clearSaveObserver = () => {
      settleObserver.current?.disconnect()
      settleObserver.current = null
    }

    const finishSave = ({ success, savingRevision }) => {
      clearSaveObserver()
      saveInFlight.current = false

      if (!success) {
        pendingCloseButton.current = null
        return
      }

      savedRevision.current = Math.max(savedRevision.current, savingRevision)
      if (!pendingCloseButton.current) return

      if (changeRevision.current > savedRevision.current) {
        runCloseSave()
        return
      }
      closeAfterSave()
    }

    const observeSaveCompletion = (button, savingRevision) => {
      const drawer = activeTaskDrawer()
      if (!drawer || !button) return

      let sawBusy = buttonBusy(button)
      let settled = false
      saveInFlight.current = true

      const settle = (success) => {
        if (settled) return
        settled = true
        finishSave({ success, savingRevision })
      }

      const inspect = () => {
        if (settled) return
        const currentDrawer = activeTaskDrawer()
        const currentButton = buttonWithText(currentDrawer, '保存进度')
          || buttonWithText(currentDrawer, '完成任务')

        if (!currentDrawer || !currentButton) {
          if (sawBusy) settle(!visibleTaskError())
          return
        }
        if (buttonBusy(currentButton)) {
          sawBusy = true
          return
        }
        if (sawBusy) settle(!visibleTaskError())
      }

      clearSaveObserver()
      settleObserver.current = new MutationObserver(inspect)
      settleObserver.current.observe(drawer, {
        subtree: true,
        childList: true,
        characterData: true,
        attributes: true,
        attributeFilter: ['disabled', 'aria-busy', 'class'],
      })

      queueMicrotask(inspect)
      window.requestAnimationFrame(() => {
        if (buttonBusy(button)) sawBusy = true
        window.requestAnimationFrame(() => {
          if (!settled && !sawBusy) settle(!visibleTaskError())
          else inspect()
        })
      })
    }

    function runCloseSave() {
      const drawer = activeTaskDrawer()
      const saveButton = buttonWithText(drawer, '保存进度')
      if (!drawer || !saveButton) return

      if (changeRevision.current <= savedRevision.current) {
        if (pendingCloseButton.current) closeAfterSave()
        return
      }
      if (saveInFlight.current) return

      if (buttonBusy(saveButton)) {
        const savingRevision = changeRevision.current
        observeSaveCompletion(saveButton, savingRevision)
        return
      }

      const savingRevision = changeRevision.current
      observeSaveCompletion(saveButton, savingRevision)
      saveButton.click()
    }

    const markDraftChanged = (event) => {
      if (!isTaskDraftInteraction(event.target)) return
      changeRevision.current += 1
    }

    const onDraftInput = (event) => markDraftChanged(event)
    const onDraftChange = (event) => markDraftChanged(event)

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
        runCloseSave()
        return
      }

      const manualButton = explicitSaveButton(target)
      if (manualButton) {
        const savingRevision = changeRevision.current
        observeSaveCompletion(manualButton, savingRevision)
        return
      }

      markDraftChanged(event)
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
        return
      }
      refresh(80)
    }

    const onActive = () => {
      if (document.visibilityState !== 'visible') return
      if (activeTaskDrawer()) return
      if (Date.now() - lastRefreshAt.current < 1000) return
      refresh(0)
    }

    const flushDirtyDraftOnce = () => {
      if (changeRevision.current <= savedRevision.current) return
      runCloseSave()
    }

    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        flushDirtyDraftOnce()
        return
      }
      onActive()
    }

    document.addEventListener('input', onDraftInput, true)
    document.addEventListener('change', onDraftChange, true)
    document.addEventListener('click', onDrawerClick, true)
    document.addEventListener('click', onTaskPageClick, true)
    window.addEventListener('chefops:realtime', onRealtime)
    window.addEventListener('chefops:realtime-applied', onRealtime)
    window.addEventListener('pageshow', onActive)
    window.addEventListener('pagehide', flushDirtyDraftOnce)
    window.addEventListener('focus', onActive)
    window.addEventListener('online', onActive)
    document.addEventListener('visibilitychange', onVisibility)

    return () => {
      window.clearTimeout(refreshTimer.current)
      clearSaveObserver()
      document.removeEventListener('input', onDraftInput, true)
      document.removeEventListener('change', onDraftChange, true)
      document.removeEventListener('click', onDrawerClick, true)
      document.removeEventListener('click', onTaskPageClick, true)
      window.removeEventListener('chefops:realtime', onRealtime)
      window.removeEventListener('chefops:realtime-applied', onRealtime)
      window.removeEventListener('pageshow', onActive)
      window.removeEventListener('pagehide', flushDirtyDraftOnce)
      window.removeEventListener('focus', onActive)
      window.removeEventListener('online', onActive)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [])

  return <OperationalTasksV2 key={revision} />
}
