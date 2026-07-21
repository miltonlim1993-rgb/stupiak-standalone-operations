const CACHE = 'stupiak-ops-v1.16.2';
const SHELL = ['/', '/index.html', '/src/app.css', '/src/dashboard.css', '/src/cash-full.css', '/src/offline-workflow.css', '/src/main.js', '/src/core/offline-workflow.js', '/src/core/stock-local-export.js', '/src/core/stock-setup-excel.js', '/src/core/stock-setup-legacy.js', '/src/core/stock-count-excel.js', '/vendor/exceljs.min.js', '/vendor/pdf-lib.min.js', '/manifest.webmanifest', '/icons/app-icon.svg'];
self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET' || new URL(request.url).pathname.startsWith('/api/')) return;
  event.respondWith(fetch(request).then((response) => {
    const clone = response.clone();
    caches.open(CACHE).then((cache) => cache.put(request, clone));
    return response;
  }).catch(() => caches.match(request).then((cached) => cached || caches.match('/index.html'))));
});