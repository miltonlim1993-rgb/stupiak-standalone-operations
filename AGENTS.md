# OPS Repository Operating Memory

This file records stable project facts and guardrails for every future agent or maintainer working in this repository.

## Canonical production identity

- Repository: `miltonlim1993-rgb/stupiak-standalone-operations`
- Default branch: `main`
- Cloudflare Worker name: `stupiaks-ops`
- Canonical application and API origin: `https://stupiaks-ops.sporkburger19.workers.dev`
- Canonical health endpoint: `https://stupiaks-ops.sporkburger19.workers.dev/api/health`
- The Worker serves both the React SPA and `/api/*`.

Never substitute a Cloudflare Pages project, Pages preview URL, or Pages settings screen for the canonical OPS Worker above. The Cloudflare Pages project named `stupiakops` is not the production origin used by OPS staff.

## Deployment truth

There are distinct credential scopes. Do not mix them:

1. **Cloudflare Worker runtime secrets and bindings** configure the running application.
2. **Cloudflare Pages variables and secrets** belong to that Pages project/build environment.
3. **GitHub Actions secrets** are the only secrets directly available to a GitHub-hosted runner through `${{ secrets.NAME }}`.
4. **Local Wrangler OAuth** belongs to the machine where `wrangler login` was completed.

A token may genuinely exist in one scope while being unavailable in another. Never tell the user to recreate a token before identifying the scope and inspecting the actual workflow.

## GitHub deployment workflow

`.github/workflows/deploy-cloudflare.yml` is the canonical GitHub workflow.

- Relevant `main` pushes always run build and production-config validation.
- If `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` are visible to GitHub Actions, the workflow deploys `stupiaks-ops` and verifies the canonical `/api/health` endpoint.
- If those credentials are unavailable during a normal push, deployment is explicitly skipped without a misleading Wrangler authentication failure.
- A manual deployment request fails clearly when GitHub credentials are unavailable.
- Cloudflare Dashboard runtime variables cannot authenticate GitHub Actions.

A trusted Wrangler-authenticated machine may deploy with:

```bash
export CLOUDFLARE_APP_DATA_PACKS_ID="<production KV namespace ID>"
export CLOUDFLARE_MEDIA_BUCKET_NAME="stupiaks-ops-media" # optional until R2 is active
npm run cf:deploy
```

Never state that production is updated merely because code reached `main`, a build passed, Wrangler dry-run passed, or a Pages deployment succeeded. Production is complete only after the canonical health endpoint confirms the expected release behavior or marker.

## Current Task/data-package stale fix

The source on `main` contains the intended stale-aware Task/data-package behavior:

- normal employees also perform package expiry checks;
- maximum acceptable package age is `120000` ms (2 minutes);
- production verification marker: `stale-aware-v1`;
- expected health field includes `data_pack_refresh_policy: stale-aware-v1` and `pack_max_age_ms: 120000`.

Do not begin formal Task testing until the canonical production `/api/health` response confirms this marker. Until then, staff devices may still receive behavior from an older Worker deployment.

## Production verification checklist

For Worker-affecting changes:

1. Confirm the intended change exists on `main`.
2. Run the repository build and Worker checks.
3. Deploy specifically to Worker `stupiaks-ops`.
4. Query `https://stupiaks-ops.sporkburger19.workers.dev/api/health`.
5. Confirm the expected marker or behavior.
6. Only then ask the user to begin production testing.

## Change discipline

- Do not create one-off workflows that write secret-probe results into `main` unless there is no safer inspection method.
- Never expose secret values in commits, logs, documentation, or chat.
- Distinguish a missing credential from an invalid, expired, revoked, or insufficiently scoped credential.
- Keep production URL, Worker name, deployment workflow, and verification endpoint synchronized across `README.md`, `deploy/cloudflare/README.md`, and this file.
- Do not claim a deployment route was historically local OAuth, GitHub Actions, or Cloudflare Git integration without evidence from logs or configuration.
