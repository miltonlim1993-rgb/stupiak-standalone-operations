import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import test from 'node:test'

import {
  applyHierarchyToCatalog,
  fifoReprintLocked,
  LABEL_FIFO_POLICY_VERSION,
  labelSourceTier,
} from '../src/label-fifo-policy-v26.js'
import {
  recoveredCreateBody,
  stableRuleMatch,
} from '../src/label-rule-recovery.js'

async function source(path) {
  return fs.readFile(new URL(`../../${path}`, import.meta.url), 'utf8')
}

test('final source hierarchy remains the approved v26 contract', () => {
  assert.equal(LABEL_FIFO_POLICY_VERSION, '4.6.25-label-source-fifo-v26')
  assert.equal(labelSourceTier('Prepare / Freeze'), 1)
  assert.equal(labelSourceTier('Open'), 2)
  assert.equal(labelSourceTier('Refill'), 3)
  assert.equal(fifoReprintLocked(1), true)
  assert.equal(fifoReprintLocked(2), true)
  assert.equal(fifoReprintLocked(3), false)

  const catalog = applyHierarchyToCatalog({
    rules: [
      { ruleId: 'prepare', productId: 'sauce', productName: 'Sauce', action: 'Prepare' },
      { ruleId: 'open', productId: 'sauce', productName: 'Sauce', action: 'Open' },
      { ruleId: 'refill', productId: 'sauce', productName: 'Sauce', action: 'Refill' },
    ],
  })
  assert.equal(catalog.rules[0].requiresSource, false)
  assert.equal(catalog.rules[1].requiredSourceTier, 1)
  assert.equal(catalog.rules[1].sourceProductId, 'sauce')
  assert.equal(catalog.rules[2].requiredSourceTier, 2)
  assert.match(catalog.rules[2].allowedSourceActions, /open/)
})

test('stale expiry rule keys recover to the current unique D1 rule', () => {
  const currentRule = {
    ruleId: 'beef-mix-powder-6kg-prepare',
    ruleKey: 'beef-mix-powder-6kg-prepare::Prepare::Dry Storage::44',
    productId: 'beef-mix-powder-6kg',
    action: 'Prepare',
    storageCondition: 'Dry Storage',
  }
  const staleRequest = {
    rule_id: currentRule.ruleId,
    rule_key: 'beef-mix-powder-6kg-prepare::Prepare::Dry Storage::18',
    product_id: currentRule.productId,
    manual_expiry_at: '2026-08-06T07:20:00.000Z',
  }

  assert.equal(stableRuleMatch([currentRule], staleRequest), currentRule)
  assert.deepEqual(recoveredCreateBody([currentRule], staleRequest), {
    ...staleRequest,
    rule_id: currentRule.ruleId,
    rule_key: currentRule.ruleKey,
    product_id: currentRule.productId,
  })
})

test('stale expiry rule recovery refuses product mismatches and ambiguity', () => {
  const baseRule = {
    ruleId: 'prepare',
    ruleKey: 'prepare::Prepare::Dry Storage::9',
    productId: 'product-a',
    action: 'Prepare',
    storageCondition: 'Dry Storage',
  }
  const staleRequest = {
    rule_id: 'prepare',
    rule_key: 'prepare::Prepare::Dry Storage::2',
    product_id: 'product-b',
  }

  assert.equal(stableRuleMatch([baseRule], staleRequest), null)
  assert.equal(recoveredCreateBody([baseRule], staleRequest), null)

  const duplicate = {
    ...baseRule,
    ruleKey: 'prepare::Prepare::Dry Storage::10',
  }
  const matchingProductRequest = {
    ...staleRequest,
    product_id: 'product-a',
  }
  assert.equal(stableRuleMatch([baseRule, duplicate], matchingProductRequest), null)
  assert.equal(recoveredCreateBody([baseRule, duplicate], matchingProductRequest), null)
})

test('current D1 runtime routes through the v26 adapter', async () => {
  const router = await source('worker/src/realtime-labels-d1.js')
  const adapter = await source('worker/src/label-d1-operations-v26.js')
  assert.match(router, /from '\.\/label-d1-operations-v26\.js'/)
  assert.match(router, /recoveredCreateBody/)
  assert.match(adapter, /applyHierarchyToCatalog\(await d1LabelCatalog/)
  assert.match(adapter, /fifo_source_order_violation/)
  assert.match(adapter, /source_chain_incomplete/)
  assert.match(adapter, /fifo_reprint_locked/)
  assert.match(adapter, /mutateLabelRecord/)
  assert.match(adapter, /source-rollback/)
})

test('final raw TSPL printing files remain wired without HTML raster fallback', async () => {
  const main = await source('web/src/main.jsx')
  const installer = await source('web/src/lib/install-final-label-runtime.js')
  const stablePrinter = await source('web/src/lib/stable-label-print-v16.js')
  const stableTspl = await source('web/src/lib/stable-tspl-label-v16.js')
  assert.match(main, /installFinalLabelRuntime\(\)/)
  assert.match(installer, /installStableLabelPrintV16\(\)/)
  assert.match(installer, /installStableLabelPrintV20\(\)/)
  assert.match(installer, /installLabelFifoPolicyV26\(\)/)
  assert.match(stablePrinter, /rawCommandBase64: asciiBase64\(stable\.command\)/)
  assert.match(stablePrinter, /html: ''/)
  assert.match(stableTspl, /SIZE \$\{formatMm\(widthMm\)\} mm,\$\{formatMm\(heightMm\)\} mm/)
  assert.match(stableTspl, /DENSITY 8/)
  assert.match(stableTspl, /SPEED 4/)
})
