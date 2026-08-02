// Compatibility updater for installed PWA clients.
// Authentication remains network-only, known SOP posters use bundled assets,
// and v13 forces the stock-history/media UI shell to replace older clients.
importScripts(
  '/sw-media-proxy.js?stock-history-media-ui-v13',
  '/sw.js?auth-session-stability-pwa-v28',
)
