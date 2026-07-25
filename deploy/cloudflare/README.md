# Cloudflare production layout

## Production services

1. One Cloudflare Worker serves both the React SPA and `/api/*`.
2. `APP_DATA_PACKS` KV stores the published package manifest and immutable modules.
3. Devices download the package into IndexedDB and only download modules whose hashes changed.
4. Google Sheets remain the owner-controlled source of truth.
5. A scheduled publish runs hourly instead of every 15 minutes to reduce Google API traffic.
6. `MEDIA_BUCKET` R2 is reserved for media migration; existing Drive media remains compatible during rollout.

## One-time resource setup

Authenticate Wrangler:

```bash
npx wrangler login
```

Create KV:

```bash
cd worker
npx wrangler kv namespace create APP_DATA_PACKS
```

Create R2:

```bash
npx wrangler r2 bucket create stupiaks-ops-media
```

Copy the KV namespace ID into GitHub Actions secret:

```text
CLOUDFLARE_APP_DATA_PACKS_ID
```

Create these GitHub Actions secrets:

```text
CLOUDFLARE_API_TOKEN
CLOUDFLARE_ACCOUNT_ID
CLOUDFLARE_APP_DATA_PACKS_ID
CLOUDFLARE_MEDIA_BUCKET_NAME=stupiaks-ops-media
```

## Worker secrets

Set these once from the project root. Never commit their values:

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

## Manual deploy

Generate the production Wrangler file:

```bash
export CLOUDFLARE_APP_DATA_PACKS_ID="YOUR_KV_NAMESPACE_ID"
export CLOUDFLARE_MEDIA_BUCKET_NAME="stupiaks-ops-media"
npm run cf:render
```

Deploy:

```bash
npm run cf:deploy
```

## First production publish

After the Worker and secrets are ready:

1. Sign in as Owner.
2. Open Ops Control.
3. Publish/rebuild all data packages once.
4. Confirm each outlet receives a manifest and its five package modules.
5. Confirm a second device launch uses the downloaded package without re-reading Google Sheets.
