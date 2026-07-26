import { useEffect, useRef } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'

const EDGE_PX = 30
const COMMIT_PX = 72
const MAX_VERTICAL_DRIFT = 90

function nativeAppPlugin() {
  return window.Capacitor?.Plugins?.App || null
}

function isNativeAndroid() {
  const capacitor = window.Capacitor
  return Boolean(
    (capacitor?.isNativePlatform?.() && capacitor?.getPlatform?.() === 'android')
    || window.location.origin === 'https://localhost'
    || window.location.origin === 'capacitor://localhost'
  )
}

function isCoarsePointer() {
  return window.matchMedia?.('(pointer: coarse)').matches || navigator.maxTouchPoints > 0
}

function isRootPath(pathname) {
  return pathname === '/' || pathname === '/login'
}

function canStartFrom(target) {
  return !target?.closest?.('[data-no-swipe-back], [role="dialog"], input, textarea, select, video, canvas')
}

export default function MobileNavigation() {
  const navigate = useNavigate()
  const location = useLocation()
  const locationRef = useRef(location)

  useEffect(() => {
    locationRef.current = location
  }, [location])

  const goBack = () => {
    const current = locationRef.current
    if (isRootPath(current.pathname)) return false
    if (Number(window.history.state?.idx || 0) > 0) navigate(-1)
    else navigate('/', { replace: true })
    return true
  }

  useEffect(() => {
    const plugin = nativeAppPlugin()
    if (!plugin?.addListener) return undefined

    let listener = null
    let cancelled = false

    Promise.resolve(plugin.addListener('backButton', () => {
      if (goBack()) return
      Promise.resolve(plugin.minimizeApp?.()).catch(() => undefined)
    })).then((handle) => {
      if (cancelled) handle?.remove?.()
      else listener = handle
    }).catch(() => undefined)

    return () => {
      cancelled = true
      listener?.remove?.()
    }
  }, [navigate])

  useEffect(() => {
    if (!isCoarsePointer()) return undefined

    let tracking = false
    let committed = false
    let pointerId = null
    let startX = 0
    let startY = 0
    let lastX = 0

    const reset = () => {
      tracking = false
      committed = false
      pointerId = null
      document.documentElement.classList.remove('chefops-edge-back-active')
      document.documentElement.style.removeProperty('--chefops-back-progress')
    }

    const onPointerDown = (event) => {
      if (event.pointerType === 'mouse' || event.clientX > EDGE_PX || !canStartFrom(event.target)) return
      const current = locationRef.current
      if (isRootPath(current.pathname)) return

      tracking = true
      pointerId = event.pointerId
      startX = event.clientX
      startY = event.clientY
      lastX = event.clientX
    }

    const onPointerMove = (event) => {
      if (!tracking || event.pointerId !== pointerId) return
      const dx = Math.max(0, event.clientX - startX)
      const dy = Math.abs(event.clientY - startY)
      lastX = event.clientX

      if (dy > MAX_VERTICAL_DRIFT || dy > dx * 1.15) {
        reset()
        return
      }
      if (dx < 8) return

      event.preventDefault()
      document.documentElement.classList.add('chefops-edge-back-active')
      document.documentElement.style.setProperty('--chefops-back-progress', String(Math.min(1, dx / COMMIT_PX)))
      committed = dx >= COMMIT_PX
    }

    const onPointerEnd = (event) => {
      if (!tracking || event.pointerId !== pointerId) return
      const shouldGoBack = committed || lastX - startX >= COMMIT_PX
      reset()
      if (shouldGoBack) goBack()
    }

    document.addEventListener('pointerdown', onPointerDown, { passive: true })
    document.addEventListener('pointermove', onPointerMove, { passive: false })
    document.addEventListener('pointerup', onPointerEnd, { passive: true })
    document.addEventListener('pointercancel', reset, { passive: true })

    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('pointermove', onPointerMove)
      document.removeEventListener('pointerup', onPointerEnd)
      document.removeEventListener('pointercancel', reset)
      reset()
    }
  }, [navigate])

  useEffect(() => {
    document.documentElement.dataset.chefopsNative = isNativeAndroid() ? 'android' : 'web'
    return () => { delete document.documentElement.dataset.chefopsNative }
  }, [])

  return <div className="chefops-edge-back-indicator" aria-hidden="true">‹</div>
}
