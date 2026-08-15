# Device Outbox and Batch Sync

## Purpose

OPS uses Cloudflare D1 as the canonical structured runtime database and Cloudflare R2 as canonical media storage. Google Sheets is a downstream mirror/backup surface only.

The device outbox reduces Worker request pressure and protects user-entered realtime mutations when the network or Cloudflare is temporarily unavailable. The persistent read cache reduces repeated D1/Worker reads while keeping D1 authoritative.

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

The persistent read cache is scoped to the authenticated identity plus access fingerprint, outlet and entity. A role or outlet-access change therefore moves reads to a different cache scope. Logout and explicit 401/403 auth loss clear the persistent realtime read cache from the device.

Legacy outbox rows created before identity scoping have no actor key and retain the previous compatibility behavior.

## TaskPhoto exception

TaskPhoto continues to use the existing direct upload/confirmation path. Image bytes and media acknowledgement have different durability requirements from small JSON mutations and are not placed into this JSON outbox slice.

## Google Sheet behavior

Google Sheet mirroring happens only after canonical D1 mutation persistence. Sheet failure must never undo or block the D1 commit. The D1 `sheet_sync_outbox` remains the single bounded retry owner for Sheet backup work.

Realtime staff reads from the device cache use D1-only `/api/realtime/records` requests with `legacy_seed=0`. A staff read must not cause Sheet bootstrap, migration or hydration.

## Retry behavior

Device retries are intended for network failures, HTTP 401 session interruption, 408, 425, 429, and 5xx responses. Permanent validation/permission/conflict failures are surfaced instead of being retried forever.

A visible, online app periodically checks the outbox, but each failed row has `next_attempt_at`, so the 30-second check does not imply a 30-second network retry storm.

## Read path

For migrated realtime entities:

1. The first eligible read loads D1 records with deleted tombstones included and stores them in a separate IndexedDB read cache.
2. Cache entries are scoped to authenticated access identity + outlet + entity.
3. For 60 seconds, repeated list/filter calls are answered from the device without another Worker HTTP request.
4. When the cache becomes stale and already has data, the current data is returned immediately and a visible/online app refreshes in the background.
5. Background refresh calls `/api/realtime/records?since=<cursor>` with `legacy_seed=0`, then merges changed and deleted records into IndexedDB.
6. Only one refresh per scope is allowed in flight, preventing several components from issuing the same delta request simultaneously.
7. Local queued/committed mutations are merged into the device cache immediately and mark the scope stale so the next delta pass reconciles with canonical D1.
8. If a delta reaches the 5,000-row safety limit, the client falls back to a full D1 snapshot. If that snapshot is also saturated, the scope is marked incomplete rather than silently claiming complete cache coverage.

This is stale-while-revalidate behavior: D1 remains authoritative, but routine navigation and polling no longer require a network read every time.

## Follow-up slices

The next planned slices are:

1. adapt specialized operational Task action, StockCount batch, and CloseUp D1 endpoints to the same device-first durability contract without changing their domain response semantics;
2. add a staff-facing sync state such as `Saved on device`, `Syncing`, `Synced`, or `Needs attention`;
3. review high-frequency non-realtime endpoints (notifications/bootstrap/status) separately and apply bounded caching only where their domain semantics allow it.

## No migration

These device outbox/read-cache phases require no D1 schema migration and no historical backfill.
