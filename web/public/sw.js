const VERSION = 'chefops-v4-6-16-web-direct-lan-stable-tspl-v18'
const SHELL_CACHE = `${VERSION}-shell`
const DATA_CACHE = `${VERSION}-data`
const OCR_CACHE = `${VERSION}-ocr`
const PACKAGE_OBJECT_CACHE_PREFIX = 'stupiaks-ops-data-package-v2-objects-'
const SHELL = ['/', '/manifest.webmanifest', '/stupiaks-ops-192.png', '/stupiaks-ops-512.png', '/apple-touch-icon.png', '/favicon-32.png']

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL)).catch(() => undefined))
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(Promise.all([
    caches.keys().then((keys) => Promise.all(keys
      .filter((key) => ![SHELL_CACHE, DATA_CACHE, OCR_CACHE].includes(key))
      .filter((key) => !key.startsWith(PACKAGE_OBJECT_CACHE_PREFIX))
      .map((key) => caches.delete(key)))),
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => Promise.all(clients.map((client) => {
      try {
        const url = new URL(client.url)
        if (url.origin !== self.location.origin) return undefined
        if (!['/labels', '/labels/settings', '/more'].includes(url.pathname)) return undefined
        return client.navigate(client.url)
      } catch {
        return undefined
      }
    }))),
  ]))
  self.clients.claim()
})

function isStaticApi(url) {
  return url.pathname.includes('/api/entities/Outlet')
    || url.pathname.includes('/api/entities/TaskTemplate')
    || url.pathname.includes('/api/entities/SOP')
    || url.pathname.includes('/api/entities/TrainingCourse')
    || url.pathname.includes('/api/entities/TrainingLesson')
    || url.pathname.includes('/api/entities/TrainingQuiz')
    || url.pathname.includes('/api/entities/TrainingQuestion')
    || url.pathname.includes('/api/entities/OutletStockList')
    || url.pathname.includes('/api/entities/PaymentMethod')
    || url.pathname.includes('/api/entities/PositionMaster')
    || url.pathname.includes('/api/labels/catalog')
}
