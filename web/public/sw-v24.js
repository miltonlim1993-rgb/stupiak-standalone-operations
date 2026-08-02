// Compatibility updater for existing v24 PWA installations.
// Older iPhone home-screen apps are moved to the shared task claim and
// draft autosave shell before the app registers sw-v27.js.
importScripts('/sw.js?shared-task-claim-autosave-pwa-v27')