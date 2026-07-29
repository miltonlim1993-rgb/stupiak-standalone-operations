const VERSION = 'chefops-v4-6-12-all-device-print-v12-label-size-contract-v14-shell-v10'
const SHELL_CACHE = `${VERSION}-shell`
const DATA_CACHE = `${VERSION}-data`
const OCR_CACHE = `${VERSION}-ocr`
const SHELL = ['/', '/manifest.webmanifest', '/stupiaks-ops-192.png', '/stupiaks-ops-512.png', '/apple-touch-icon.png', '/favicon-32.png']

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL)).catch(() => undefined))
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((key) => ![SHELL_CACHE, DATA_CACHE, OCR_CACHE].includes(key)).map((key) => caches.delete(key)))),
  )
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
