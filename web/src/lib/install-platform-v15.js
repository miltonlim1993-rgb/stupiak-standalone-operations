import { detectAppleMobileEnvironment } from './device-viewport-v15.js'

export const INSTALL_PLATFORM_VERSION = '4.6.13-install-platform-v15'

export function detectInstallPlatform({
  userAgent = '',
  platform = '',
  maxTouchPoints = 0,
} = {}) {
  if (detectAppleMobileEnvironment({ userAgent, platform, maxTouchPoints })) return 'ios'
  if (/Android/i.test(String(userAgent || ''))) return 'android'
  return 'desktop'
}

export function currentInstallPlatform(navigatorValue = navigator) {
  return detectInstallPlatform({
    userAgent: navigatorValue?.userAgent,
    platform: navigatorValue?.platform,
    maxTouchPoints: navigatorValue?.maxTouchPoints,
  })
}

export function installInstructions(platform, installed = false) {
  if (installed) return {
    title: 'Web app installed',
    action: 'Installed',
    detail: 'Open Stupiak’s Ops from the Home Screen or app launcher.',
  }
  if (platform === 'ios') return {
    title: 'Install on iPhone / iPad',
    action: 'Safari Share → Add to Home Screen',
    detail: 'Open this page in Safari, tap Share, choose Add to Home Screen, then tap Add. iPhone cannot install Android APK files.',
  }
  if (platform === 'android') return {
    title: 'Install on Android',
    action: 'Download signed APK',
    detail: 'Download the signed APK in Chrome and install it over the current app. Do not uninstall first.',
  }
  return {
    title: 'Install web app',
    action: 'Install web app',
    detail: 'Use the browser Install app command, or scan the QR code from a phone or tablet.',
  }
}
