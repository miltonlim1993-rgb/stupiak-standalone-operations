# Stupiak Standalone Operations

Independent PWA for Cash Count and Stock Count. It does not use FeedMe and is not a Chrome extension.

## Included

- Responsive desktop/tablet/mobile UI
- Original stock Sheet order and Week 1–5 layout
- Visible stock period date range
- Weekly Inventory + Utensil submission
- Monthly Stationary submission
- Submit first, then Send to WhatsApp
- Cash opening, unlimited handovers, closing
- Cloudflare Pages GAS proxy to avoid browser CORS problems
- Server-side reserved Statvara event connector
- Reserved Cloudflare R2 storage adapter
- Installable PWA

## Build

```bash
npm run build
```

Cloudflare Pages settings:

- Build command: `npm run build`
- Build output directory: `dist`
- Root directory: `/`

The `functions/` directory is detected automatically by Cloudflare Pages.

## First use

Open Dev Settings and enter:

- Stock Count GAS URL (already prefilled)
- Stock Count Secret
- Cash Count GAS URL after the Cash patch has been deployed
- Cash Count Secret

The outlet name is loaded from Stock GAS and cannot be selected by outlet staff.

## Recommended Cloudflare environment variables

Using environment variables means outlet devices do not need to store GAS secrets locally:

- `STOCK_GAS_URL`
- `STOCK_GAS_SECRET`
- `CASH_GAS_URL`
- `CASH_GAS_SECRET`
- `OUTLET_REGISTRY_JSON` — maps external outlet IDs to canonical operations IDs, for example `{"6960e4e32553bd001c723f3b":"RR-KCH","feedme-id-2":"RR-MYY"}`
- `STOCK_DEFAULT_OUTLET` — optional single-outlet fallback; do not use it as routing for multi-outlet deployments
- `OPERATIONS_ADMIN_TOKEN` — required by setup import and stock-count deletion endpoints; keep it out of the outlet PWA
- `OUTLET_LINK_SECRET` — enables signed outlet sessions. When set, unsigned Cash/Stock requests are rejected.

Generate a signed outlet link without exposing the secret to the browser build:

```bash
OUTLET_LINK_SECRET='replace-with-a-long-random-secret' node scripts/sign-outlet-link.mjs 6960e4e32553bd001c723f3b outlet_operator 168
```

Reserved for later:

- `STATVARA_WEBHOOK_URL`
- `STATVARA_API_KEY`
- `FILE_STORAGE_PROVIDER=google_drive` (later `cloudflare_r2`)

## WhatsApp

Stock uses the WhatsApp URL returned by `StockCountMonthly.gs`. The button is shown only after GAS confirms a successful submission.


## Production secret handling

For production, configure `STOCK_GAS_URL` and `STOCK_GAS_SECRET` as Cloudflare Pages server variables. The Pages Function injects the secret when calling GAS, so outlet browsers do not store it. Browser Dev Settings remain only as a local-development fallback.
