// Production release refresh: 4.5.11 / PWA v22
const VERSION = 'chefops-v4-5-11-auto-task-package-v22'
const SHELL_CACHE = `${VERSION}-shell`
const DATA_CACHE = `${VERSION}-data`
const OCR_CACHE = `${VERSION}-ocr`
const ALERT_DB = 'chefops-task-alerts-v1'
const ALERT_STORE = 'alerts'
const FIRED_STORE = 'fired'
const SHELL = ['/', '/manifest.webmanifest', '/app-release.json', '/stupiaks-ops-192.png', '/stupiaks-ops-512.png', '/apple-touch-icon.png', '/favicon-32.png']

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
  if (url.pathname === '/app-release.json') {
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

function openAlertDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(ALERT_DB, 1)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(ALERT_STORE)) db.createObjectStore(ALERT_STORE, { keyPath: 'id' })
      if (!db.objectStoreNames.contains(FIRED_STORE)) db.createObjectStore(FIRED_STORE, { keyPath: 'id' })
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

async function replaceAlertSchedule(alerts = []) {
  const db = await openAlertDb()
  await new Promise((resolve, reject) => {
    const transaction = db.transaction(ALERT_STORE, 'readwrite')
    const store = transaction.objectStore(ALERT_STORE)
    store.clear()
    for (const alert of alerts || []) {
      if (!alert?.id || !Number.isFinite(Number(alert.triggerAt))) continue
      store.put({
        id: String(alert.id),
        kind: String(alert.kind || 'task'),
        title: String(alert.title || 'Stupiak’s Ops'),
        message: String(alert.message || ''),
        targetPage: String(alert.targetPage || '/tasks'),
        triggerAt: Number(alert.triggerAt),
      })
    }
    transaction.oncomplete = resolve
    transaction.onerror = () => reject(transaction.error)
    transaction.onabort = () => reject(transaction.error)
  })
  db.close()
}

async function allFromStore(storeName) {
  const db = await openAlertDb()
  const rows = await new Promise((resolve, reject) => {
    const request = db.transaction(storeName, 'readonly').objectStore(storeName).getAll()
    request.onsuccess = () => resolve(request.result || [])
    request.onerror = () => reject(request.error)
  })
  db.close()
  return rows
}

async function rememberFired(id) {
  const db = await openAlertDb()
  await new Promise((resolve, reject) => {
    const transaction = db.transaction(FIRED_STORE, 'readwrite')
    transaction.objectStore(FIRED_STORE).put({ id, firedAt: Date.now() })
    transaction.oncomplete = resolve
    transaction.onerror = () => reject(transaction.error)
  })
  db.close()
}

async function showAlertNotification(item = {}) {
  const tag = String(item.id || `chefops-alert-${Date.now()}`)
  return self.registration.showNotification(item.title || 'Stupiak’s Ops', {
    body: item.message || '',
    icon: '/stupiaks-ops-192.png',
    badge: '/favicon-32.png',
    tag,
    renotify: true,
    requireInteraction: true,
    silent: false,
    timestamp: Number(item.triggerAt || Date.now()),
    vibrate: [700, 250, 700, 250, 1200],
    actions: [
      { action: 'open', title: '打开任务 / SOP' },
      { action: 'ack', title: '已处理' },
    ],
    data: {
      url: item.targetPage || item.target_page || '/',
      id: item.id || '',
      kind: item.kind || 'task',
    },
  })
}

async function checkDueAlerts() {
  const [alerts, firedRows] = await Promise.all([allFromStore(ALERT_STORE), allFromStore(FIRED_STORE)])
  const fired = new Set(firedRows.map((row) => row.id))
  const now = Date.now()
  const earliest = now - 6 * 60 * 60 * 1000
  for (const alert of alerts) {
    const triggerAt = Number(alert.triggerAt)
    if (!Number.isFinite(triggerAt) || triggerAt > now || triggerAt < earliest || fired.has(alert.id)) continue
    await showAlertNotification(alert)
    await rememberFired(alert.id)
  }
}

self.addEventListener('message', (event) => {
  const data = event.data || {}
  if (data.type === 'SKIP_WAITING') self.skipWaiting()
  if (data.type === 'CLEAR_DATA_CACHE') event.waitUntil(caches.delete(DATA_CACHE))
  if (data.type === 'SYNC_ALERT_SCHEDULE') {
    event.waitUntil(replaceAlertSchedule(data.alerts || []).then(checkDueAlerts))
  }
  if (data.type === 'SHOW_NOTIFICATION' && data.notification) {
    event.waitUntil(showAlertNotification(data.notification))
  }
})

self.addEventListener('periodicsync', (event) => {
  if (event.tag === 'chefops-task-alerts') event.waitUntil(checkDueAlerts())
})

self.addEventListener('sync', (event) => {
  if (event.tag === 'chefops-task-alerts-once') event.waitUntil(checkDueAlerts())
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  if (event.action === 'ack') return
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
