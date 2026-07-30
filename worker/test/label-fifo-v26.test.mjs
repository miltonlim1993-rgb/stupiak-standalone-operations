import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

import {
  applyHierarchyToCatalog,
  applyHierarchyToRule,
  fifoReprintLocked,
  LABEL_FIFO_POLICY_VERSION,
  labelSourceStage,
  labelSourceTier,
} from '../src/label-fifo-policy-v26.js'

const root = new URL('../../', import.meta.url)

async function source(path) {
  return readFile(new URL(path, root), 'utf8')
}

test('expiry actions are forced into the three required source stages', () => {
  assert.equal(LABEL_FIFO_POLICY_VERSION, '4.6.25-label-source-fifo-v26')
  for (const action of ['Prepare', 'Prepared', 'Freeze', 'Frozen', 'Received']) {
    assert.equal(labelSourceTier(action), 1)
    assert.equal(labelSourceStage(action), 'first_hand')
  }
  assert.equal(labelSourceTier('Open'), 2)
  assert.equal(labelSourceStage('Open'), 'second_hand')
  assert.equal(labelSourceTier('Refill'), 3)
  assert.equal(labelSourceTier('Cooked'), 3)
  assert.equal(labelSourceStage('Cooked'), 'third_hand')
})

test('Sheet requiresSource values cannot override the operational hierarchy', () => {
  const first = applyHierarchyToRule({ action: 'Prepare', requiresSource: true, sourceExpiryMode: 'source' })
  assert.equal(first.requiresSource, false)
  assert.equal(first.requiredSourceTier, 0)
  assert.equal(first.sourceUsageMode, 'tracked')

  const second = applyHierarchyToRule({ action: 'Open', requiresSource: false, allowedSourceActions: '' })
  assert.equal(second.requiresSource, true)
  assert.equal(second.requiredSourceTier, 1)
  assert.match(second.allowedSourceActions, /prepare/)
  assert.match(second.allowedSourceActions, /received/)
  assert.equal(second.sourceExpiryMode, 'min')

  const third = applyHierarchyToRule({ action: 'Cooked', requiresSource: false })
  assert.equal(third.requiresSource, true)
  assert.equal(third.requiredSourceTier, 2)
  assert.match(third.allowedSourceActions, /open/)
  assert.equal(third.sourceExpiryMode, 'min')
})

test('first-hand and second-hand labels are print-once records', () => {
  assert.equal(fifoReprintLocked(1), true)
  assert.equal(fifoReprintLocked(2), true)
  assert.equal(fifoReprintLocked(3), false)
  const catalog = applyHierarchyToCatalog({ rules: [{ action: 'Open' }] })
  assert.equal(catalog.rules[0].fifoReprintLocked, true)
  assert.equal(catalog.fifoPolicy.firstSecondReprintLocked, true)
})

test('server handler enforces source capacity, source order and reprint rejection', async () => {
  const handler = await source('worker/src/label-fifo-v26.js')
  assert.match(handler, /source_capacity: printQuantity/)
  assert.match(handler, /source_remaining_qty: printQuantity/)
  assert.match(handler, /assertSourceHierarchy/)
  assert.match(handler, /assertFifoSelection/)
  assert.match(handler, /fifo_source_order_violation/)
  assert.match(handler, /fifo_reprint_locked/)
  assert.match(handler, /First-hand and second-hand labels cannot print extra copies/)
  assert.match(handler, /source_chain_incomplete/)
})

test('Web normalizes both live and packed label catalogs before Food Labels renders', async () => {
  const runtime = await source('web/src/lib/install-label-fifo-policy-v26.js')
  const main = await source('web/src/main.jsx')
  assert.match(runtime, /opsClient\.labels\.catalog = async/)
  assert.match(runtime, /applyHierarchyToCatalog/)
  assert.match(main, /installLabelFifoPolicyV26/)
  assert.match(main, /labelFifoPolicy: 'three-stage-source-chain-v26'/)
})

test('entry routes label create, catalog and reprint through the FIFO gate', async () => {
  const entry = await source('worker/src/entry-v3.js')
  assert.match(entry, /handleLabelFifoV26/)
  assert.match(entry, /url\.pathname\.startsWith\('\/api\/labels\/'\)/)
  assert.match(entry, /label-source-fifo-v26-v4\.6\.25/)
})
