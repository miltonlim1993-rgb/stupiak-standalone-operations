# Device Outbox and Batch Sync

## Purpose

OPS uses Cloudflare D1 as the canonical structured runtime database and Cloudflare R2 as canonical media storage. Google Sheets is a downstream mirror/backup surface only.

The device outbox reduces Worker request pressure and protects user-entered realtime mutations when the network or Cloudflare is temporarily unavailable. The persistent read cache reduces repeated D1/Worker reads while keeping D1 authoritative.

## Generic realtime write path

For migrated realtime entities:

1. Build a stable idempotent mutation with `mutation_id`.
2. Persist the mutation to the browser/device IndexedDB outbox before network delivery.
3. When online, coalesce mutations for a short window and POST them to `/api/realtime/mutations/batch`.
4. The client sends at most 50 mutations per request; the server rejects batches larger than 100.
5. The Worker applies each mutation through the existing canonical D1 mutation handler so permissions, optimistic concurrency, mutation replay, D1 record writes, audit mutation rows, and Sheet outbox creation remain unchanged.
6. Successful mutations are removed from the device outbox only after the Worker confirms the D1 commit.
7. Transient failures remain in the device outbox and retry with bounded client-side exponential backoff.

The batching layer reduces HTTP Worker invocations. It does not convert many logical records into one D1 record and does not weaken per-record auditability.

## Specialized operation write path

Operational Task actions, StockCount batch saves, and CloseUp upserts keep their existing Worker endpoints and domain validation, but the client now places the full operation in a separate authenticated IndexedDB outbox before attempting the HTTP request.

- Task: `/api/tasks/operational/action`
- Stock Count: `/api/stock-counts/batch`
- Close Up: `/api/close-up/upsert`

Every staged request gets a stable `mutation_id` that is reused in the request body and `X-ChefOps-Mutation-Id` header. The server's existing idempotency/replay behavior therefore remains authoritative when a device retries after a timeout, Worker quota interruption, network loss, or application restart.

Pending Task autosaves for the same Task are coalesced on-device by item patch. Pending StockCount saves for the same outlet/date are coalesced by stock-list item. Pending CloseUp saves for the same event are replaced with the latest draft. Coalescing only applies while the operation is still waiting on the device; after D1 confirms a commit, a later user action receives a new mutation identity.

Transient network, 408, 425, 429, and 5xx failures remain queued with bounded exponential backoff. Permanent validation, permission, or conflict failures remain on the device as `needs_attention` instead of retrying forever or being reported as a successful D1 commit.

The staff-facing device sync indicator uses four states:

- `Saved on device` / `已保存在设备 · 待同步`
- `Syncing` / `正在同步`
- `Synced` / `已同步`
- `Needs attention` / `需要处理`

A queued operation is not described as D1-synced until the Worker returns a successful canonical commit.

## Operational Task snapshot fallback

The assembled Operational Task bootstrap response is stored in a separate identity/outlet/date IndexedDB snapshot. If the Worker is temporarily unreachable, a previously loaded Task workspace can reopen from that device snapshot. Queued Task patches update the snapshot immediately; later canonical commits reconcile the same Task snapshot.

This fallback does not make the device authoritative. D1 remains the source of truth, and server-side Task time windows, completion validation, permissions, photo requirements, and optimistic concurrency still run when the queued operation reaches the Worker.

## Identity safety

New outbox rows include the cached authenticated user identity key. Automatic background flush only sends rows owned by the current cached identity. This prevents newly queued work from being silently replayed under a different login on a shared device.

The persistent read cache is scoped to the authenticated identity plus access fingerprint, outlet and entity. A role or outlet-access change therefore moves reads to a different cache scope. Logout and explicit 401/403 auth loss clear the persistent realtime read cache from the device.

Legacy outbox rows created before identity scoping have no actor key and retain the previous compatibility behavior.

## TaskPhoto exception

TaskPhoto continues to use the existing direct upload/confirmation path. Image bytes and media acknowledgement have different durability requirements from small JSON mutations and are not placed into either JSON operation outbox.

## Google Sheet behavior

Google Sheet mirroring happens only after canonical D1 mutation persistence. Sheet failure must never undo or block the D1 commit. The D1 `sheet_sync_outbox` remains the single bounded retry owner for Sheet backup work.

Realtime staff reads from the device cache use D1-only `/api/realtime/records` requests with `legacy_seed=0`. A staff read must not cause Sheet bootstrap, migration or hydration.

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

The next planned slice is to review high-frequency non-realtime endpoints such as notifications, bootstrap and status calls separately, then apply bounded caching only where their domain semantics permit it.

## No migration

These device outbox, specialized-operation outbox, Task snapshot and read-cache phases require no D1 schema migration and no historical backfill.
