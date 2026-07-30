console.error(`
❌ Task Template v3 migration is already superseded by the active V4 cleaning templates.

Do not re-run tasks:v3:apply. Reapplying V3 would reactivate the legacy V3 Quick Check
and conflict with Toilet Hygiene Quick Check V4.

Use the read-only Task source audit and the locked Data Package RC workflow instead.
`)
process.exitCode = 1
