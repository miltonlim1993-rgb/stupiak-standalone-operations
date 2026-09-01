# Payment Reconciliation authority

Slice 007 closes `LOOP-030 — Payment Reconciliation` for the migrated standalone record family. It is an evidence lifecycle, not a transaction engine.

## Frozen command mapping

- `CMD-FIN-03-146` Load expected payment totals: reuse the signed FeedMe `CashExpectedBasis` import frozen by Slice 006.
- `CMD-FIN-03-147` Enter blind actuals: bind the exact completed D1 `CloseUp` ID, version, and count identity without accepting client totals.
- `CMD-FIN-03-148` Reveal payment differences: the Worker calculates per-channel and total variance from the bound facts.
- `CMD-FIN-03-149` Record variance remarks: a current human records the decision class, explanation, and stable evidence IDs.
- `CMD-FIN-03-150` Submit payment reconciliation: move `remarks_complete` to `submitted` after current access, scope, lifecycle, and fact-version checks.
- `CMD-FIN-04-155` Backfill system snapshot: retained external input to the broader frozen loop; it cannot complete the migrated D1 reconciliation lifecycle.

Linked replacement is a narrow Slice 007 implementation command. It has no fabricated Phase 1 command ID. It preserves the original record, reason, actor, evidence, and causal link.

## Authority map

- FeedMe expected source: external input with source ID, version, watermark, observed time, and digest.
- Actual operational fact: completed D1 `CloseUp`, referenced by exact ID, D1 version, and immutable count identity.
- Payment Reconciliation: authoritative D1 evidence lifecycle for the migrated record family.
- Cash Close: independent D1 operational/custody authority from Slice 006.
- Canonical Payment and Payment Allocation: Statvara Core PostgreSQL only.
- Supplier Invoice outstanding and accounting journal: Statvara Core PostgreSQL only.
- Application: command UI and projection only.
- Google Sheet/report/cache: mirror, report, or cache only; never completion authority.
- Frappe: retained legacy authority only for explicitly unmigrated record families.

Payment Reconciliation does not create or modify canonical Payment, Payment Allocation, Supplier Invoice outstanding, accounting journals, inventory, denominations, physical cash, or Close Up lifecycle state.

## Lifecycle and correction

The exact frozen lifecycle is:

`blind_entry → differences_revealed → remarks_complete → submitted`

The completion fact is: a submitted reconciliation retains the exact expected source, exact actual evidence, server variance, remarks/evidence decision, and correction identity.

Zero variance does not create financial authority. A non-zero variance can complete only when classified as an explained discrepancy; unresolved exceptions remain open. Source or actual-fact drift never rewrites historical payloads. The current projection becomes stale and a supervisor/manager/owner may create a linked replacement against the latest facts.

## Access, retries, and offline behavior

Every command resolves the current D1 user, active status, human principal type, capability, assigned outlet, lifecycle state, resource identity, fact versions, and stable mutation fingerprint at server acceptance time. Same mutation ID plus the same fingerprint is a deterministic replay; changed payload is rejected. Scope-level D1 submission locks serialize competing mutations.

The UI does not claim authoritative offline completion. A network/device draft has no authority until the Worker reauthorizes it and commits D1. Revoked or inactive sessions fail closed.

## Schema

The existing `ops_records` and `ops_mutations` schema represents the record, immutable history, audit evidence, and idempotency journal. D1 migration count remains 3. Core schema remains 18. Slice 007 adds no D1 migration and no Core migration.
