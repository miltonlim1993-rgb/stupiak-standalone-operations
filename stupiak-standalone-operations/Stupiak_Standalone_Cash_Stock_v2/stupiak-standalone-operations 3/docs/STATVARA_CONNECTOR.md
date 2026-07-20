# Statvara connector contract

The UI does not call Statvara directly. Cloudflare Pages Function `/api/operations` emits an event only after Google Apps Script returns `ok: true` and `saved: true`.

Environment variables to enable later:

- `STATVARA_WEBHOOK_URL`
- `STATVARA_API_KEY`

Event types:

- `stock.count.submitted`
- `cash.opening.submitted`
- `cash.handover.submitted`
- `cash.closing.submitted`

A stock event contains outlet, business date, week index, order count and Google Sheet reference. A cash event contains phase, totals and variance.

Retries that return `duplicate: true` do not emit another Statvara event.
