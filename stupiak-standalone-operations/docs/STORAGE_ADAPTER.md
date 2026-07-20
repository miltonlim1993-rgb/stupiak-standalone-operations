# Storage adapter plan

Current provider: `google_drive` through Google Apps Script.

Reserved provider: `cloudflare_r2`.

Set `FILE_STORAGE_PROVIDER=cloudflare_r2` later when an R2 writer and file migration policy are implemented. The frontend reads the provider status through `/api/system`; no page rewrite is required.

Recommended later migration:

1. Keep Google Sheet as structured operational record during transition.
2. Emit the same normalized submission event to Statvara.
3. Store generated monthly exports or attachments in R2.
4. Once verified, make Statvara the source of truth and retain Google Drive as archive/fallback.
