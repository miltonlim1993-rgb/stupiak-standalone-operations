# Device Outbox and Batch Sync

## Purpose

OPS uses Cloudflare D1 as the canonical structured runtime database and Cloudflare R2 as canonical media storage. Google Sheets is a downstream mirror/backup surface only.

The device outbox reduces Worker request pressure and protects user-entered realtime mutations when the network or Cloudflare is temporarily unavailable.

## Write path

For migrated realtime entities:

1. Build a stable idempotent mutation with `mutation_id`.
2. Persist the mutation to the browser/device IndexedDB outbox before network delivery.
3. When online, coalesce mutations for a short window and POST them to `/api/realtime/mutations/batch`.
4. The client sends at most 50 mutations per request; the server rejects batches larger than 100.
5. The Worker applies each mutation through the existing canonical D1 mutation handler so permissions, optimistic concurrency, mutation replay, D1 record writes, audit mutation rows, and Sheet outbox creation remain unchanged.
6. Successful mutations are removed from the device outbox only after the Worker confirms the D1 commit.
7. Transient failures remain in the device outbox and retry with bounded client-side exponential backoff.

The batching layer reduces HTTP Worker invocations. It does not convert many logical records into one D1 record and does not weaken per-record auditability.

## Identity safety

New outbox rows include the cached authenticated user identity key. Automatic background flush only sends rows owned by the current cached identity. This prevents newly queued work from being silently replayed under a different login on a shared device.

Legacy outbox rows created before identity scoping have no actor key and retain the previous compatibility behavior.

## TaskPhoto exception

TaskPhoto continues to use the existing direct upload/confirmation path. Image bytes and media acknowledgement have different durability requirements from small JSON mutations and are not placed into this JSON outbox slice.

## Google Sheet behavior

Google Sheet mirroring happens only after canonical D1 mutation persistence. Sheet failure must never undo or block the D1 commit. The D1 `sheet_sync_outbox` remains the single bounded retry owner for Sheet backup work.

## Retry behavior

Device retries are intended for network failures, HTTP 401 session interruption, 408, 425, 429, and 5xx responses. Permanent validation/permission/conflict failures are surfaced instead of being retried forever.

A visible, online app periodically checks the outbox, but each failed row has `next_attempt_at`, so the 30-second check does not imply a 30-second network retry storm.

## Read path

This change does not yet persist a full local read cache. The existing D1 realtime records endpoint already supports `since`, which is the basis for the next slice:

- show last known device cache immediately;
- request only D1 records changed since the last sync cursor;
- merge changed/deleted rows locally;
- use WebSocket events as invalidation/realtime hints, not as the only source of truth.

## Follow-up slices

The next planned slices are:

1. adapt specialized operational Task action, StockCount batch, and CloseUp D1 endpoints to the same device-first durability contract without changing their domain response semantics;
2. add persistent delta-read cache and sync cursor;
3. show a staff-facing sync state such as `Saved on device`, `Syncing`, `Synced`, or `Needs attention`.

## No migration

This phase requires no D1 schema migration and no historical backfill.
