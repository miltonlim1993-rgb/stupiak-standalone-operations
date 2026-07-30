import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

import {
  assertCreatePermission,
  assertDeletePermission,
  assertReadPermission,
  assertUpdatePermission,
  scopeFilter,
} from '../src/permissions.js'

const root = new URL('../../', import.meta.url)

async function source(path) {
  return readFile(new URL(path, root), 'utf8')
}

const staff = {
  role: 'staff',
  email: 'staff@example.com',
  outlet_id: 'RR-KCH',
  outlet_ids: 'RR-KCH',
}

test('staff can read, create, update and delete assigned-outlet printer profiles', () => {
  assert.doesNotThrow(() => assertReadPermission(staff, 'PrinterProfile'))
  assert.doesNotThrow(() => assertCreatePermission(staff, 'PrinterProfile'))
  assert.doesNotThrow(() => assertUpdatePermission(staff, 'PrinterProfile', { outlet_id: 'RR-KCH' }, { darkness: 8 }))
  assert.doesNotThrow(() => assertDeletePermission(staff, 'PrinterProfile', { outlet_id: 'RR-KCH' }))
  assert.deepEqual(scopeFilter(staff, 'PrinterProfile', { purpose: 'food_label' }), {
    purpose: 'food_label',
    outlet_id: 'RR-KCH',
  })
})

test('unauthenticated or unknown roles cannot mutate printer profiles', () => {
  assert.throws(() => assertCreatePermission({ role: '' }, 'PrinterProfile'), /cannot create PrinterProfile/)
  assert.throws(() => assertUpdatePermission({ role: '' }, 'PrinterProfile', {}, {}), /Sign in as outlet staff/)
  assert.throws(() => assertDeletePermission({ role: '' }, 'PrinterProfile', {}), /Sign in as outlet staff/)
})

test('latest workspace compatibility targets the stable data attribute and restores responsive class', async () => {
  const runtime = await source('web/src/lib/label-settings-staff-v17.js')
  assert.match(runtime, /querySelector\('\[data-printer-workspace\]'\)/)
  assert.match(runtime, /classList\.add\('max-w-6xl'\)/)
  assert.match(runtime, /All staff access · Stable TSPL v16/)
})

test('all signed-in staff receive a visible header and desktop navigation shortcut', async () => {
  const layout = await source('web/src/components/Layout.jsx')
  assert.match(layout, /to: '\/labels\/settings', label: 'Label Printer Settings'/)
  assert.match(layout, /title="Label Printer Settings · available to all staff"/)
  assert.doesNotMatch(layout, /ROLE_LEVEL.*labels\/settings/)
})

test('label pages verify the published shell instead of remaining on an old web bundle', async () => {
  const freshness = await source('web/src/lib/web-shell-freshness-v17.js')
  const main = await source('web/src/main.jsx')
  assert.match(freshness, /cache: 'no-store'/)
  assert.match(freshness, /pathname === '\/labels\/settings'/)
  assert.match(freshness, /window\.location\.reload\(\)/)
  assert.match(main, /installWebShellFreshnessV17/)
  assert.match(main, /installLabelSettingsStaffV17/)
})
