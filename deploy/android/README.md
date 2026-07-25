# Android APK plan

Stupiak's Ops uses Capacitor rather than a simple browser shortcut or TWA.

Why:

- full-screen staff experience;
- controlled camera access for task evidence;
- local IndexedDB drafts and downloaded data packages;
- future native notifications and update handling;
- the same React code remains the source for web and Android.

## Generate Android project

From the project root:

```bash
npm run mobile:init
```

This installs Capacitor, builds the web app, creates `web/android`, and syncs the current web assets.

## Debug APK

```bash
npm run mobile:apk:debug
```

Output:

```text
web/android/app/build/outputs/apk/debug/app-debug.apk
```

## Production APK / AAB

Create a private signing keystore in Android Studio. Do not commit it.

For direct staff installation, build a signed release APK. For Play Store or managed internal testing, build a signed AAB. Android requires release packages to be signed.

Recommended rollout:

1. Cloudflare Worker production test.
2. Debug APK on one Android phone and one tablet.
3. Signed internal APK for outlet staff.
4. Later move distribution to Google Play internal testing for automatic updates.

The bundled APK contains the application shell. Operational content and settings continue updating through downloaded Cloudflare data packages, so most Sheet changes do not require a new APK.
