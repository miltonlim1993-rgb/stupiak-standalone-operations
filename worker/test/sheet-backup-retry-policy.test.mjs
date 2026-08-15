import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import test from 'node:test'

async function source(path) {
  return fs.readFile(new URL(`../../${path}`, import.meta.url), 'utf8')
}

test('D1 outbox is the single retry owner for Google Sheet backup failures', async () => {
  const entry = await source('worker/src/entry.js')
  const queue = await source('worker/src/sheet-backup-queue.js')

  assert.match(entry, /from '\.\/sheet-backup-queue\.js'/)
  assert.match(entry, /realtime-resilience-v22-sheet-backup-single-retry-owner/)
  assert.match(queue, /retry: \(\) => message\.ack\(\)/)
  assert.match(queue, /Cloudflare D1 remains canonical/)
  assert.doesNotMatch(queue, /retry: \(\) => message\.retry\(\)/)
})

test('Sheet backup retries are bounded and permanent Google 4xx errors can die', async () => {
  const queue = await source('worker/src/sheet-backup-queue.js')

  assert.match(queue, /DEFAULT_MAX_ATTEMPTS = 8/)
  assert.match(queue, /status: dead \? 'dead' : 'pending'/)
  assert.match(queue, /\!\[408, 409, 425, 429\]\.includes\(upstreamStatus\)/)
  assert.match(queue, /max_attempts_exhausted/)
  assert.match(queue, /google_rate_limited/)
})
