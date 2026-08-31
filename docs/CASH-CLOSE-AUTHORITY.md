# Cash Close authority contract

This document records the Slice 006 runtime authority boundary for `LOOP-029 — Cash Custody and Close Up`. It does not rewrite the historical Phase 1 registries.

## Authority map

| Fact | Runtime role | Owner |
|---|---|---|
| FeedMe payment/counter totals | External input | Signed FeedMe expected-basis bridge |
| Expected basis identity, version, watermark and digest | Accepted external snapshot | Cloudflare D1 `CashExpectedBasis` record |
| Physical cash and denomination quantities | Authoritative operational truth | Cloudflare D1 `CloseUp` record accepted from a current human principal |
| Custodian | Authoritative identity | Current authenticated D1 `User`; never a body claim |
| Variance | Authoritative derived fact | Worker integer-cent calculation |
| Review and completion | Authoritative human decision | Cloudflare D1 `CloseUp` lifecycle |
| Correction | Authoritative linked replacement | New D1 `CloseUp` record; the completed original is unchanged |
| Google Sheet | Asynchronous mirror only | `sheet_sync_outbox` and Queue consumer |
| Core PostgreSQL | No Slice 006 cash-close ownership | Unchanged schema version 18 |
| R2 | Evidence storage only when a separately governed file is attached | No Slice 006 file requirement was invented |
| Browser/device | Provisional entry and retry queue | IndexedDB specialized-operation outbox |

## FeedMe expected source

The frozen FeedMe evidence exposes the Summary report (`report_id = 63e368a60000000000000000`) with `Payment breakdown`, `Daily sales`, and `Counter` blocks. The current report-time bridge scopes data by FeedMe business ID, FeedMe outlet/location ID, one outlet, one business date, and the closing phase. Payment channels currently normalize to Cash, DuitNow/Card, SPay, Pay & Go, GrabPay, Other, GrabFood, Foodpanda, Shopee Food, and Grab Dine Out.

FeedMe snapshots are query-derived and can change after an earlier capture. Every accepted basis therefore retains provider, business ID, report ID, external outlet ID, snapshot ID, source version, watermark, observed timestamp, amounts, and a server-calculated SHA-256 digest. Import uses `POST /api/cash-close/expected`; only `provider=feedme` is accepted.

The bridge request is authenticated with HMAC-SHA256 over `<ISO timestamp>.<exact request body>` using the `X-Statvara-Cash-Timestamp` and `X-Statvara-Cash-Signature` headers. `CASH_EXPECTED_BRIDGE_SECRET` must be injected as a Worker secret outside source control. Missing, short, expired, or invalid secret/signature state fails closed. No `VITE_*` variable or browser bundle consumes this secret.

## Authoritative lifecycle

The Slice 006 command API owns night/closing records:

1. `POST /api/cash-close/submit` accepts a signed expected-basis reference and a current custodian's denomination/channel actuals.
2. The server recalculates actual cash, payment totals, and variance with integer cents. Non-zero variance retains a reason.
3. The record enters `submitted` and cannot be edited through generic entity, generic realtime, or legacy CloseUp mutation paths.
4. `POST /api/cash-close/review` requires a current human reviewer capability, assigned outlet scope, and a reviewer distinct from the submitter. Accept produces `completed`; reject produces `rejected`.
5. A newer FeedMe snapshot never rewrites a submitted/completed record. Review of a drifted basis requires explicit acknowledgement and a reason.
6. `POST /api/cash-close/correct` creates a new `submitted` replacement linked by `root_close_id`, `correction_of_id`, and `correction_sequence`. Independent review makes that replacement current; the original completed payload remains unchanged.

Opening counts and cash handovers keep their existing D1 checkpoint commands. The authoritative expected-versus-actual close contract applies to the night/closing phase because frozen evidence does not prove a FeedMe expected snapshot for the opening or handover checkpoints.

Completion is proven only when the current authoritative record is `completed` and retains staff actuals, expected snapshot provenance, server-derived variance, review, and correction history. FeedMe load, Sheet delivery, zero variance, or a browser submit click alone is not completion.

## Access and offline behavior

Every human command reads the current D1 `User` row at acceptance time and fails closed if it is absent, inactive, non-human, missing the required capability, or no longer assigned to the outlet. Existing role defaults preserve current operations; an explicit `capabilities_json` value is authoritative and can revoke all cash-close capability.

The device outbox stores a stable mutation ID. A retry with the same fingerprint replays the original result. The same ID with a different body is rejected. Submission locks serialize one outlet/date/phase close so concurrent submit/review commands cannot create competing completion facts. A queued device record remains provisional until these server checks pass.

## Storage and migration lineage

The contract uses the existing generic JSON payload model in `ops_records`, receipts in `ops_mutations`, mirror intents in `sheet_sync_outbox`, and leases in `ops_submission_locks`. No D1 migration is required.

The read-only production audit on 2026-08-31 confirmed these applied D1 migrations:

- `0001_realtime_core.sql`
- `0002_submission_locks.sql`
- `0002_local_auth.sql`

All audit queries reported `changes=0`, `rows_written=0`, and `changed_db=false`.

## Isolation

Cash Close writes only `CashExpectedBasis` and `CloseUp` business entities plus generic mutation/mirror receipts. It does not create or update Supplier Payment, Supplier Invoice, Payment Allocation, General Ledger Journal, bank deposit, inventory reconciliation, or document-capture truth.
