// Compatibility updater for existing v24 PWA installations.
// Older home-screen apps are moved to network-only authentication and the
// stable Cloudflare session shell before the app registers sw-v27.js.
importScripts('/sw.js?auth-session-stability-pwa-v28')