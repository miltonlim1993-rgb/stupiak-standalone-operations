export const DEVICE_VIEWPORT_VERSION = '4.6.13-cross-device-viewport-v15'

export function detectAppleMobileEnvironment({
  userAgent = '',
  platform = '',
  maxTouchPoints = 0,
} = {}) {
  const agent = String(userAgent || '')
  const devicePlatform = String(platform || '')
  const iPhoneOrIPad = /iPhone|iPad|iPod/i.test(agent)
  const touchMac = devicePlatform === 'MacIntel' && Number(maxTouchPoints || 0) > 1
  return iPhoneOrIPad || touchMac
}

export function browserPlatformName(navigatorValue = {}) {
  const userAgent = String(navigatorValue.userAgent || '')
  if (detectAppleMobileEnvironment({
    userAgent,
    platform: navigatorValue.platform,
    maxTouchPoints: navigatorValue.maxTouchPoints,
  })) return 'ios'
  if (/Android/i.test(userAgent)) return 'android-browser'
  if (/Windows/i.test(userAgent)) return 'windows'
  if (/Macintosh|Mac OS X/i.test(userAgent)) return 'macos'
  return 'web'
}

function isStandaloneDisplay() {
  return Boolean(
    window.matchMedia?.('(display-mode: standalone)').matches
    || window.navigator.standalone,
  )
}

function viewportHeight() {
  const visual = Number(window.visualViewport?.height || 0)
  const inner = Number(window.innerHeight || 0)
  return Math.max(1, Math.round(visual || inner || document.documentElement.clientHeight || 1))
}

function viewportWidth() {
  const visual = Number(window.visualViewport?.width || 0)
  const inner = Number(window.innerWidth || 0)
  return Math.max(1, Math.round(visual || inner || document.documentElement.clientWidth || 1))
}

export function installDeviceViewportV15() {
  if (typeof window === 'undefined' || window.__chefopsDeviceViewportV15) return
  window.__chefopsDeviceViewportV15 = true

  const root = document.documentElement
  const platform = browserPlatformName(window.navigator)
  root.dataset.chefopsPlatform = platform
  root.dataset.chefopsIos = platform === 'ios' ? 'true' : 'false'
  root.dataset.chefopsStandalone = isStandaloneDisplay() ? 'true' : 'false'

  let frame = 0
  const publish = () => {
    frame = 0
    const height = viewportHeight()
    const width = viewportWidth()
    root.style.setProperty('--chefops-viewport-height', `${height}px`)
    root.style.setProperty('--chefops-viewport-width', `${width}px`)
    root.style.setProperty('--chefops-browser-bottom-clearance', platform === 'ios' && !isStandaloneDisplay() ? '16px' : '0px')
    window.__chefopsViewport = {
      version: DEVICE_VIEWPORT_VERSION,
      platform,
      standalone: isStandaloneDisplay(),
      width,
      height,
    }
  }
  const schedule = () => {
    if (frame) return
    frame = window.requestAnimationFrame(publish)
  }

  publish()
  window.addEventListener('resize', schedule, { passive: true })
  window.addEventListener('orientationchange', schedule, { passive: true })
  window.addEventListener('pageshow', schedule, { passive: true })
  window.visualViewport?.addEventListener('resize', schedule, { passive: true })
  window.visualViewport?.addEventListener('scroll', schedule, { passive: true })

  const display = window.matchMedia?.('(display-mode: standalone)')
  display?.addEventListener?.('change', () => {
    root.dataset.chefopsStandalone = isStandaloneDisplay() ? 'true' : 'false'
    schedule()
  })
}
