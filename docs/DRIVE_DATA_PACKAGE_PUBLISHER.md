# Drive Data Package Publisher

## Purpose

The publisher converts Google-authored Task, SOP/Training, Stock and Food Label configuration into an immutable Stupiak's Ops Data Package v2 release.

Google Sheet and the original Google Drive folders are authoring sources only. Staff devices install a verified release and use local IndexedDB/Blob storage for stable configuration and media.

## Storage layout

The configured published-package folder is separate from operational uploads and source documents.

```text
Stupiaks Ops Published Packages/
└── RR-KCH/
    └── media/
        ├── <sha256>.jpg
        ├── <sha256>.png
        ├── <sha256>.mp4
        └── <sha256>.pdf
```

Cloudflare KV stores:

- immutable module objects;
- versioned manifests;
- latest release pointer;
- release history;
- dirty state;
- media hash to published Drive file ID index.

The published Drive folder stores only content-addressed media files. Original filenames and source IDs remain traceability metadata, not runtime lookup keys.

## Required local environment variables

Keep these values in the local `.dev.vars` file or shell environment. Never commit real values.

```dotenv
GOOGLE_DATA_CLIENT_ID=
GOOGLE_DATA_CLIENT_SECRET=
GOOGLE_DATA_REFRESH_TOKEN=
GOOGLE_PUBLISHED_PACKAGE_FOLDER_ID=
APP_PACK_WEBHOOK_SECRET=
CHEFOPS_WORKER_URL=https://stupiaks-ops.sporkburger19.workers.dev
```

`GOOGLE_PUBLISHED_PACKAGE_FOLDER_ID` is the ID of the dedicated **Stupiaks Ops Published Packages** Drive folder.

`APP_PACK_WEBHOOK_SECRET` must match the Cloudflare Worker secret with the same name. The publisher sends it only through the `X-ChefOps-Pack-Secret` request header.

## Commands

Show help:

```bash
npm run package:publish-drive -- --help
```

Dry run:

```bash
npm run package:publish-drive -- --outlet RR-KCH --dry-run
```

A dry run:

- scans the current Google source through the Worker;
- downloads referenced media to a temporary local directory;
- calculates full SHA-256 hashes;
- checks whether identical published files already exist;
- calculates the final release version and download size;
- does not upload files;
- does not change Cloudflare `latest`;
- does not affect staff devices.

Publish:

```bash
npm run package:publish-drive -- --outlet RR-KCH
```

The publisher performs these steps:

1. Request an initial source preview.
2. Collect Task sample photos, SOP assets, training videos and course covers.
3. Download each source file once to a temporary local directory.
4. Calculate SHA-256 and byte length.
5. Reuse an existing `<sha256>.<extension>` file when available.
6. Upload only new or changed media through a resumable Drive upload.
7. Request a final preview with the media inventory.
8. Confirm that the Google source version did not change during packaging.
9. Save immutable module objects and media indexes.
10. Save the versioned manifest and history.
11. Move the Cloudflare `latest` pointer last.

If any step fails before step 11, the currently published release remains active.

## Add, replace and remove behavior

### Add

A new image or video gets a new SHA-256 filename. Only the new media and changed JSON module are downloaded by devices.

### Replace

Changed file content gets a new SHA-256 filename. Existing devices keep the old object until the new release is fully verified and activated.

### Remove

The next manifest no longer references the removed media. Devices delete unreferenced local objects during cleanup. Published Drive media can be retained for rollback and cleaned later by a separate retention job.

## Runtime behavior

Once a Data Package v2 release is installed:

- Task templates and sample photos are read from the active local release;
- SOP images and videos use local Blob URLs;
- Stock master and outlet lists use the local package;
- Food Label catalog and rules use the local package;
- missing static package data does not silently fall back to Google;
- operational submissions continue through the Worker;
- package checks and installs are explicit and never reload an active form.

## Manager controls

The app route `/data-packages` provides:

- outlet selection;
- source dirty status;
- module diff preview;
- unresolved media count;
- explicit publish for releases with no media waiting;
- device install progress;
- release history;
- Cloudflare pointer rollback.

Media releases are published by this local publisher until the same pipeline is moved into the Statvara control plane.

## Rollback

Cloudflare rollback moves only the latest pointer to an existing immutable release. It does not rebuild from Google.

Devices detect the selected release and install it using the same staging, byte verification and atomic activation flow.

## Security rules

- Never commit OAuth refresh tokens, client secrets or publisher secrets.
- Never expose the publisher secret in browser JavaScript.
- Internal publisher endpoints require `X-ChefOps-Pack-Secret`.
- Staff package endpoints still require an authenticated Stupiak's Ops session.
- Each release is outlet-scoped.
- Printer IP/Bluetooth details remain device-local and are not part of the shared package.
