// Stupiak's Ops mandatory PWA refresh for the D1 Label runtime and OPS 4.5.15.
// The versioned registration URL forces installed website/PWA clients to install
// a new controller. Activation clears every older shell/data cache before the
// controller claims the page; main.jsx then reloads automatically.
const OPS_PWA_VERSION = 'label-d1-runtime-pwa-v30'

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
