import assert from 'node:assert/strict'
import test from 'node:test'
import {
  canonicalObservation,
  createAcceptedObservation,
  normalizeObservedQuantity,
  observationDigest,
  stockBatchFingerprint,
  stockLineMutationId,
} from '../src/stock-count-observation.js'

const secret = '01234567890123456789012345678901'

test('accepted D1 observation has stable Core-compatible digest and HMAC identity', async () => {
  const observation = await createAcceptedObservation({
    secret,
    batchMutationId: 'batch-1',
    outletId: 'RR-KCH',
    commit: {
      id: 'count-1',
      mutationId: 'batch-1:line-1',
      version: 2,
      canonicalQuantity: '12.3400',
      record: { unit: 'EA' },
      stockList: { item_id: 'ITEM-1', count_uom: 'EA' },
    },
    user: { email: 'counter@example.com' },
  })
  assert.ok(observation)
  assert.equal(observation.observedQuantity, '12.34')
  assert.equal(observation.observationDigest, '10c88311a271d8ad04480384f17db4ccbabff1a1ed36959ea664417d4bdea8b3')
  assert.equal(observation.signature, 'ae192ae5b08a08ae1d3cebea9f496c5fe22caa9f0c736dc8b0df58afd79019dd')
  assert.equal(await observationDigest(observation), observation.observationDigest)
  assert.match(canonicalObservation(observation), /^STATVARA_STOCK_COUNT_V1\nSTANDALONE_D1\n/u)
})

test('precision and identity are rejected rather than rounded or partially accepted', () => {
  assert.equal(normalizeObservedQuantity('1.2300'), '1.23')
  for (const value of ['1.23456', '1e2', '-1', '', '01', 'NaN']) {
    assert.throws(() => normalizeObservedQuantity(value), /at most four fractional digits/u)
  }
})

test('same mutation with a different counted body has a different request fingerprint', async () => {
  const input = { outletId: 'RR-KCH', countDate: '2026-08-29' }
  const first = await stockBatchFingerprint({ ...input, items: [{ stock_list_id: 'line-1', actual_qty: '1' }] })
  const retry = await stockBatchFingerprint({ ...input, items: [{ stock_list_id: 'line-1', actual_qty: '1.0000' }] })
  const changed = await stockBatchFingerprint({ ...input, items: [{ stock_list_id: 'line-1', actual_qty: '2' }] })
  assert.equal(first, retry)
  assert.notEqual(first, changed)
})

test('batch/serial requirement survives signing so Core can reject unsupported identity', async () => {
  const observation = await createAcceptedObservation({
    secret,
    batchMutationId: 'batch-serial',
    outletId: 'RR-KCH',
    commit: {
      id: 'count-serial', mutationId: 'line-serial', version: 1, canonicalQuantity: '2',
      record: { unit: 'EA' },
      stockList: { item_id: 'ITEM-1', count_uom: 'EA', has_serial_no: true },
    },
    user: { email: 'counter@example.com' },
  })
  assert.equal(observation?.requiresBatchSerial, true)
})

test('line mutation identity is collision-resistant and bound to batch plus stock-list identity', async () => {
  const first = await stockLineMutationId('batch-1', 'stock-list-with-a-long-shared-prefix-1')
  const retry = await stockLineMutationId('batch-1', 'stock-list-with-a-long-shared-prefix-1')
  const changedLine = await stockLineMutationId('batch-1', 'stock-list-with-a-long-shared-prefix-2')
  const changedBatch = await stockLineMutationId('batch-2', 'stock-list-with-a-long-shared-prefix-1')
  assert.equal(first, retry)
  assert.notEqual(first, changedLine)
  assert.notEqual(first, changedBatch)
  assert.match(first, /^stock-line:[a-f0-9]{64}$/u)
})
