# OPS Canonical Runtime Source Map

Status: **P0-0 in progress**  
Branch: `cleanup/legacy-runtime-safety`  
Production deployment from this branch: **forbidden**

## Frozen runtime rule

For staff-facing operational work, the accepted direction is:

```text
Web / PWA / Android
        |
        v
Authenticated Worker API
        |
        +--> server-side authorization
        |
        +--> D1 operational record / directory
        |       |
        |       +--> mutation journal
        |       +--> durable outbox
        |       +--> realtime event
        |
        +--> R2 media where applicable
        |
        +--> Durable Object realtime transport
        |
        +--> Queue asynchronous side effects
                    |
                    +--> Google Sheet mirror/reporting
```

Google Sheets are **not** allowed to decide whether an operational save succeeds. A successful D1 commit remains successful if a Sheet mirror or report update fails.

## Operational domains already canonical

| Domain | Canonical runtime | Legacy Sheet fallback |
|---|---|---|
| Auth / current user | D1 directory + signed session | blocked |
| User / Outlet access | D1 directory | blocked |
| Operational Task bootstrap | Published Task App Pack + D1 | blocked |
| Operational Task action | D1 | blocked |
| Task evidence photo record | D1 | blocked |
| Task evidence media | R2 | no Drive/Sheet authority |
| Stock Count batch | D1 | blocked |
| Attendance roster import | D1 | blocked |
| Close Up record | D1 | blocked |
| Notification list/push/read | D1 | blocked |
| Food Label runtime | D1 | blocked on dedicated routes |
| Printer Profile runtime | D1 | blocked on dedicated routes |
| Realtime mutation/read API | D1 | staff hydration forced off |
| Realtime WebSocket | Durable Object | n/a |
| Operational media upload | R2 | n/a |

## Generic entity compatibility URLs

Old UI code may still call a generic URL such as:

```text
GET /api/entities/UrgentIssue
GET /api/entities/Receipt
GET /api/entities/TrainingProgress
```

For migrated operational entities these URLs are now a **URL compatibility layer only**. `realtime-generic-entity-read-d1.js` reads `ops_records` directly and applies server-side read permission and outlet/user scope. It does not import `sheets.js`, call `listRecords`, or trigger legacy hydration.

Generic operational `POST`, `PATCH`, and `DELETE` requests are not permitted to fall through to the historical Sheet entity handler. Writers must use `/api/realtime/mutations` or a dedicated D1 workflow route.

## Sheet mirror and reporting that intentionally remain

### D1 Sheet outbox

`sheet_sync_outbox` is a downstream side-effect mechanism. D1 owns retry scheduling. Queue delivery and Google failure do not make Google authoritative.

### Close Up yearly Sales reporting

The yearly Sales integration remains because it updates reporting structures such as `_RelationDaily` and `_CashShiftLog`, and may create the year's reporting workbook from a template. This is a reporting side effect sourced from the canonical D1 Close Up record, not a second operational database.

Do not delete this integration merely because it contains Google Sheet or FeedMe-named fields. First separate OPS outlet identity from POS/report identifiers.

## Master/configuration compatibility temporarily retained

The following content can remain Sheet/App-Pack sourced while P0-0 is still in progress because it is configuration/reference data rather than staff operational transaction truth:

- InventoryCatalog
- OutletStockList
- TaskTemplate / TaskTemplatePhoto
- PaymentMethod
- PositionMaster
- AppSetting
- MediaRule
- SOP / SOPStep / SOPAsset
- TrainingCourse / TrainingLesson / TrainingQuiz / TrainingQuestion
- LabelProduct / LabelRule

This is **not** permission to let ordinary staff reads trigger Sheet bootstrap/hydration. Published App Packs should be preferred for staff-facing reference reads where available.

## Retired or disconnected runtime

The canonical entry no longer relies on:

- D1 directory bootstrap/import/hydration during normal runtime
- `/api/internal/d1-directory/migrate-once`
- `realtime-workflows.js` as a fallback owner for Task/Stock/Close Up
- `index.js scheduled()` as a second retry/publishing owner
- generic REALTIME Sheet writes
- legacy Close Up fallback after a D1 miss
- legacy dedicated Notification Sheet API
- legacy Sheet Operational Task bootstrap

Historical source may remain temporarily in `index.js` while we prove reachability and remove it safely. **Presence in the file does not mean it is still an accepted runtime path.**

## Remaining P0-0 audit

1. **`/api/tasks/ensure`** — prove there is no live consumer, then retire or replace it with D1-only behavior.
2. **Remaining `index.js` routes** — classify every reachable route as:
   - canonical external integration,
   - temporary Master/config compatibility,
   - or dead legacy runtime.
3. **Master/config mutations** — keep manager/owner authorization server-side and plan a separate migration order instead of mixing them into operational cleanup.
4. **FeedMe-named Sales registry fields** — replace OPS identity dependency with canonical `outlet_id` / Outlet Code while retaining POS/report mapping as an integration attribute.
5. **Physical deletion** — delete large legacy implementations only after the canonical route tests prove they are unreachable; do not rewrite the giant `index.js` in one risky edit.

## Hard acceptance gates

P0-0 is not complete unless all are true:

- No staff read can invoke Sheet bootstrap, hydration, or import.
- No operational write depends on Sheet success.
- Already-canonical routes fail explicitly rather than falling back to Sheet code.
- Authorization and outlet/object scope are server-side.
- D1 mutation idempotency / journal / outbox semantics remain intact.
- R2 remains canonical for operational media.
- Existing Web/PWA/Android workflows remain compatible.
- No production deploy, D1 migration, or D1 backfill occurs from the cleanup branch.
- CI architecture contract and Worker dry-run pass before any merge decision.
