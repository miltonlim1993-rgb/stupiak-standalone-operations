# Cloudflare production layout

## Canonical production service

The only canonical OPS production origin is:

```text
https://stupiaks-ops.sporkburger19.workers.dev
```

Health verification must use:

```text
https://stupiaks-ops.sporkburger19.workers.dev/api/health
```

The production Worker name is `stupiaks-ops`. It serves both the React SPA and `/api/*` from the same deployment.

A Cloudflare Pages project such as `stupiakops`, including its **Variables and secrets** screen, is not the canonical OPS Worker deployment. Pages/Worker runtime variables configure application behavior after deployment; they do not authenticate a GitHub Actions runner to the Cloudflare account.

## Production resources

1. One Cloudflare Worker serves both the React SPA and `/api/*`.
2. `APP_DATA_PACKS` KV stores the published package manifest and immutable modules.
3. Devices download the package into IndexedDB and only download modules whose hashes changed.
4. Google Sheets remain the owner-controlled source of truth.
5. A scheduled publish runs hourly instead of every 15 minutes to reduce Google API traffic.
6. `MEDIA_BUCKET` R2 is reserved for media migration; existing Drive media remains compatible during rollout.

## Deployment paths

### GitHub Actions

`.github/workflows/deploy-cloudflare.yml` always builds and renders the production Wrangler configuration for relevant `main` changes.

It deploys automatically only when the current GitHub Actions context can read both:

```text
CLOUDFLARE_API_TOKEN
CLOUDFLARE_ACCOUNT_ID
```

When those credentials are unavailable during a normal `main` push, the workflow records that deployment was skipped instead of reporting a misleading Wrangler failure. A manually dispatched deployment still fails deliberately when credentials are unavailable.

`CLOUDFLARE_API_TOKEN` must be a GitHub Actions secret visible to this repository and workflow. A same-named value in Cloudflare Dashboard runtime variables is a different scope and cannot be read by GitHub.

The workflow verifies the canonical `/api/health` endpoint after every successful deployment.

### Local Wrangler deployment

A trusted machine may deploy using its existing Wrangler OAuth login. Authenticate once:

```bash
npx wrangler login
npx wrangler whoami
```

Provide the non-secret production resource identifiers required by the renderer:

```bash
export CLOUDFLARE_APP_DATA_PACKS_ID="YOUR_KV_NAMESPACE_ID"
# Optional until R2 is enabled:
export CLOUDFLARE_MEDIA_BUCKET_NAME="stupiaks-ops-media"
```

Build, render and deploy:

```bash
npm run cf:deploy
```

Then verify the real production service, not a Pages preview:

```bash
curl -fsS https://stupiaks-ops.sporkburger19.workers.dev/api/health
```

Never report a production deployment as complete until this endpoint returns the expected release marker or behavior.

## One-time resource setup

Create KV when establishing a new account or environment:

```bash
cd worker
npx wrangler kv namespace create APP_DATA_PACKS
```

Create R2 only when media migration is enabled:

```bash
npx wrangler r2 bucket create stupiaks-ops-media
```

GitHub Actions may use these repository secrets:

```text
CLOUDFLARE_API_TOKEN
CLOUDFLARE_ACCOUNT_ID
CLOUDFLARE_APP_DATA_PACKS_ID
CLOUDFLARE_MEDIA_BUCKET_NAME
```

Do not recreate or rotate a Cloudflare token merely because one runner cannot see it. First determine whether the credential exists in Cloudflare, a local Wrangler OAuth session, a GitHub repository secret, an environment secret, or another deployment system.

## Worker runtime secrets

Set these against the `stupiaks-ops` Worker. Never commit their values:

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

Only add optional sales, cash, Statvara, or web-push secrets when those features are enabled.

## First production publish

After the canonical Worker and secrets are ready:

1. Sign in as Owner at the canonical production origin.
2. Open Ops Control.
3. Publish/rebuild all data packages once.
4. Confirm each outlet receives a manifest and its package modules.
5. Confirm a second device launch uses the downloaded package without unnecessarily re-reading Google Sheets.
