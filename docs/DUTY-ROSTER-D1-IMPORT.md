# Duty Roster D1-first import

Last verified: 2026-08-03 (Asia/Kuching)

## Reported failure

The Duty Roster PDF parser successfully detected seven dates, eleven people and forty-four shifts, but the publish action returned `Internal server error` and the selected date remained empty.

The PDF parser was not the failing component. The old runtime used two different storage paths:

1. the browser synchronously uploaded the source PDF to Google Drive;
2. `/api/attendance/import` synchronously replaced and appended Google Sheet `Attendance` rows;
3. the Duty Roster page read `Attendance` from D1 with legacy Sheet hydration disabled.

A Drive or Sheet failure therefore returned HTTP 500, and a successful Sheet write still did not guarantee that the D1-only Duty Roster screen could read the rows.

## Canonical runtime

Duty Roster import now uses D1 as the only runtime commit:

- endpoint: `POST /api/attendance/import`;
- entity: `Attendance`;
- operation: `roster_replace`;
- imported row status: `scheduled`;
- maximum rows: 500;
- maximum selected dates: 14;
- the reported weekly PDF contains 44 rows across 7 dates.

The Worker intercepts this endpoint before the legacy `index.js` Sheet handler.

## Atomic replacement

When `replace_existing` is enabled, one D1 batch performs all of the following:

1. soft-archives active `Attendance` rows with `status=scheduled` for only the requested outlet and PDF dates;
2. upserts every normalized shift into `ops_records`;
3. writes one idempotent `ops_mutations` journal record;
4. writes one durable `sheet_sync_outbox` job.

No physical `DELETE FROM ops_records` is used.

Non-scheduled Attendance records are preserved. Other outlets and dates outside the PDF are not modified.

Each shift receives a deterministic ID derived from:

- outlet;
- date;
- normalized employee name;
- clock-in;
- clock-out.

Re-importing the same PDF therefore updates the same records instead of creating duplicates. Duplicate lines inside one parsed PDF are removed before commit.

## PDF and Sheet backup behavior

The current UI uploads the PDF before calling the import endpoint. For Duty Roster files only, the Worker now immediately returns a queued source receipt and continues the Drive upload through `waitUntil`.

A Drive upload failure cannot block the D1 roster commit.

After D1 commits, a dedicated Queue consumer mirrors the complete selected-date scheduled-roster replacement to Google Sheets. Sheet failure leaves the outbox item pending for retry and does not convert a successful D1 commit into a user-facing 500.

Other file-upload modules keep their existing synchronous behavior.

## Runtime read

The Duty Roster page already reads `Attendance` through `/api/realtime/records` with `legacy_seed=0`. Newly imported rows are therefore visible as soon as the D1 transaction completes.

## Data safety

This change does not:

- create or modify a D1 table;
- run a D1 migration;
- backfill historical Attendance;
- import old Sheet rows into D1;
- physically delete an Attendance record;
- archive non-scheduled Attendance;
- replace another outlet's roster;
- replace a date that is not present in the uploaded PDF.

## Rollback

Code rollback can restore the previous Worker revision. Existing D1 Attendance records remain available because rollback must not delete runtime data.

Scheduled rows soft-archived by a replacement remain in `ops_records` with top-level `deleted_at` metadata. A targeted recovery can restore selected IDs after read-only verification; broad automatic rollback is not allowed.

## Required verification

1. Parse the same weekly PDF and confirm 7 dates, 11 people and 44 shifts.
2. Publish with replacement enabled.
3. Confirm HTTP 201/200 reports `storage: d1`, `imported: 44`, and the expected dates.
4. Open 03/08/2026 and confirm the roster appears without waiting for Google Sheet sync.
5. Re-import the same PDF and confirm active scheduled row count does not increase beyond the 44 canonical shifts.
6. Change one shift, re-import and confirm only the selected outlet/date scheduled set is replaced.
7. Confirm non-scheduled Attendance, another outlet and dates outside the PDF are unchanged.
8. Confirm one `roster_replace` mutation and one outbox job exist for the import.
9. Allow the Queue to run and confirm the Sheet mirror reaches `synced` or remains safely `pending` with an error.
10. Confirm no migration or physical Attendance deletion occurred.
