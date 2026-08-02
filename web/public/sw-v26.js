// Compatibility updater for existing v26 PWA installations.
// Installed iPhone and desktop PWAs are moved to the shared task claim and
// draft autosave shell before the app registers sw-v27.js.
importScripts('/sw.js?shared-task-claim-autosave-pwa-v27')