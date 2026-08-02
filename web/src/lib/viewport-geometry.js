const ROOT = document.documentElement
let frame = 0
let installed = false

function px(value) {
  return `${Math.max(0, Math.round(Number(value) || 0))}px`
}

function publishViewportGeometry() {
  frame = 0

  const visual = window.visualViewport
  const layoutWidth = Math.max(document.documentElement.clientWidth || 0, window.innerWidth || 0)
  const layoutHeight = Math.max(document.documentElement.clientHeight || 0, window.innerHeight || 0)
  const width = Math.max(1, visual?.width || window.innerWidth || layoutWidth || 1)
  const height = Math.max(1, visual?.height || window.innerHeight || layoutHeight || 1)
  const top = Math.max(0, visual?.offsetTop || 0)
  const left = Math.max(0, visual?.offsetLeft || 0)
  const right = Math.max(0, layoutWidth - left - width)
  const bottom = Math.max(0, layoutHeight - top - height)
  const keyboardInset = bottom > 96 && height < layoutHeight * 0.82 ? bottom : 0

  ROOT.style.setProperty('--chefops-viewport-width', px(width))
  ROOT.style.setProperty('--chefops-viewport-height', px(height))
  ROOT.style.setProperty('--chefops-viewport-top', px(top))
  ROOT.style.setProperty('--chefops-viewport-left', px(left))
  ROOT.style.setProperty('--chefops-viewport-right', px(right))
  ROOT.style.setProperty('--chefops-viewport-bottom', px(bottom))
  ROOT.style.setProperty('--chefops-keyboard-inset', px(keyboardInset))
  ROOT.dataset.chefopsKeyboard = keyboardInset > 0 ? 'open' : 'closed'

  window.__chefopsViewport = {
    width: Math.round(width),
    height: Math.round(height),
    top: Math.round(top),
    left: Math.round(left),
    right: Math.round(right),
    bottom: Math.round(bottom),
    keyboardInset: Math.round(keyboardInset),
  }

  window.dispatchEvent(new CustomEvent('chefops:viewport-changed', {
    detail: window.__chefopsViewport,
  }))
}

function scheduleViewportGeometry() {
  if (frame) return
  frame = window.requestAnimationFrame(publishViewportGeometry)
}

export function installViewportGeometry() {
  if (installed) {
    scheduleViewportGeometry()
    return
  }
  installed = true

  window.addEventListener('resize', scheduleViewportGeometry, { passive: true })
  window.addEventListener('orientationchange', scheduleViewportGeometry, { passive: true })
  window.addEventListener('pageshow', scheduleViewportGeometry, { passive: true })
  window.visualViewport?.addEventListener('resize', scheduleViewportGeometry, { passive: true })
  window.visualViewport?.addEventListener('scroll', scheduleViewportGeometry, { passive: true })
  document.addEventListener('visibilitychange', scheduleViewportGeometry, { passive: true })

  scheduleViewportGeometry()
}
