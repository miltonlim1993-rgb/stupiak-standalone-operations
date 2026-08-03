// Stupiak's Ops mandatory PWA refresh for event-driven Task saving.
const OPS_PWA_VERSION = 'task-save-on-close-pwa-v37'

self.addEventListener('install', () => {
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
      .then(() => self.clients.matchAll({ type: 'window', includeUncontrolled: true }))
      .then((clients) => Promise.all(clients.map((client) => client.postMessage({
        type: 'OPS_PWA_VERSION_ACTIVATED',
        version: OPS_PWA_VERSION,
      })))),
  )
})

importScripts(
  `/sw-media-proxy.js?${OPS_PWA_VERSION}`,
  `/sw.js?${OPS_PWA_VERSION}`,
)
