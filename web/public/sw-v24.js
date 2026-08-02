// Compatibility updater for existing v24 PWA installations.
// Keeping this URL changing lets older iPhone home-screen apps discover the
// live Task shell before the new app registers sw-v26.js.
importScripts('/sw.js?realtime-resilience-v3-ios-live-task-v26')
