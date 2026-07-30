const VERSION = 'chefops-v4-6-30-food-label-deep-training-v31'
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
        if (!['/labels', '/labels/settings', '/tasks', '/training', '/more'].includes(url.pathname) && !url.pathname.startsWith('/sop/')) return undefined
        return client.navigate(client.url)
      } catch {
        return undefined
      }
    }))),
  ]))
  self.clients.claim()
})

self.addEventListener('fetch', (event) => {
  const request = event.request
  if (request.method !== 'GET') return
  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return

  const alwaysFresh = request.mode === 'navigate'
    || ['/labels', '/labels/settings', '/tasks', '/training', '/more', '/sw.js'].includes(url.pathname)
    || url.pathname.startsWith('/sop/')
    || url.pathname.startsWith('/print-service/')

  if (alwaysFresh) {
    event.respondWith(fetch(request, { cache: 'no-store' }).catch(() => caches.match(request).then((cached) => cached || caches.match('/'))))
    return
  }

  if (url.pathname.startsWith('/api/')) {
    event.respondWith(fetch(request).catch(() => caches.match(request)))
    return
  }

  event.respondWith(caches.match(request).then((cached) => cached || fetch(request).then((response) => {
    if (!response || response.status !== 200 || response.type !== 'basic') return response
    const copy = response.clone()
    caches.open(SHELL_CACHE).then((cache) => cache.put(request, copy)).catch(() => undefined)
    return response
  })))
})
