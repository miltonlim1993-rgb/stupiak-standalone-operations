import fs from 'node:fs'
import assert from 'node:assert/strict'

const entry = fs.readFileSync('worker/src/entry-master-watch.js', 'utf8')
const config = JSON.parse(fs.readFileSync('worker/wrangler.production.example.jsonc', 'utf8'))
const deploy = fs.readFileSync('scripts/deploy-master-watch-now.sh', 'utf8')
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'))

assert.equal(config.main, 'src/entry-master-watch.js')
assert.ok(config.triggers?.crons?.includes('*/2 * * * *'))
assert.ok(config.triggers?.crons?.includes('0 * * * *'))

assert.match(entry, /policy:\s*'drive-modified-time-v1'/)
assert.match(entry, /master_data_watch/)
assert.match(entry, /state_available/)
assert.match(entry, /published_at/)
assert.match(entry, /async fetch\(request, env, ctx\)/)
assert.match(entry, /async scheduled\(event, env, ctx\)/)

assert.match(deploy, /src\/entry-master-watch\.js/)
assert.match(deploy, /MASTER_WATCH_FIRST_PUBLISH_CONFIRMED=true/)
assert.match(deploy, /FORMAL_TASK_TESTING_READY=true/)
assert.match(deploy, /D1_MIGRATION_RUN=false/)
assert.doesNotMatch(deploy, /wrangler d1 execute/)
assert.doesNotMatch(deploy, /migrations apply/)
assert.doesNotMatch(deploy, /run-approved-backfill/)
assert.doesNotMatch(deploy, /ops:backfill:run/)
assert.doesNotMatch(deploy, /build-safe-backfill/)

assert.equal(pkg.scripts['ops:deploy:verified'], 'bash scripts/deploy-master-watch-now.sh')

console.log('MASTER_WATCH_DEPLOY_CONTRACT_OK=true')
console.log('PRODUCTION_ENTRY=src/entry-master-watch.js')
console.log('MASTER_WATCH_HEALTH_MARKER=true')
console.log('MASTER_WATCH_FIRST_PUBLISH_REQUIRED=true')
console.log('D1_MIGRATION_RUN=false')
console.log('D1_DIRECT_WRITE_RUN=false')
