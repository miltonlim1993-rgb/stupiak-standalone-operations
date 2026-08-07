# Native Task Photo Capture Contract

Task evidence photos use two capture paths:

- Web/PWA: the browser `<input type="file" accept="image/*" capture="environment">` path delivers the selected `File` through the native change event.
- Android APK: Capacitor Camera returns a camera result to `NativeMediaCaptureBridge`, which converts it to a `File` and publishes it directly to the open Task photo group through `task-photo-capture-channel.js`.

The Android path must not depend on assigning `input.files` with `DataTransfer` or synthesizing a React `change` event.

Before opening the Android Camera Activity, OPS persists the Task ID, outlet ID, and photo group ID. The bridge listens for Capacitor App `appRestoredResult`; if Android recreates the app while Camera is open, the restored camera result remains pending until the matching Task photo consumer is mounted again.

Once TaskForm receives a matching `File`, it immediately inserts a local evidence tile. Watermarking, file upload, and the D1 `TaskPhoto` mutation happen after that local preview exists. A failed upload remains on that tile with retry/remove controls.
