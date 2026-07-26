const VERSION = 'chefops-v4-5-1-live-sync-mobile-shell-v3'
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
    if (response.ok || response.type === 'opaque') cache.put(request, response.clone()).catch(() => undefined)
    return response
  }).catch(() => cached)
  return cached || network
}

async function networkFirst(request, cacheName) {
  const cache = await caches.open(cacheName)
  try {
    const response = await fetch(request)
    if (response.ok) cache.put(request, response.clone()).catch(() => undefined)
    return response
  } catch {
    return (await cache.match(request)) || (request.mode === 'navigate' ? cache.match('/') : Response.error())
  }
}

self.addEventListener('fetch', (event) => {
  const request = event.request
  if (request.method !== 'GET') return
  const url = new URL(request.url)

  if (request.mode === 'navigate') {
    event.respondWith(networkFirst(request, SHELL_CACHE))
    return
  }
  if (url.hostname === 'cdn.jsdelivr.net' || url.hostname === 'esm.sh' || url.hostname === 'tessdata.projectnaptha.com') {
    event.respondWith(staleWhileRevalidate(request, OCR_CACHE))
    return
  }
  if (url.pathname.includes('/api/')) {
    if (isPackManifest(url)) event.respondWith(networkFirst(request, DATA_CACHE))
    else event.respondWith(isStaticApi(url) ? staleWhileRevalidate(request, DATA_CACHE) : networkFirst(request, DATA_CACHE))
    return
  }
  if (url.origin === self.location.origin) {
    event.respondWith(staleWhileRevalidate(request, SHELL_CACHE))
  }
})

self.addEventListener('message', (event) => {
  const data = event.data || {}
  if (data.type === 'SKIP_WAITING') self.skipWaiting()
  if (data.type === 'CLEAR_DATA_CACHE') event.waitUntil(caches.delete(DATA_CACHE))
  if (data.type === 'SHOW_NOTIFICATION' && data.notification) {
    const item = data.notification
    event.waitUntil(self.registration.showNotification(item.title || 'Stupiak’s Ops', {
      body: item.message || '',
      icon: '/stupiaks-ops-192.png',
      badge: '/favicon-32.png',
      tag: item.id || undefined,
      data: { url: item.target_page || '/', id: item.id || '' },
    }))
  }
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const target = event.notification.data?.url || '/'
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      const existing = clients.find((client) => 'focus' in client)
      if (existing) {
        existing.navigate(target)
        return existing.focus()
      }
      return self.clients.openWindow(target)
    }),
  )
})
