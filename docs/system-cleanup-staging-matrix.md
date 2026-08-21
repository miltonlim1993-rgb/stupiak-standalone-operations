# OPS Full-System Cleanup — Staging Acceptance Matrix

Status: **ACTIVE CLEANUP / STAGING ONLY**

Production is not the test environment. All cleanup acceptance happens on `stupiaks-ops-staging` with synthetic data before any production release decision.

## Hard rules

1. Structured operational state: Cloudflare D1 only.
2. Operational media: Cloudflare R2 primary.
3. Realtime transport: Durable Objects.
4. Browser/client role checks are UX only; authorization must be enforced server-side.
5. No staff operational request may silently fall back to Google Sheets.
6. Google Sheets may remain only as explicitly documented master/config or downstream reporting/mirror compatibility while those areas are being migrated.
7. A D1 commit must not depend on Google success.
8. Unknown/retired legacy API routes must fail closed rather than execute old Sheet code.
9. Staging has no production Queue, no production D1/KV/R2, no Google runtime credentials, no Statvara side effects, and no production business rows.
10. No cleanup batch moves toward production until it passes staging build/runtime/permission checks and manual UI acceptance.

## Page / domain matrix

| Area | Current canonical runtime | Legacy / compatibility still present | Staging acceptance target | Status |
|---|---|---|---|---|
| Login / session | D1 directory + local auth/session | Old auth implementation remains physically in `index.js` but is pre-empted | Login/logout/me/profile; no Sheet lookup | READY TO TEST |
| Users / access | D1 directory | Old User generic/auth bodies remain unreachable | Owner access changes enforced server-side | READY TO TEST |
| Outlets | D1 directory | Master/config pack still contains outlet presentation data | Same outlet IDs resolve consistently | READY TO TEST |
| Dashboard | Mixed consumers | Must audit every tile/query | No operational tile reads Sheet | AUDIT |
| Tasks | Published KV App Pack + D1 Task/TaskPhoto + R2 | Old bootstrap/action/ensure implementations remain physically in `index.js`; fenced | Generate task, start/save/complete, photo, concurrency, permissions | READY TO TEST |
| Stock Count | D1 atomic batch | Old Sheet stock handler remains physically present but canonical route pre-empts it | Create/update/history/duplicate-submit behavior | READY TO TEST |
| Urgent Issues | D1 realtime entity + R2 media path | Master MediaRule compatibility | Create/update/resolve/media; no Sheet write fallback | READY TO TEST |
| Close Up | D1 record | Yearly Sales report is external reporting compatibility; old Sheet handler remains physically present | D1 save succeeds; staging external sync is blocked | READY TO TEST |
| Notifications | Dedicated D1 API | Old Sheet Notification API remains physically present but fenced | Push/list/read/recipient authorization | READY TO TEST |
| Attendance | D1 + atomic roster import | Old Sheet import body remains physically present but fenced | Roster replace, attendance reads, source upload, idempotency | READY TO TEST |
| Receipts | D1 realtime entity | Statvara sync remains separate external integration | CRUD/read without external sync | READY TO TEST |
| Inventory runtime | D1 operational records where migrated | InventoryCatalog / OutletStockList are still master/config compatibility | Separate operational movement model from catalog configuration | AUDIT / MIGRATE |
| Inventory configuration | Master/config compatibility | Google Sheet/App Pack source | Admin-only; no staff operational write through Sheet | AUDIT / MIGRATE |
| Labels — records | D1 FoodLabel / LabelPrintLog + R2 as needed | Old label bodies remain physically present | Create/reprint/source traceability/permissions | READY TO TEST |
| Labels — catalog/rules | Published config / compatibility source | LabelProduct / LabelRule master source still needs final migration decision | Catalog works without staff-time Google request | AUDIT |
| Printer profiles | D1 label router | Old generic implementation remains physically present | CRUD restricted correctly | READY TO TEST |
| Training progress / attempts | D1 realtime entities | Course/SOP definitions remain App Pack master/config | Progress/ack/attempt writes D1 only | READY TO TEST |
| SOP / Training content | Published App Pack | Master/config build still Google-backed outside staff runtime | Staff reads published pack only | READY TO TEST |
| Data Package / App v4 | Published KV App Pack | Rebuild path remains admin/master process | Client GET never performs live Sheet read | READY TO TEST |
| Files / media | R2 primary; Drive optional backup in production | Legacy function names still mention Drive | Upload/download works with R2; staging never calls Drive | READY TO TEST |
| Reports / Audit | Not fully classified | Potential legacy Sheet/reporting dependencies | Inventory every report source and migrate operational reports to D1 | AUDIT |
| Settings | Mixed | Master/config generic entity mutations remain | Split runtime security settings from business configuration | AUDIT / MIGRATE |
| Ops Control | Server authorization + task policy controls | Some config remains master sourced | Owner-only UI and server-side denial for non-owner | READY TO TEST |
| Statvara integration | Explicit external integration | `index.js` integration handler | Disabled in staging; production integration reviewed separately | ISOLATED |
| Google Sheet mirror/reporting | Downstream only where retained | Historical direct Sheet code still physically exists in `index.js` | No operational success depends on it | AUDIT / RETIRE |
| Legacy `index.js` | Compatibility-only target | Still physically large and contains dead operational handlers | Shrink to explicit compatibility allowlist, then retire | IN PROGRESS |

## Cleanup order from here

### C1 — Runtime reachability lock
- Build an explicit allowlist for the remaining `index.js` compatibility routes.
- Fail closed for every unknown legacy API path.
- Add tests proving already-canonical routes cannot reach `index.js`.

### C2 — Physical dead-code removal
- Remove old Auth/User/Outlet bodies.
- Remove old Task bootstrap/action/ensure bodies.
- Remove old Notification bodies.
- Remove old Attendance/Stock/Close Up operational bodies.
- Remove imports that existed only for those dead handlers.

### C3 — Master/config separation
- Inventory `InventoryCatalog`, `OutletStockList`, `TaskTemplate`, `TaskTemplatePhoto`, `PaymentMethod`, `PositionMaster`, `AppSetting`, `MediaRule`, SOP/Training definitions, `LabelProduct`, and `LabelRule`.
- Keep published App Pack as staff read boundary.
- Move admin mutations to explicit server-side configuration APIs; do not let generic Sheet CRUD remain the long-term engine.

### C4 — Reporting / audit
- Inventory every Reports page request and AuditLog dependency.
- Operational reports read D1.
- External/yearly exports remain derived outputs only.

### C5 — External integrations
- Keep FeedMe/POS identifiers out of OPS identity.
- Keep Statvara integration behind explicit integration endpoints.
- Keep Google Drive as optional media backup only.
- Keep Google Sheets as explicit downstream reporting/mirror or temporary master source only.

### C6 — `index.js` retirement
Completion means the canonical Worker no longer imports a general-purpose legacy application fallback. Any retained Google/admin/report adapter must be narrow, named, separately authorized, and impossible to reach from unrelated staff APIs.

## Staging pass criteria

A cleanup batch passes only when all are true:

- `npm ci`
- Web build succeeds.
- Worker dry-run succeeds.
- Existing runtime contract tests succeed.
- Staging package dry-run succeeds.
- `/api/staging/info` says `environment=staging`, `production=false`, `external_side_effects=false`.
- Synthetic Owner login succeeds.
- Relevant page can be exercised manually on the staging URL.
- No production Worker/D1/KV/R2/Queue/Sheet resource is referenced by the staging Wrangler config.
- No production deploy or migration ran as part of the acceptance.
