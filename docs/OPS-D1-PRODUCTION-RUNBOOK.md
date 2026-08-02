# Stupiak's OPS — Canonical D1 and Production Runbook

This is the authoritative operating procedure for database audits, historical backfills, Worker deployment, PWA rollout, Android publication, verification, and rollback.

It exists because production must be proven by real D1 queries and real production responses. A successful commit, build, dry-run, Sheet update, or release job is not by itself proof that OPS production is correct.

## 1. Canonical identity

| Resource | Canonical value |
|---|---|
| Repository | `miltonlim1993-rgb/stupiak-standalone-operations` |
| Default branch | `main` |
| Local Mac repository | `/Users/mil/Projects/stupiak-standalone-operations` |
| Production Worker | `stupiaks-ops` |
| Production origin | `https://stupiaks-ops.sporkburger19.workers.dev` |
| Health endpoint | `https://stupiaks-ops.sporkburger19.workers.dev/api/health` |
| Cloudflare Account ID | `bb2ac1970975a5018a17c878e61cb88f` |
| D1 database | `stupiaks-ops-realtime` |
| D1 database ID | `080c13d7-e2f5-4c01-a1ca-aa00094d6fc0` |
| KV binding | `APP_DATA_PACKS` |
| KV namespace ID | `f62696e1a2f14b8a9e0b84a540c7e997` |
| Sheet mirror Queue | `stupiaks-ops-sheet-sync` |
| Sheet mirror DLQ | `stupiaks-ops-sheet-sync-dlq` |
| Master Sheet | `1sy-4AIbZssCmP9HQaq-K4OicXjdvOs2EXVNmvh4bSzM` |
| Operations 2026 Sheet | `1bFkU_tFcuEz6UFFqz7ehw8F1ttY_MkzfmQKkk_pN9xw` |
| Training Sheet | `1oljGV1NxJyGbFQoxkrzHeVBGCK7zs3r8x3jphe0HQAs` |
| Label source workbook | `1zzAB7r7ZEvN_DgqAdKA8QQOGdVThhbR7xXWu_72IGEg` |

Cloudflare Pages is not the canonical OPS production service. The Worker above serves both the React application and `/api/*`.

## 2. Non-negotiable architecture rules

1. **D1 is the canonical runtime database for migrated operational workflows.**
2. Google Sheets are an asynchronous mirror, backup, reporting surface, or administrative source for content that has not yet been migrated.
3. A staff page must not wait for a Google Sheet write before returning success after a valid D1 commit.
4. A staff page must not trigger Sheet migration, bootstrap, hydration, or package rebuilding during a normal runtime read.
5. Canonical mutations write `ops_records`, `ops_mutations`, and `sheet_sync_outbox` atomically.
6. Queue or Google Sheet failure must not roll back an already successful D1 commit.
7. Stable mutation IDs must make reconnect and retry submissions idempotent.
8. Do not overwrite a newer D1 row with an older Sheet row.
9. Do not run an old v14–v17 import script merely because a page is empty. Query D1 first.
10. Do not claim a database closure until real remote D1 counts and real API/page behavior have been checked.

## 3. Migration discipline

Do not run `wrangler d1 migrations apply`, `bench migrate`, schema creation, or a bootstrap endpoint as a default deployment step.

A D1 migration is allowed only when all of the following are true:

1. The intended change actually needs a new or changed D1 table, column, index, or trigger.
2. A read-only `sqlite_schema` audit proves the remote object is missing or outdated.
3. The migration file has been reviewed.
4. The exact D1 write scope and rollback have been explained before execution.
5. The migration is applied separately from normal code deployment and verified afterward.

The verified OPS 4.5.15 deployment did **not** run a D1 migration.

## 4. Current runtime source map

The repository defines 35 original schema entities. The D1 Label runtime additionally uses `LabelProduct` and `LabelRule` catalog records.

### D1 canonical or D1-first runtime

- `User`
- `Outlet`
- `Task`
- `TaskPhoto`
- `Attendance` through realtime routes
- `StockCount`
- `UrgentIssue`
- `Receipt`
- `CloseUp`
- `TrainingAssignment`
- `TrainingProgress`
- `TrainingAcknowledgement`
- `TrainingAttempt`
- `PrinterProfile`
- `FoodLabel`
- `LabelPrintLog`
- `LabelProduct` — runtime read-only catalog
- `LabelRule` — runtime read-only catalog

### Still mixed or Sheet/package managed

The following must not be falsely described as fully migrated until their legacy routes are removed or isolated:

- Task bootstrap still combines editable master configuration with canonical operational state.
- Attendance import has a legacy administrative path.
- Notifications have both generic realtime and legacy special endpoints.
- Master configuration such as inventory catalogs, task templates, SOP content, payment methods, positions, device registrations, and application settings still uses the Sheet/KV publication model.
- App package rebuilding may read Sheets, but staff package downloads must read only the last fully published KV package.

The target remains: staff runtime reads and writes must not depend synchronously on Google Sheets.

## 5. Canonical D1 tables

The core realtime migration defines:

- `ops_records`
- `ops_mutations`
- `sheet_sync_outbox`
- indexes supporting outlet/entity/date/status and pending outbox queries

Submission locking adds:

- `ops_submission_locks`

Before changing schema, inspect the actual remote database:

```bash
npx wrangler d1 execute stupiaks-ops-realtime --remote --json --command \
"SELECT type, name, tbl_name, sql
 FROM sqlite_schema
 WHERE name NOT LIKE 'sqlite_%'
 ORDER BY type, name;"
```

## 6. Read-only audit first

Use the repository command:

```bash
npm run ops:audit:d1
```

The audit must remain read-only. It records:

- `sqlite_schema`
- counts by entity
- distinct entities
- User/Outlet/active-user counts
- duplicate `(entity, entity_id)` checks
- outbox status
- mutation counts
- User and Outlet directory rows
- counts by outlet

Every query must report:

```text
changes: 0
rows_written: 0
changed_db: false
```

Do not proceed to a backfill when D1 already contains the required records.

## 7. Safe historical backfill contract

A historical backfill is not a normal deployment. It is a separately reviewed data operation.

Required procedure:

1. Export or read the source workbook without modifying it.
2. Count rows by date/entity/outlet.
3. Validate primary keys and identify duplicates.
4. Normalize only proven Sheet placeholder values.
5. Preserve real deletion timestamps.
6. Generate SQL using `ON CONFLICT(entity, entity_id) DO NOTHING` unless a separately reviewed newer-record comparison is required.
7. Save a read-only before snapshot.
8. Execute only the approved entity SQL.
9. Save write output.
10. Save a read-only after snapshot and duplicate check.
11. Never automatically roll back by broad entity/date deletion.
12. Keep exact inserted IDs for a possible targeted rollback.

Do not write `ops_mutations` or `sheet_sync_outbox` when importing historical rows that already came from the Sheet mirror. Otherwise the import can mirror the same historical rows back to Sheets again.

### Known Sheet placeholder values

The 2026 workbooks contained numeric placeholders in text fields, including:

- `deleted_at = 35`
- `deleted_at = 99`
- `deleted_at = 210`

These must not be treated as real deletion timestamps. Normalization must be field-specific and documented. Do not globally replace arbitrary values.

### Duplicate protection

The source workbooks contained duplicate IDs in some Task, product, and label-rule data. Do not silently discard rows. Resolve duplicates using source row identity, product/action/storage identity, updated timestamps, and an explicit correction manifest.

## 8. Verified historical repairs

### July 2026 Stock Count

Verified source rows:

| Date | Outlet | Rows |
|---|---:|---:|
| 2026-07-20 | RR-KCH | 40 |
| 2026-07-24 | RR-KCH | 67 |
| 2026-07-30 | RR-KCH | 126 |
| **Total** |  | **233** |

Verified remote D1 after repair:

```text
StockCount total_count = 233
StockCount unique_ids = 233
StockCount active_count = 233
StockCount deleted_count = 0
```

### Label data and catalog

Verified remote D1 after repair:

| Entity | Total | Active | Deleted |
|---|---:|---:|---:|
| PrinterProfile | 2 | 2 | 0 |
| FoodLabel | 4 | 1 | 3 |
| LabelPrintLog | 55 | 55 | 0 |
| LabelProduct | 67 | 67 | 0 |
| LabelRule | 114 | 114 | 0 |

No source row was intentionally discarded. Duplicate source product/rule IDs were canonicalized with a correction manifest.

## 9. Label runtime implementation

The Label D1 runtime is routed from `worker/src/entry.js` before the legacy Worker fallback.

Key files:

- `worker/src/realtime-labels-d1.js` — endpoint router and error boundary
- `worker/src/label-d1-store.js` — canonical D1 reads, optimistic version checks, atomic mutation/outbox batch, Queue enqueue
- `worker/src/label-d1-printer.js` — `PrinterProfile` entity and label printer API
- `worker/src/label-d1-operations.js` — catalog, label creation, reprint, source-batch finish, print logs

Runtime mutation entities:

- `PrinterProfile`
- `FoodLabel`
- `LabelPrintLog`

Runtime read-only catalog entities:

- `LabelProduct`
- `LabelRule`

The atomic mutation sequence is:

```text
1. Validate authentication, outlet scope, permission and expected version.
2. Build the canonical record.
3. D1 batch:
   - UPSERT ops_records
   - INSERT ops_mutations
   - INSERT sheet_sync_outbox
4. Commit D1.
5. Attempt Queue enqueue.
6. Broadcast realtime state.
7. Return success without waiting for Google Sheets.
```

A Queue failure leaves the outbox pending. It must not convert a successful D1 commit into HTTP 500.

## 10. Stock Count runtime

New Stock Count submissions use `/api/stock-counts/batch` and commit the full outlet/date batch atomically.

Required behavior:

- one stable mutation ID per batch
- all-or-nothing D1 write
- submission lock scope `stock:<outlet>:<count_date>`
- second device receives `423 submission_locked`, waits, and retries
- no partially saved outlet count
- historical Sheet rows are not automatically hydrated during staff page reads

## 11. User and Outlet directory

Verified D1 directory counts:

```text
users = 9
outlets = 4
active_users = 9
```

A failed bootstrap marker request does not roll back rows already committed to D1.

The internal marker endpoint must not be called as a normal deployment step. A 403 means the migration secret does not match; a 500 must be diagnosed from Worker logs. Do not repeatedly call old import endpoints when the directory counts are already correct.

## 12. Correct production deployment

Use:

```bash
npm run ops:deploy:verified
```

The command must:

1. Require a clean local Git worktree.
2. Use the existing local Wrangler OAuth session.
3. Fast-forward local `main`.
4. Run the architecture contract audit.
5. Download and SHA-verify the fixed latest Android APK.
6. Save a read-only D1 before snapshot.
7. Run `npm ci`.
8. Run `npm run build`.
9. Render the production Wrangler config with the canonical D1/KV/Queue bindings.
10. Deploy Worker code and web/PWA assets.
11. **Not run D1 migrations.**
12. Verify the production Worker revision header.
13. Verify `app-release.json` and the versioned service worker.
14. Verify the fixed APK URL serves the exact signed APK SHA-256.
15. Save a read-only D1 after snapshot.
16. Fail if protected D1 counts changed during deployment.

Never use a deployment script that creates a new D1 database, creates queues, applies migrations, invokes a Sheet bootstrap, or calls the directory marker during an ordinary release.

## 13. Android and PWA release contract

The fixed Android release tag is:

```text
android-release-latest
```

The mandatory APK asset is:

```text
stupiaks-ops-task-sop-alarm.apk
```

Release requirements:

- APK and minimum APK versions agree with `AppUpdateBanner.jsx`.
- PWA and minimum PWA versions agree with `main.jsx` and the versioned service worker file.
- `force_update` and `pwa_force_update` are true for a mandatory rollout.
- GitHub release title contains the target version.
- APK asset exists and is larger than 1 MB.
- `apksigner` verifies the signature.
- `aapt dump badging` verifies the embedded `versionName`.
- Release APK, fixed download URL APK, and `SHA256SUMS.txt` agree.
- Website/PWA installs the new controller, clears old caches, claims clients, and reloads.
- Android versions below the minimum stay blocked until the verified release asset is available.

## 14. Verified OPS 4.5.15 production snapshot

Verified on 2026-08-02:

| Item | Verified value |
|---|---|
| Main commit | `6a7245eb9c8fe0c50fceaf8f365fe38dbfb64051` |
| Worker revision | `realtime-resilience-v17-label-d1-runtime` |
| Cloudflare Version ID | `5feb8abc-3a6e-435e-a7aa-f5248b74af93` |
| Mandatory APK base version | `4.5.15` |
| Mandatory PWA version | `label-d1-runtime-pwa-v30` |
| APK SHA-256 | `9d0e100c50ab50c9b724d0fb481b86a15fd85f17eba900fb404992d6526c1f9f` |
| Fixed APK URL matched | `true` |
| D1 migration during release | `false` |
| D1 backfill during release | `false` |
| Protected D1 counts changed | `false` |

The local verified APK was saved as:

```text
/Users/mil/Downloads/Stupiaks-Ops-4.5.15-latest.apk
```

The local release audit directory was:

```text
/Users/mil/Projects/stupiak-standalone-operations/audit/final-release-4.5.15-20260802-204225
```

This section is a historical verified snapshot. Future releases must update the live manifest and add a new release record instead of rewriting history.

## 15. Rollback rules

### Code rollback

- Use the Cloudflare deployment list saved in the release audit directory, or redeploy a reviewed previous commit.
- Do not run a Sheet restore as part of code rollback.
- Do not delete records created after the deployed version; they may be valid production data.

### APK/PWA rollback

- Restore a previous manifest only as an intentional release decision.
- Publish and verify the previous signed APK asset before lowering the minimum version.
- Use a new versioned service worker URL when forcing clients to leave a broken PWA shell.

### Data rollback

- Use exact inserted IDs from the approved backfill manifest.
- Review every candidate row against later production changes.
- Never use an unbounded `DELETE FROM ops_records WHERE entity = ...` in production.

## 16. Known failure modes and prevention

### “API token already exists” confusion

Credentials live in separate scopes: local Wrangler OAuth, GitHub Actions secrets, Worker runtime secrets, and Cloudflare Pages variables. Check the actual execution scope before requesting a new token.

### Build passed but production is old

A merge or dry-run is not deployment proof. Verify the canonical production revision header and behavior.

### Old PWA interface remains visible

Use a new versioned service worker path, `skipWaiting`, old-cache deletion, `clients.claim`, and reload on `controllerchange`.

### APK fixed URL serves an old package

Verify release title, asset name, asset size, embedded version, signature, and SHA-256 downloaded from the fixed public URL.

### Shell script repeats forever with a Node syntax error

Do not place a top-level `return` inside `node -e`. Helper scripts must be syntax-tested before publication.

### CI fails on an old hard-coded grep

The architecture contract audit derives current APK/PWA values from the manifest instead of keeping unrelated stale version assertions.

### Sheet placeholder marks every row deleted

Normalize proven placeholder values before import and preserve real ISO deletion timestamps.

### Label Settings saves locally but returns HTTP 500

That means the UI cache accepted a draft but the server route failed. Verify `PrinterProfile`, catalog, `FoodLabel`, and `LabelPrintLog` routes are intercepted by the D1 Label router before legacy fallback.

## 17. Required evidence before saying “done”

For data work:

- remote before/after D1 counts
- rows written and changed database metadata
- duplicate checks
- exact inserted IDs
- rollback scope

For Worker work:

- build success
- production revision header
- real API/page action
- D1 result after the action
- confirmation that Sheet failure cannot undo the D1 result

For APK/PWA work:

- signed APK verification
- embedded Android version
- release asset metadata
- SHA-256 equality from the fixed public URL
- production manifest
- production service worker token
- old-client forced-update behavior

Do not replace evidence with assumptions.