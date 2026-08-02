# Stupiak's Ops

Standalone operations application for Stupiak's Pork Burger.

## Canonical production

- Production application and API origin: `https://stupiaks-ops.sporkburger19.workers.dev`
- Production health endpoint: `https://stupiaks-ops.sporkburger19.workers.dev/api/health`
- Cloudflare Worker name: `stupiaks-ops`

This Worker serves both the React application and `/api/*`. A Cloudflare Pages project or its Variables and secrets screen must not be treated as the canonical OPS production deployment.

## Architecture

D1 is the canonical runtime database for migrated operational workflows.

- `web/` — React + Vite application for desktop, tablet, mobile PWA, and the Android shell.
- `worker/` — Cloudflare Worker API, D1 runtime, Queue consumer/producer, Durable Object realtime, and static asset host.
- Cloudflare D1 (`stupiaks-ops-realtime`) — canonical runtime database for migrated operational workflows.
- `ops_records` — current canonical entity state.
- `ops_mutations` — idempotent mutation journal.
- `sheet_sync_outbox` — durable asynchronous Google Sheet mirror queue.
- Google Sheets — asynchronous mirror, reporting/backup surface, and administrative source only for content not yet migrated.
- Cloudflare KV (`APP_DATA_PACKS`) — last fully published, versioned configuration/content packages downloaded by devices.
- Cloudflare R2 (`MEDIA_BUCKET`) — reserved for task, issue, receipt, and SOP media migration.
- Capacitor Android — native APK wrapper using the same web application.

Staff runtime actions must not wait for Google Sheets. A valid D1 commit remains successful when Sheet mirroring is delayed or unavailable.

## Authoritative operating procedure

Read [`docs/OPS-D1-PRODUCTION-RUNBOOK.md`](docs/OPS-D1-PRODUCTION-RUNBOOK.md) before any D1 audit, historical backfill, Worker deployment, PWA rollout, Android release, rollback, or production success claim.

Repository guardrails for future maintainers and agents are recorded in [`AGENTS.md`](AGENTS.md).

## Local QA

```bash
npm install
npm run dev
```

- Web: `http://localhost:5188`
- Worker: `http://localhost:8787`

## Validation and safety audits

```bash
npm run ops:audit:contract
npm run build
```

Remote read-only D1 audit from the Mac that already has Wrangler OAuth:

```bash
npm run ops:audit:d1
```

Verify the currently deployed Worker, PWA manifest, GitHub release and fixed APK SHA without deploying:

```bash
npm run ops:verify:production
```

## Verified production deployment

Use only the reviewed no-migration deployment command:

```bash
npm run ops:deploy:verified
```

This command builds, renders canonical bindings, deploys Worker/Web/PWA assets, verifies the signed fixed APK, and compares protected D1 counts before and after. It does not run a D1 migration, Sheet bootstrap, historical backfill, marker call, database creation, or Queue creation.

Read [`deploy/cloudflare/README.md`](deploy/cloudflare/README.md) for Cloudflare resource and credential scopes.

## Android APK

Read [`deploy/android/README.md`](deploy/android/README.md).

## Release safety

Do not commit `.dev.vars`, OAuth credentials, service-account secrets, Android keystores, generated APK/AAB binaries, or generated production Wrangler files.
