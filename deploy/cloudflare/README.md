# Cloudflare production layout

The authoritative operating procedure is [`docs/OPS-D1-PRODUCTION-RUNBOOK.md`](../../docs/OPS-D1-PRODUCTION-RUNBOOK.md).

## Canonical production service

```text
Origin:  https://stupiaks-ops.sporkburger19.workers.dev
Health:  https://stupiaks-ops.sporkburger19.workers.dev/api/health
Worker:  stupiaks-ops
```

The Worker serves both the React SPA and `/api/*` from the same deployment.

A Cloudflare Pages project such as `stupiakops`, including its Variables and secrets screen, is not canonical OPS production. Pages/Worker runtime variables configure application behavior after deployment; they do not authenticate a GitHub-hosted runner.

## Canonical production resources

| Resource | Value |
|---|---|
| Account ID | `bb2ac1970975a5018a17c878e61cb88f` |
| D1 database | `stupiaks-ops-realtime` |
| D1 database ID | `080c13d7-e2f5-4c01-a1ca-aa00094d6fc0` |
| KV binding | `APP_DATA_PACKS` |
| KV namespace ID | `f62696e1a2f14b8a9e0b84a540c7e997` |
| Sheet Queue | `stupiaks-ops-sheet-sync` |
| Sheet DLQ | `stupiaks-ops-sheet-sync-dlq` |
| Durable Object | `OUTLET_REALTIME` / `OutletRealtimeHub` |

R2 remains optional until media migration is intentionally enabled.

## Runtime architecture

1. D1 is canonical for migrated operational workflows.
2. `ops_records` stores current record state.
3. `ops_mutations` provides idempotent mutation replay.
4. `sheet_sync_outbox` stores durable asynchronous Sheet mirror work.
5. Queue mirroring runs after the D1 commit.
6. Google Sheet or Queue failure does not undo a successful D1 commit.
7. KV stores last fully published configuration/content packages for devices.
8. Staff package downloads use KV and do not trigger Sheet rebuilding.
9. Sheets remain an administrative source only for content not yet migrated, plus mirror/report/backup output.

## Credential scopes

Do not confuse these:

1. Worker runtime secrets and bindings.
2. Pages variables/secrets.
3. GitHub Actions secrets.
4. Local Wrangler OAuth.

A token can exist in one scope and be unavailable in another. Do not request a replacement token until the actual execution scope has been identified.

The trusted Mac has local Wrangler OAuth. Confirm it with:

```bash
npx wrangler whoami
```

Warnings about unrelated newly introduced Wrangler scopes do not require relogin when Worker/D1/Queue scopes needed by this project are already available.

## Read-only D1 audit

Run before data repair or schema decisions:

```bash
npm run ops:audit:d1
```

The audit checks every SQL statement for SELECT/WITH-only syntax and verifies Wrangler metadata reports zero writes.

## Canonical production deployment

Use:

```bash
npm run ops:deploy:verified
```

This deployment:

1. requires a clean worktree;
2. fast-forwards `main`;
3. runs the architecture contract audit;
4. confirms the fixed signed Android release exists;
5. saves read-only protected D1 counts;
6. builds Web and Worker dry-run;
7. renders canonical bindings;
8. deploys Worker and Web/PWA assets;
9. verifies Worker revision, manifest, PWA shell, GitHub release, fixed APK URL, and SHA-256;
10. saves read-only D1 counts again and reviews any difference.

It does **not**:

- create a D1 database;
- create KV, Queues, DLQ, R2, or Durable Objects;
- run a D1 migration;
- run a historical backfill;
- import Sheets;
- call the directory marker;
- call old v14–v17 migration scripts.

Resource IDs are supplied through environment variables with canonical non-secret defaults:

```bash
export CLOUDFLARE_OPS_DB_ID="080c13d7-e2f5-4c01-a1ca-aa00094d6fc0"
export CLOUDFLARE_APP_DATA_PACKS_ID="f62696e1a2f14b8a9e0b84a540c7e997"
export CLOUDFLARE_SHEET_SYNC_QUEUE_NAME="stupiaks-ops-sheet-sync"
export CLOUDFLARE_SHEET_SYNC_DLQ_NAME="stupiaks-ops-sheet-sync-dlq"
```

Do not set or commit OAuth tokens in repository files.

## Migration procedure

A normal deployment must not run migrations.

A reviewed D1 migration requires:

1. a read-only remote `sqlite_schema` audit;
2. proof that the intended code needs a missing/changed object;
3. review of the exact migration SQL;
4. an explicit write and rollback explanation;
5. separate execution from ordinary deployment;
6. post-migration schema and behavior verification.

Never add `wrangler d1 migrations apply` back into the normal deployment script.

## GitHub Actions

GitHub Actions and local Wrangler OAuth are separate deployment scopes.

The Cloudflare workflow must always run build and architecture checks. Production deployment should occur only in an explicit deploy context with readable:

```text
CLOUDFLARE_API_TOKEN
CLOUDFLARE_ACCOUNT_ID
```

GitHub also needs the canonical D1/KV/Queue identifiers when rendering production configuration. A same-named value in Cloudflare Dashboard runtime variables is not visible to GitHub Actions.

Do not report production complete from a GitHub workflow alone. Verify the canonical production origin and D1.

## Worker runtime secrets

Never commit values. Set only against the canonical `stupiaks-ops` Worker:

```bash
cd worker
npx wrangler secret put SESSION_SECRET
npx wrangler secret put GOOGLE_LOGIN_CLIENT_ID
npx wrangler secret put GOOGLE_DATA_CLIENT_ID
npx wrangler secret put GOOGLE_DATA_CLIENT_SECRET
npx wrangler secret put GOOGLE_DATA_REFRESH_TOKEN
npx wrangler secret put GOOGLE_MASTER_SPREADSHEET_ID
npx wrangler secret put GOOGLE_TRAINING_SPREADSHEET_ID
npx wrangler secret put GOOGLE_LABEL_SPREADSHEET_ID
npx wrangler secret put GOOGLE_OPERATIONS_SPREADSHEET_IDS
npx wrangler secret put GOOGLE_DRIVE_FOLDER_ID
npx wrangler secret put BOOTSTRAP_OWNER_EMAIL
npx wrangler secret put ALLOWED_ORIGINS
```

These Google credentials support remaining administrative/package/mirror workflows. They must not become a synchronous dependency for migrated staff runtime mutations.

## Production verification

Do not say “deployed” until all applicable checks pass:

```bash
npm run ops:verify:production
npm run ops:audit:d1
```

Required evidence includes:

- expected `X-ChefOps-Worker-Revision` header;
- health response `ok: true`;
- production mandatory APK/PWA versions;
- versioned service worker token and old-cache deletion;
- GitHub fixed release title and asset;
- fixed public APK SHA matching `SHA256SUMS.txt`;
- real page/API action;
- corresponding remote D1 record/mutation/outbox result.

## Rollback

- Save `wrangler deployments list` before and after release.
- Roll back code by selecting/redeploying a reviewed previous deployment or commit.
- Do not restore Sheets over D1 during code rollback.
- Do not delete records created after a release.
- APK/PWA rollback requires a verified signed artifact and a newly versioned service worker.
