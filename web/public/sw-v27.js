// Compatibility updater for installed PWA clients.
// Authentication remains network-only and Google Drive media is rewritten
// through the authenticated OPS file proxy before the main worker handles it.
importScripts(
  '/sw-media-proxy.js?drive-media-proxy-v11',
  '/sw.js?auth-session-stability-pwa-v28',
)
