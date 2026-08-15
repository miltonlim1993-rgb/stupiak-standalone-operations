import assert from 'node:assert/strict'
import fs from 'node:fs'

function config(path) {
  return JSON.parse(fs.readFileSync(path, 'utf8'))
}

const rootConfig = config('wrangler.jsonc')
const productionTemplate = config('worker/wrangler.production.example.jsonc')
const entrySource = fs.readFileSync('worker/src/entry.js', 'utf8')

function assertApiOnlyWorkerFirst(name, value) {
  assert(Array.isArray(value), `${name}: run_worker_first must be a selective route list`)
  assert.deepEqual(value, ['/api', '/api/*'], `${name}: only canonical /api traffic may run Worker-first`)
  assert(!value.includes('/*'), `${name}: blanket Worker-first routing is forbidden`)
}

assertApiOnlyWorkerFirst('wrangler.jsonc', rootConfig.assets?.run_worker_first)
assertApiOnlyWorkerFirst('worker/wrangler.production.example.jsonc', productionTemplate.assets?.run_worker_first)

assert.equal(rootConfig.assets?.not_found_handling, 'single-page-application')
assert.equal(productionTemplate.assets?.not_found_handling, 'single-page-application')
assert.equal(rootConfig.assets?.binding, 'ASSETS')
assert.equal(productionTemplate.assets?.binding, 'ASSETS')

assert.match(entrySource, /function isApiPath\(pathname\)/)
assert.match(entrySource, /pathname === '\/api' \|\| pathname\.startsWith\('\/api\/'\)/)
assert.match(entrySource, /if \(isApiPath\(url\.pathname\)\)/)
assert.match(entrySource, /return env\.ASSETS\.fetch\(request\)/)

console.log('STATIC_ASSET_WORKER_ROUTING_TEST_OK=true')
console.log('STATIC_ASSETS_BYPASS_WORKER=true')
console.log('API_WORKER_FIRST_PATHS=/api,/api/*')
console.log('SPA_NOT_FOUND_HANDLING_PRESERVED=true')
console.log('WORKER_FIRST_ALL_REQUESTS=false')
