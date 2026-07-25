# Android APK build

The v4 web app is PWA-ready and also contains a Capacitor Android scaffold.

From the project root:

```bash
npm run mobile:init
```

This installs Capacitor packages, builds the web app, creates `web/android`, and syncs the current web build.

For a local debug APK (Android SDK/JDK required):

```bash
cd web/android
./gradlew assembleDebug
```

Debug output:

```text
web/android/app/build/outputs/apk/debug/app-debug.apk
```

For public distribution, create and protect your own Android signing key and build a signed release. Do not publish a debug APK as the production download.

After uploading the signed APK, set these rows in Master → AppSettings:

- `android_apk_url`
- `android_apk_version`
- `production_web_url`
- `release_notes`
- `app_data_version`

The `/install` page will then show the real download button and QR code.
