// Compatibility updater for existing v25 PWA installations.
// Existing iPhone PWAs are moved to network-only authentication and the
// stable Cloudflare session shell before the app registers sw-v27.js.
importScripts('/sw.js?auth-session-stability-pwa-v28')