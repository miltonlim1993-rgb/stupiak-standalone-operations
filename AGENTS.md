# OPS Repository Operating Memory

This file records stable project facts and non-negotiable guardrails for every future agent or maintainer working in this repository.

The full operating procedure is [`docs/OPS-D1-PRODUCTION-RUNBOOK.md`](docs/OPS-D1-PRODUCTION-RUNBOOK.md). Read it before database work, deployment, APK/PWA publication, rollback, or any statement that production is complete.

## Canonical production identity

- Repository: `miltonlim1993-rgb/stupiak-standalone-operations`
- Default branch: `main`
- Local Mac repository: `/Users/mil/Projects/stupiak-standalone-operations`
- Cloudflare Worker name: `stupiaks-ops`
- Canonical application and API origin: `https://stupiaks-ops.sporkburger19.workers.dev`
- Canonical health endpoint: `https://stupiaks-ops.sporkburger19.workers.dev/api/health`
- Cloudflare Account ID: `bb2ac1970975a5018a17c878e61cb88f`
- D1 database: `stupiaks-ops-realtime`
- D1 database ID: `080c13d7-e2f5-4c01-a1ca-aa00094d6fc0`
- KV `APP_DATA_PACKS`: `f62696e1a2f14b8a9e0b84a540c7e997`
- Sheet mirror Queue: `stupiaks-ops-sheet-sync`
- Sheet mirror DLQ: `stupiaks-ops-sheet-sync-dlq`

Never substitute a Cloudflare Pages project, Pages preview URL, or Pages settings screen for the canonical OPS Worker. The Worker serves both the React SPA and `/api/*`.

## Runtime data truth

- D1 is the canonical runtime database for migrated operational workflows.
- `ops_records` stores current state.
- `ops_mutations` stores idempotent mutation results.
- `sheet_sync_outbox` stores durable asynchronous mirror work.
- Google Sheets are a mirror, reporting/backup surface, or an administrative source for content not yet migrated.
- Staff page success must not wait for Google Sheets.
- Queue or Sheet failure must not undo a valid D1 commit.
- Staff reads must not trigger legacy Sheet bootstrap, migration, or hydration.
- Do not describe all 35 original entities as fully migrated; check the source map in the canonical runbook.

## D1 migration rule

Do not run a D1 migration as part of a normal deployment.

A migration is permitted only after a read-only `sqlite_schema` audit proves that a reviewed schema change is required. Explain the migration file, remote objects affected, D1 writes, rollback, and verification before execution.

Do not call `migrate-once`, a directory bootstrap endpoint, old v14–v17 import scripts, or a Sheet hydration path during ordinary deployment.

## Credential scopes

There are separate credential scopes. Do not mix them:

1. Cloudflare Worker runtime secrets and bindings configure the running application.
2. Cloudflare Pages variables and secrets belong to that Pages project/build environment.
3. GitHub Actions secrets are available only to the GitHub-hosted runner and only when the workflow context can read them.
4. Local Wrangler OAuth belongs to the machine where `wrangler login` was completed.

A credential may exist in one scope while being unavailable in another. Do not ask the user to recreate or rotate a token before identifying the actual execution scope and checking `wrangler whoami`, workflow configuration, and logs.

The trusted Mac already has Wrangler OAuth associated with `sporkburger19@gmail.com`. Missing optional new Wrangler scopes do not invalidate D1/Worker deployment when the required D1 and Worker scopes are present.

## Canonical commands

Architecture and release contract audit:

```bash
npm run ops:audit:contract
```

Remote D1 read-only audit:

```bash
npm run ops:audit:d1
```

Verify deployed Worker, PWA, release asset and fixed APK SHA without deployment:

```bash
npm run ops:verify:production
```

Verified production deployment:

```bash
npm run ops:deploy:verified
```

`cf:deploy` and `deploy:realtime` intentionally resolve to the same verified no-migration deployment path.

## Required deployment behavior

The production deployer must:

1. require a clean worktree;
2. use existing Wrangler OAuth;
3. fast-forward `main`;
4. run `ops:audit:contract`;
5. confirm the signed fixed GitHub release exists;
6. save read-only D1 before counts;
7. run `npm ci` and `npm run build`;
8. render the canonical D1/KV/Queue bindings;
9. deploy Worker and web/PWA assets;
10. not create D1, KV, Queues, or R2;
11. not run migrations;
12. not run historical backfills;
13. not call a marker/bootstrap endpoint;
14. verify the production revision header, manifest, PWA service worker, signed APK, and SHA-256;
15. save read-only D1 after counts and review any difference.

Never state that production is updated merely because code reached `main`, CI passed, a Worker dry-run passed, or a GitHub release exists.

## Historical backfill rules

- Query remote D1 first.
- Export/read the source workbook without modifying it.
- Count source rows by entity/date/outlet.
- Identify duplicate IDs.
- Normalize only proven placeholder fields such as `deleted_at = 35`, `99`, or `210`.
- Preserve real ISO deletion timestamps.
- Default to `ON CONFLICT(entity, entity_id) DO NOTHING`.
- Do not overwrite an existing D1 row.
- Do not write `ops_mutations` or `sheet_sync_outbox` for rows already originating from the Sheet mirror.
- Save before/write/after evidence and exact inserted IDs.
- Never use a broad automatic rollback.

Verified historical repairs:

- `StockCount`: 233 unique active RR-KCH rows from 2026-07-20, 2026-07-24, and 2026-07-30.
- `PrinterProfile`: 2 active.
- `FoodLabel`: 4 total, 1 active, 3 real deleted rows.
- `LabelPrintLog`: 55 active.
- `LabelProduct`: 67 active.
- `LabelRule`: 114 active.
- `User`: 9 active.
- `Outlet`: 4 active.

Do not rerun those imports unless a fresh read-only audit proves rows are missing.

## Label D1 runtime

The D1 Label router must execute before legacy `app.fetch` fallback.

Core files:

- `worker/src/realtime-labels-d1.js`
- `worker/src/label-d1-store.js`
- `worker/src/label-d1-printer.js`
- `worker/src/label-d1-operations.js`

Mutation entities:

- `PrinterProfile`
- `FoodLabel`
- `LabelPrintLog`

Read-only catalog entities:

- `LabelProduct`
- `LabelRule`

A valid Label mutation atomically writes `ops_records`, `ops_mutations`, and `sheet_sync_outbox`, then attempts Queue mirroring. A Sheet/Queue error must not turn that committed mutation into HTTP 500.

## Android and PWA release rules

- Fixed release tag: `android-release-latest`.
- Mandatory APK asset: `stupiaks-ops-task-sop-alarm.apk`.
- `app-release.json`, `AppUpdateBanner.jsx`, `main.jsx`, and the versioned service worker must agree on APK/PWA versions.
- Mandatory rollout requires `force_update: true` and `pwa_force_update: true`.
- Verify release title/tag, expected asset name, asset size, APK signature, embedded version, and SHA-256.
- The fixed public download URL must serve the exact APK listed in `SHA256SUMS.txt`.
- A new PWA release uses a new service-worker URL and clears old caches before claiming clients and reloading.

## Verified OPS 4.5.15 release snapshot

Verified on 2026-08-02:

- main commit: `6a7245eb9c8fe0c50fceaf8f365fe38dbfb64051`
- Worker revision: `realtime-resilience-v17-label-d1-runtime`
- Cloudflare Version ID: `5feb8abc-3a6e-435e-a7aa-f5248b74af93`
- mandatory APK: `4.5.15`
- mandatory PWA: `label-d1-runtime-pwa-v30`
- APK SHA-256: `9d0e100c50ab50c9b724d0fb481b86a15fd85f17eba900fb404992d6526c1f9f`
- fixed APK match: true
- D1 migration during release: false
- D1 backfill during release: false
- protected D1 counts changed: false

This is a historical snapshot, not a value to hard-code forever. Future releases must add a new release record and keep the live manifest/source synchronized.

## Production verification checklist

Before saying “done”:

1. Confirm the intended commit exists on `main`.
2. Run the architecture contract audit.
3. Run build and Worker dry-run.
4. Deploy specifically to Worker `stupiaks-ops`.
5. Query the canonical health endpoint and revision header.
6. Perform the real page/API action.
7. Query D1 to confirm the result.
8. Confirm Sheet failure cannot undo a valid D1 commit.
9. For APK/PWA, verify the fixed public artifact SHA and forced-update behavior.

## Change discipline

- Never expose secret values in commits, logs, documentation, or chat.
- Do not commit OAuth files, `.dev.vars`, Android keystores, generated production Wrangler files, APKs, or AABs.
- Do not create a one-off secret probe that writes results into `main`.
- Do not silently discard duplicate source rows.
- Do not hide mixed or legacy routes by calling the whole system “fully migrated.”
- Do not use stale hard-coded CI grep assertions when the value can be derived from `app-release.json`.
- Keep `README.md`, this file, Cloudflare documentation, Android documentation, package commands, and the canonical runbook synchronized.
