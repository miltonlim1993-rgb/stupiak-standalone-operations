// Compatibility updater for existing v25 PWA installations.
// Updating this file wakes already-installed iPhone PWAs and moves them to the
// realtime Task refresh and resume-reconnect shell.
importScripts('/sw.js?realtime-resilience-v3-ios-live-task-v26')
