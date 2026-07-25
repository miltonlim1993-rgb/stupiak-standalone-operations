const DEVICE_KEY = 'chefops.device.id'

export function getDeviceId() {
  let value = localStorage.getItem(DEVICE_KEY)
  if (!value) {
    value = crypto.randomUUID()
    localStorage.setItem(DEVICE_KEY, value)
  }
  return value
}

export function platformName() {
  const ua = navigator.userAgent || ''
  if (/android/i.test(ua)) return 'android-web'
  if (/iphone|ipad|ipod/i.test(ua)) return 'ios-web'
  if (/mac/i.test(ua)) return 'mac-web'
  if (/win/i.test(ua)) return 'windows-web'
  return 'web'
}

export async function showSystemNotification(item) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return false
  const registration = await navigator.serviceWorker?.ready.catch(() => null)
  if (registration) {
    registration.active?.postMessage({ type: 'SHOW_NOTIFICATION', notification: item })
    return true
  }
  new Notification(item.title || 'Stupiak’s Ops', { body: item.message || '', icon: '/stupiaks-ops-192.png', data: item })
  return true
}
