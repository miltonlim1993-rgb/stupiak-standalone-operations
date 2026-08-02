// Compatibility updater for existing v24 PWA installations.
// Keeping this file updated lets already-installed iPhone and desktop PWAs
// discover the realtime task shell before the new app registers sw-v25.js.
importScripts('/sw.js?realtime-resilience-v2-pwa-v25')