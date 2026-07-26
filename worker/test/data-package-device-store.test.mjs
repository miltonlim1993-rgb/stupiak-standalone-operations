import assert from 'node:assert/strict'
import test from 'node:test'

import {
  listDataPackageDeviceStates,
  saveDataPackageDeviceState,
} from '../src/data-package-device-store.js'

function fakeEnv() {
  const values = new Map()
  return {
    APP_DATA_PACKS: {
      async get(key, type) {
        if (!values.has(key)) return null
        const value = values.get(key)
        return type === 'json' ? JSON.parse(value) : value
      },
      async put(key, value) {
        values.set(key, String(value))
      },
      async list({ prefix = '', cursor = undefined, limit = 1000 } = {}) {
        const names = [...values.keys()].filter((key) => key.startsWith(prefix)).sort()
        const start = cursor ? Number(cursor) : 0
        const page = names.slice(start, start + limit)
        const next = start + page.length
        return {
          keys: page.map((name) => ({ name })),
          list_complete: next >= names.length,
          cursor: next >= names.length ? undefined : String(next),
        }
      },
    },
  }
}

test('stores device package versions per outlet and updates the same device', async () => {
  const env = fakeEnv()
  const user = { id: 'user-1', email: 'staff@example.com', full_name: 'Staff One', outlet_id: 'TEST-DEVICE-A' }

  await saveDataPackageDeviceState(env, {
    outletId: 'TEST-DEVICE-A',
    deviceId: 'device-1',
    user,
    platform: 'android-web',
    appVersion: '4.5.1',
    packageVersion: 'release-old',
    installedAt: '2026-07-01T00:00:00.000Z',
  })
  await saveDataPackageDeviceState(env, {
    outletId: 'TEST-DEVICE-A',
    deviceId: 'device-1',
    user,
    platform: 'android-web',
    appVersion: '4.5.2',
    packageVersion: 'release-current',
    installedAt: '2026-07-26T00:00:00.000Z',
  })
  await saveDataPackageDeviceState(env, {
    outletId: 'TEST-DEVICE-A',
    deviceId: 'device-2',
    user: { ...user, id: 'user-2', email: 'staff2@example.com', full_name: 'Staff Two' },
    platform: 'ios-web',
    appVersion: '4.5.2',
    packageVersion: 'release-old',
  })
  await saveDataPackageDeviceState(env, {
    outletId: 'TEST-DEVICE-B',
    deviceId: 'device-3',
    user: { ...user, outlet_id: 'TEST-DEVICE-B' },
    packageVersion: 'other-outlet-release',
  })

  const outletA = await listDataPackageDeviceStates(env, 'TEST-DEVICE-A')
  const outletB = await listDataPackageDeviceStates(env, 'TEST-DEVICE-B')

  assert.equal(outletA.length, 2)
  assert.equal(outletB.length, 1)
  assert.equal(outletA.find((row) => row.device_id === 'device-1').data_package_version, 'release-current')
  assert.equal(outletA.find((row) => row.device_id === 'device-1').app_version, '4.5.2')
  assert.equal(outletA.find((row) => row.device_id === 'device-1').first_seen_at.length > 0, true)
  assert.equal(outletB[0].device_id, 'device-3')
})
