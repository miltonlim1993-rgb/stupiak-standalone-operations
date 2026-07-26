# Stupiak's Ops Data Package v2

## Purpose

Google Sheets and Google Drive are authoring sources only. Outlet devices must run from a published, immutable package stored locally. Routine Task, SOP, Stock and Food Label screens must not query Google.

## Control plane and runtime

- **Control plane:** Google/Statvara editing, package preview, publish, rollback and device status.
- **Runtime:** Stupiak's Ops APK/PWA, local package database, local media cache and dynamic submissions.
- **Dynamic records:** task execution, stock counts, close-up, attendance, receipts, issues and print logs are not part of the package.

## Package modules

| Module | Stable content |
| --- | --- |
| `core` | outlets, public app settings, payment methods, positions, media rules |
| `tasks` | task templates, instructions, shift/period rules, photo requirements, sample photos |
| `training` | SOPs, steps, assets, courses, lessons, quizzes and questions |
| `inventory` | catalog, outlet stock list, units, sections, thresholds and ordering |
| `labels` | product catalog, shelf-life rules, storage rules, templates and barcode settings |

## Manifest

```json
{
  "format": "stupiaks-ops-data-package",
  "format_version": 2,
  "release_id": "RR-KCH-20260726T163000Z-a81d3f",
  "version": "a81d3f...",
  "outlet_id": "RR-KCH",
  "published_at": "2026-07-26T08:30:00.000Z",
  "published_by": "owner@example.com",
  "previous_version": "7712bc...",
  "modules": {
    "tasks": {
      "hash": "...",
      "bytes": 54120,
      "records": 88,
      "path": "/api/app/v4/pack/module/tasks?..."
    }
  },
  "media": {
    "files": {
      "sha256:...": {
        "hash": "...",
        "kind": "image",
        "mime_type": "image/jpeg",
        "bytes": 340221,
        "source_provider": "google_drive",
        "source_id": "drive-file-id",
        "path": "/api/app/v4/pack/media/<hash>"
      }
    },
    "total_bytes": 340221
  },
  "total_bytes": 394341
}
```

## Media rules

1. Media is content-addressed by SHA-256.
2. A changed file receives a new hash; an unchanged file is reused.
3. A deleted reference is removed from the new manifest, not immediately deleted from storage.
4. Keep media referenced by the latest three releases for rollback.
5. Drive may be the initial package repository. The runtime contract must not expose raw Sheet IDs or browse source folders.
6. R2/S3 can replace Drive later without changing the app package format.

## Publish flow

1. Owner selects outlet.
2. Publisher scans source rows and referenced media.
3. Publisher normalizes data and calculates hashes.
4. Preview reports additions, changes, removals and download impact.
5. Publisher uploads only missing module/media hashes.
6. Publisher validates every reference, byte count and hash.
7. Publisher stores an immutable versioned manifest.
8. Only after validation does it atomically update the outlet `latest` pointer.
9. Devices are notified that a package is available; active forms are never remounted.

Source edits only mark a package as dirty. They do not publish automatically.

## Device install and update

1. Download latest manifest.
2. Compare module/media hashes with local stores.
3. Download missing objects into a staging release.
4. Verify SHA-256 and expected sizes.
5. Commit the complete release in one IndexedDB transaction where supported.
6. Switch the active pointer only after the staging release is complete.
7. Keep the previous active release for rollback.
8. Remove unreferenced local media after successful activation.

The current package remains usable when a download fails or the device goes offline.

## Local storage

### APK

- JSON package metadata: IndexedDB or Capacitor Preferences/SQLite.
- Images/video: app-private filesystem using content hash filenames.
- Playback/rendering resolves package media references to local file URIs.

### PWA

- Manifests/modules: IndexedDB.
- Images/video: Cache Storage or OPFS, with IndexedDB metadata.
- Request persistent storage when supported.

## Required APIs

- `GET /api/app/v4/pack/manifest?outlet_id=` — latest published manifest only.
- `GET /api/app/v4/pack/module/:name?outlet_id=&hash=` — immutable module object.
- `GET /api/app/v4/pack/media/:hash` — immutable media object or authenticated package-repository redirect.
- `POST /api/app/v4/pack/preview` — owner/manager source diff without publishing.
- `POST /api/app/v4/pack/publish` — owner/manager atomic publication.
- `GET /api/app/v4/pack/releases?outlet_id=` — release history.
- `POST /api/app/v4/pack/rollback` — point latest at a validated previous release.
- `POST /api/app/v4/device/package-state` — report installed/downloading/error state.

Legacy `rebuild` endpoints may remain temporarily but must map to explicit publish semantics and must not be called by employee devices.

## Acceptance tests

1. Disable Google Data OAuth after a package is installed: Task, SOP, Stock and Label configuration still opens.
2. Airplane mode: all downloaded text, images and videos remain available.
3. Source edits do not affect employees until Publish is pressed.
4. Publishing one changed image downloads only that image and changed module metadata.
5. Failed update leaves the prior release active.
6. Rollback activates a previous manifest without rebuilding source data.
7. An active task/checklist/stock/close-up form never refreshes because a new package exists.
8. Different outlets can run different release versions.
9. Device status shows active release, download size, media completeness and last activation time.
10. Removing a source Drive file does not break an already published and locally installed release.

## Migration phases

1. Introduce v2 local staging/activation stores while reading existing v4 modules.
2. Stop automatic package rebuilds; source changes only set dirty state.
3. Add preview, publish, release history and rollback APIs.
4. Add media inventory and local media download/cache.
5. Convert Task, SOP, Stock and Label renderers to package-only configuration reads.
6. Add Ops Control Data Packages UI.
7. Add Drive publisher and later optional R2/S3 provider.
8. Execute Google-disconnection and offline acceptance tests.
