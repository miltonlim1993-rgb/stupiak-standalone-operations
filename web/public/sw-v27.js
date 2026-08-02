// Compatibility updater for installed PWA clients.
// This revision keeps authentication network-only, removes stale cached
// /api/auth responses and bounds session verification time.
importScripts('/sw.js?auth-session-stability-pwa-v28')