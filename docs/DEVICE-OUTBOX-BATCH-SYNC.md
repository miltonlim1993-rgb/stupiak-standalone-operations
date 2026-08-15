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

## Global request budget

Always-mounted UI managers previously requested the same operational data on short independent timers. In a single-outlet session this included current/future Operational Task bootstraps, Duty Roster reads, training assignments/progress, unread notifications, Data Pack manifest checks and Android release checks. Multiple open devices could therefore multiply otherwise small polling loops into a large Worker request total.

`global-request-budget.js` is installed after the specialized operation client and before React global managers mount. It bounds only repeatable read/check traffic:

- automatic Operational Task bootstrap responses are reused for up to 10 minutes per authenticated user, outlet and business date;
- Attendance, TrainingAssignment and TrainingProgress list/filter results are reused for up to 10 minutes and are invalidated by matching realtime/mutation events;
- unread Notification lists are reused for up to 5 minutes and invalidated after read, push or realtime Notification activity;
- timestamp-busted Data Pack manifest GETs are normalized and a successful response is reused for up to 10 minutes;
- `app-release.json` is reused for up to 5 minutes;
- a hidden tab may continue using its last successful cached read instead of performing background Worker traffic;
- reconnect clears authenticated operational read-budget entries so the next online pass revalidates.

A recent explicit pointer/touch/keyboard interaction bypasses the relevant read budget. This keeps user-triggered refresh/navigation responsive while background timers are bounded.

The budget deliberately does **not** cache or delay `/api/auth/me`, operational mutation endpoints, StockCount/CloseUp writes, TaskPhoto registration, file uploads or other write paths. A 401/403 from a budgeted method is never replaced by cached authenticated data.

The static contract records the following theoretical fallback ceilings when there are no explicit user refreshes or realtime invalidations:

- Task bootstrap: 144 network checks/day for each user + outlet + date key;
- Notification list: 288 network checks/day for each authenticated user;
- Data Pack manifest: 144 network checks/day for each normalized manifest key.

Runtime counters are exposed at `window.__chefopsRequestBudget` so production request/cache-hit behavior can be compared against Cloudflare metrics without adding a new telemetry request.

## Worker pressure circuit breaker

The request budget reduces normal traffic, but a quota/rate-limit or temporary Worker failure still needs a second safety layer so multiple open devices do not keep retrying an already unhealthy Worker.

`worker-pressure-circuit.js` records only canonical OPS Worker failures. It persists a small circuit state in local storage so reloading the page or reopening the PWA does not immediately restart a request storm.

The circuit opens immediately for 408, 425, 429, 502, 503 or 504 responses. Other selected 5xx responses require two failures inside a two-minute window. Authentication failures 401/403 never open the circuit.

When open, the cooldown expands from 5 minutes to 10, 20 and finally 30 minutes. Automatic GET reads to the canonical OPS Worker are deferred while the circuit is open. `/api/auth/*`, media/file GETs and the realtime stream are excluded. POST/PUT/PATCH/DELETE writes are never blocked by this read circuit; operational writes continue through their device-first outbox/retry contracts.

Operational Task bootstrap is a read-like POST and is handled separately: while the circuit is open it reuses the in-memory Task result or the authenticated IndexedDB Task snapshot instead of calling the Worker. The returned Task snapshot is marked `worker_pressure_deferred` and is not described as a canonical D1 commit.

A visible explicit user action may make one recovery probe at most once per minute. A successful canonical Worker probe closes the circuit. Continued failure reopens/extends the cooldown. Hidden tabs do not probe.

The shell displays `Server busy · cached` while the circuit is open, distinguishing this state from true device offline mode. Runtime state is available without extra network telemetry at `window.__chefopsWorkerPressure`, while request-budget counters continue at `window.__chefopsRequestBudget`.

The circuit intentionally does not treat failures from external services such as GitHub release metadata as OPS Worker pressure. Canonical Worker detection follows `opsClient.apiBaseUrl`, which also preserves the behavior when the Android shell uses a different local origin.

## Follow-up slices

The next planned slice is production activation and controlled measurement: deploy the merged request-budget/circuit changes through the trusted production deployment path, confirm the production build marker, then compare Cloudflare request rate and local cache/defer counters over a fixed observation window. Any remaining high-frequency endpoint should be isolated before adding more caching.

## No migration

These device outbox, specialized-operation outbox, Task snapshot, read-cache, global request-budget and Worker pressure-circuit phases require no D1 schema migration and no historical backfill.
