# Android APK and PWA release procedure

Stupiak's Ops uses Capacitor rather than a simple browser shortcut or TWA.

The authoritative deployment and rollback rules are in [`docs/OPS-D1-PRODUCTION-RUNBOOK.md`](../../docs/OPS-D1-PRODUCTION-RUNBOOK.md).

## Why Capacitor

- full-screen staff experience;
- controlled camera access for task evidence;
- local IndexedDB drafts and published data packages;
- native Task/SOP alarm handling;
- native update/download bridge;
- direct label-print integration;
- the same React source remains the basis for Web, PWA, and Android.

## Local Android project

Generate or resync the project:

```bash
npm run mobile:init
```

Debug APK:

```bash
npm run mobile:apk:debug
```

Output:

```text
web/android/app/build/outputs/apk/debug/app-debug.apk
```

A local debug build is not a production release.

## Canonical signed release

The GitHub Actions workflow is:

```text
.github/workflows/android-apk.yml
```

The fixed release tag is:

```text
android-release-latest
```

The mandatory APK asset used by OPS clients is:

```text
stupiaks-ops-task-sop-alarm.apk
```

The workflow also publishes:

- `stupiaks-ops-release.apk`
- `stupiaks-ops-direct-print-flow-v10.apk`
- `stupiaks-ops-release.aab`
- `app-release.json`
- `BUILD_INFO.txt`
- `SHA256SUMS.txt`

The release tag is intentionally replaced so the fixed URL always points to the latest approved signed package.

## Version contract

These files must agree:

- `web/public/app-release.json`
- `web/src/components/AppUpdateBanner.jsx`
- `web/src/main.jsx`
- the versioned service worker under `web/public/`
- `.github/workflows/android-apk.yml`

Mandatory release fields:

```json
{
  "apk_version": "<base version>",
  "minimum_apk_version": "<same base version>",
  "force_update": true,
  "pwa_version": "<versioned shell token>",
  "minimum_pwa_version": "<same shell token>",
  "pwa_force_update": true,
  "apk_asset_name": "stupiaks-ops-task-sop-alarm.apk"
}
```

The signed Android workflow appends its run number to the embedded Android `versionName`, for example `4.5.15.266`, while the client minimum comparison uses base version `4.5.15`.

## Signed release validation

The release workflow must pass all of these:

1. source architecture contract audit;
2. Web production build;
3. Worker dry-run;
4. Android project generation with existing native plugins;
5. debug APK compilation on pull requests;
6. signing-secret presence on `main` release;
7. signed APK and AAB build;
8. `apksigner verify --verbose --print-certs`;
9. `aapt dump badging` embedded `versionName` check;
10. GitHub release title contains the target version;
11. expected APK asset exists;
12. fixed release URL downloads the same APK;
13. release APK SHA, fixed URL SHA, and `SHA256SUMS.txt` match.

Do not unlock the client download button based only on a manifest URL. The client verifies the GitHub release identity, expected asset name, and minimum APK asset size before opening the download.

## Forced Android update behavior

`AppUpdateBanner.jsx`:

- checks on startup;
- checks every configured interval;
- rechecks when the app returns to the foreground;
- rechecks when network connectivity returns;
- compares installed native version to `minimum_apk_version`;
- locks the old application when `force_update` is true and the version is below minimum;
- waits for the matching signed GitHub release asset;
- opens a cache-busted fixed download URL;
- cannot be bypassed from the normal UI.

Android still displays the operating system installation confirmation. Staff must approve the overwrite installation and reopen OPS.

## Forced PWA update behavior

A mandatory PWA release uses a new versioned service worker URL.

The versioned worker must:

1. call `self.skipWaiting()`;
2. delete old shell/data caches during activation;
3. call `self.clients.claim()`;
4. notify or take control of open clients;
5. allow `main.jsx` to reload on `controllerchange`.

Do not reuse an old service-worker filename for a forced rollout. Old installed PWAs may continue serving cached code.

## Verify current production without deploying

```bash
npm run ops:verify:production
```

The verifier checks:

- production Worker revision header;
- health response;
- production `app-release.json`;
- production versioned service worker;
- GitHub fixed release metadata;
- expected APK asset name and size;
- `SHA256SUMS.txt`;
- fixed public APK URL SHA.

It saves a verified APK and evidence under the audit directory. Set a specific destination with:

```bash
OPS_APK_OUTPUT="$HOME/Downloads/Stupiaks-Ops-latest.apk" \
  npm run ops:verify:production
```

## Verified OPS 4.5.15 snapshot

Verified on 2026-08-02:

- mandatory base APK: `4.5.15`
- mandatory PWA: `label-d1-runtime-pwa-v30`
- Worker revision: `realtime-resilience-v17-label-d1-runtime`
- APK SHA-256: `9d0e100c50ab50c9b724d0fb481b86a15fd85f17eba900fb404992d6526c1f9f`
- fixed public APK matched: true

This is release history. Future releases must update the live version contract and add a new verified release record.

## Signing safety

Never commit:

- Android keystore files;
- keystore passwords;
- key aliases/passwords;
- base64 keystore secrets;
- generated APK/AAB binaries.

The GitHub workflow reads signing material from Actions secrets. The release must fail clearly when signing secrets are absent.

## Rollback

An Android rollback requires:

1. a reviewed previous source commit;
2. a valid signed previous APK/AAB;
3. a release manifest that intentionally lowers or changes the minimum version;
4. release-title, asset, signature, embedded version, and SHA verification;
5. a newly versioned PWA service worker if the Web/PWA shell is also rolled back.

Do not roll back application code by overwriting D1 from Sheets or deleting records created by the newer version.
