# Stupiak's Ops

Standalone operations application for Stupiak's Pork Burger.

## Architecture

- `web/` — React + Vite application for desktop, tablet, mobile PWA, and the Android shell.
- `worker/` — Cloudflare Worker API and static asset host.
- Google Sheets — owner-controlled operational source data.
- Cloudflare KV (`APP_DATA_PACKS`) — published, versioned data packages downloaded by devices.
- Cloudflare R2 (`MEDIA_BUCKET`) — reserved for task, issue, receipt, and SOP media migration.
- Capacitor Android — native APK wrapper using the same web application.

The staff application does not require direct Google Sheet or Drive access. Devices download a versioned data package and only fetch changed modules.

## Local QA

```bash
npm install
npm run dev
```

- Web: `http://localhost:5188`
- Worker: `http://localhost:8787`

## Validation

```bash
npm run build
```

## Cloudflare production

Read [`deploy/cloudflare/README.md`](deploy/cloudflare/README.md).

## Android APK

Read [`deploy/android/README.md`](deploy/android/README.md).

## Release safety

Do not commit `.dev.vars`, OAuth credentials, service-account secrets, Android keystores, APKs, or generated production Wrangler files.
