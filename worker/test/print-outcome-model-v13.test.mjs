import test from 'node:test'
import assert from 'node:assert/strict'

import { normalizePhysicalPrintOutcome } from '../../web/src/lib/print-outcome-model-v13.js'

test('system print opening is never reported as a completed print', () => {
  const outcome = normalizePhysicalPrintOutcome({
    route: 'system_print',
    copies: 1,
    result: { printed: true, dialog: true, printer: 'Android System Print' },
  })

  assert.equal(outcome.outcome_state, 'dialog_opened')
  assert.equal(outcome.result.printed, false)
  assert.equal(outcome.transport_accepted, false)
  assert.equal(outcome.physical_verified, false)
})

test('computer queue acceptance is not treated as physical printing', () => {
  const outcome = normalizePhysicalPrintOutcome({
    route: 'driver_bridge',
    result: { printed: true, mode: 'queue', queue: { name: 'TSC Label' }, printer: 'TSC Label' },
  })

  assert.equal(outcome.outcome_state, 'queue_accepted')
  assert.equal(outcome.result.jobAccepted, true)
  assert.equal(outcome.result.printed, false)
  assert.equal(outcome.physical_verified, false)
})

test('LPR acknowledgement is separated from physical label verification', () => {
  const outcome = normalizePhysicalPrintOutcome({
    route: 'network',
    result: { printed: true, networkProtocol: 'lpr', printer: '192.168.0.211:515/lp' },
  })

  assert.equal(outcome.outcome_state, 'printer_job_acknowledged')
  assert.equal(outcome.transport_accepted, true)
  assert.equal(outcome.result.physicalVerified, false)
})

test('Raw TCP and Bluetooth only report data sent', () => {
  const raw = normalizePhysicalPrintOutcome({
    route: 'network',
    result: { printed: true, networkProtocol: 'raw_tcp', printer: '192.168.0.211:9100' },
  })
  const bluetooth = normalizePhysicalPrintOutcome({
    route: 'bluetooth',
    result: { printed: true, printer: 'ABARCODE 4B-2054K' },
  })

  assert.equal(raw.outcome_state, 'raw_tcp_data_sent')
  assert.equal(bluetooth.outcome_state, 'bluetooth_data_sent')
  assert.equal(raw.result.printed, false)
  assert.equal(bluetooth.result.printed, false)
})
