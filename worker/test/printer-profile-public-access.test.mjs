import test from 'node:test'
import assert from 'node:assert/strict'

import {
  assertCreatePermission,
  assertDeletePermission,
  assertUpdatePermission,
  scopeFilter,
} from '../src/permissions.js'

const staff = {
  id: 'user-staff',
  role: 'staff',
  email: 'staff@example.com',
  outlet_id: 'RR-KCH',
  outlet_ids: 'RR-KCH',
}

test('staff can create an outlet printer profile', () => {
  assert.doesNotThrow(() => assertCreatePermission(staff, 'PrinterProfile'))
})

test('staff can update an outlet-shared printer profile', () => {
  assert.doesNotThrow(() => assertUpdatePermission(
    staff,
    'PrinterProfile',
    { id: 'printer-1', outlet_id: 'RR-KCH', created_by: 'manager@example.com' },
    { profile_name: 'Kitchen Printer', label_width_mm: 40 },
  ))
})

test('staff can delete an outlet-shared printer profile', () => {
  assert.doesNotThrow(() => assertDeletePermission(
    staff,
    'PrinterProfile',
    { id: 'printer-1', outlet_id: 'RR-KCH', created_by: 'manager@example.com' },
  ))
})

test('printer profile reads remain limited to assigned outlets', () => {
  assert.deepEqual(scopeFilter(staff, 'PrinterProfile', {}), { outlet_id: 'RR-KCH' })
  assert.deepEqual(scopeFilter(staff, 'PrinterProfile', { outlet_id: 'SKONE-BTU' }), { outlet_id: '__NO_ASSIGNED_OUTLET__' })
})
