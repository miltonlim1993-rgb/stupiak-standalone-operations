# Task overlap, photo capacity and staff access policy

Last verified: 2026-08-03 (Asia/Kuching)

## Canonical daily opening task

The Master Sheet previously published two overlapping daily tasks for the same 10:00–17:30 operating window:

- `tmpl-rr-opening-checklist-v3` — Opening Preparation Check
- `tmpl-rr-daily-standards-v4` — Daily Operations Standards Check

The canonical task is now:

- **Retained:** `tmpl-rr-opening-checklist-v3`
- **Retired from future generation and hidden from runtime lists:** `tmpl-rr-daily-standards-v4`

The retired template is set to `is_active = FALSE` in `Stupiak's Ops Master > TaskTemplates`. Existing historical `Task` records are not deleted or rewritten. Runtime bootstrap applies the same policy so cached or previously created duplicate tasks do not appear beside the retained task.

## Photo policy

Task photo groups and Urgent Issues support a maximum of **10 photos**.

Required staff guidance:

> 同类物品请放在同一张照片一起拍摄，不要逐件分开拍；最多可上传 10 张。
>
> Photograph matching items together in one frame instead of taking separate photos for each item; up to 10 photos are supported.

Authoritative Master Sheet updates:

- `TaskTemplates!AD5`: every Opening Preparation photo group has `max_photos = 10`.
- `MediaRules` task rule: `max_files = 10`.
- `MediaRules` urgent_issue rule: `max_files = 10`.

Runtime protections:

- Worker bootstrap normalizes returned task photo groups and requirements to 10.
- The client applies the same policy as a cache-resilience fallback.
- TaskPhoto mutation validation continues to enforce the live template and MediaRule limits.
- Existing photos are not deleted, re-uploaded or overwritten.

## Role access

Authenticated users at `staff` level and above retain direct access to:

- Daily Tasks and checklists (`/tasks`)
- SOP and Training Academy (`/training` and `/sop/:sopId`)
- Normal outlet execution modules allowed by their assigned outlet

The sensitive management route remains restricted:

- Ops Control (`/ops-control`) requires `manager` level or above.

This restriction protects assignment, access and management controls without hiding daily execution and learning modules from staff, leaders or supervisors.

## Data safety

This policy does not:

- run a D1 migration;
- backfill D1;
- delete historical Tasks or TaskPhotos;
- overwrite completed Task responses;
- import Sheet history into D1;
- broaden outlet assignment access.

## Verification

1. Open Tasks for RR-KCH on the same business date.
2. Confirm only Opening Preparation Check appears; Daily Operations Standards Check is absent.
3. Open a photo group and confirm the UI states 10-photo support and grouping guidance.
4. Upload photos 1 through 10; photo 11 must be rejected.
5. Open Urgent Issues and confirm the same 10-photo capacity and grouping guidance.
6. Sign in as `staff`, `leader` and `supervisor`; Tasks, Training and SOP must open.
7. Attempt `/ops-control` as those roles; the app must redirect to `/tasks`.
8. Sign in as `manager` or above; `/ops-control` must remain available.
