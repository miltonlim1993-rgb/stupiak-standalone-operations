# Static Asset Worker Routing

## Purpose

The OPS Worker Free-tier quota is for Worker invocations, while Cloudflare static asset requests are free and unlimited when they are served directly. The previous production configuration used `assets.run_worker_first: true`, which forced the Worker script to run before every matching static asset request.

This phase changes routing so only canonical API traffic runs Worker-first:

```json
"run_worker_first": [
  "/api",
  "/api/*"
]
```

The same contract is applied to both the root Wrangler configuration and the canonical production Wrangler template.

## Runtime behavior

`worker/src/entry.js` already has a clean split:

- `/api` and `/api/*` are handled by the Worker API router.
- all other requests fall through to `env.ASSETS.fetch(request)`.
- `not_found_handling: "single-page-application"` remains enabled for the React SPA.

With selective Worker-first routing, static files such as the HTML shell, JavaScript chunks, CSS, icons and release assets can be served by Cloudflare's asset layer without consuming a Worker invocation. API calls still reach the Worker before SPA fallback.

## Quota-failure behavior

This routing also improves degraded-mode availability. With blanket `run_worker_first: true`, a Free-tier Worker quota exhaustion can prevent a matching static asset from being served because the request is forced through the Worker first. With API-only routing, static application assets are no longer coupled to Worker request quota availability.

This does not make API data available during a Worker quota event. The device cache, Task snapshot, outboxes, request budget and Worker pressure circuit remain responsible for degraded operational behavior.

## Safety contract

The static contract test requires:

- `run_worker_first` is an array, never boolean `true`;
- the exact Worker-first paths are `/api` and `/api/*`;
- SPA not-found handling remains enabled;
- the `ASSETS` binding remains configured;
- `entry.js` continues to route canonical API paths into Worker logic and non-API requests to `env.ASSETS.fetch`.

No D1 migration, D1 backfill, Google Sheet mutation or production deployment is part of this source change.
