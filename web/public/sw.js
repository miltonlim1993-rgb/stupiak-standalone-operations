const VERSION = 'chefops-v4-6-12-all-device-print-v12-master-task-refresh-shell-v10'
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
    || url.pathname.includes('/api/app/v4/version')
    || url.pathname.includes('/api/app/v4/pack/module/')
}

function isPackManifest(url) {
  return url.pathname === '/api/app/v4/pack/manifest'
}

async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName)
  const cached = await cache.match(request)
  const network = fetch(request).then((response) => {
    if (response.ok) cache.put(request, response.clone())
    return response
  }).catch(() => cached)
  return cached || network
}

self.addEventListener('fetch', (event) => {
  const request = event.request
  if (request.method !== 'GET') return
  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return
  if (isPackManifest(url)) {
    event.respondWith(fetch(request).catch(() => caches.match(request)))
    return
  }
  if (isStaticApi(url)) {
    event.respondWith(staleWhileRevalidate(request, DATA_CACHE))
    return
  }
  if (url.pathname.startsWith('/api/')) return
  event.respondWith(fetch(request).catch(() => caches.match(request).then((cached) => cached || caches.match('/'))))
})
