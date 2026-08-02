// Compatibility updater for installed PWA clients.
// Authentication remains network-only and known SOP posters are served from
// bundled Cloudflare assets before any Google Drive fallback is attempted.
importScripts(
  '/sw-media-proxy.js?bundled-sop-media-v12',
  '/sw.js?auth-session-stability-pwa-v28',
)
