# Read-only production fingerprint audit

This temporary file exists only to trigger the trusted CI read-only production audit before preparing a Label-only merge/release.

The audit reads public release, health, and Web bundle fingerprints. It does not deploy, use Cloudflare credentials, run migrations/backfills, or write operational data.

Retry after correcting the public JS asset path parser.

Run exact candidate bundle matching against likely production commits.

Run normalized bundle similarity and chunk identity comparison.

Retry with linear-time normalized hash and exact chunk comparison.

Compare live production against historical deployment branch heads.

Compare normalized content of every live JS chunk against representative source bases.

Inspect the remaining live main-entry delta against the pre-Label baseline.
