import assert from 'node:assert/strict'
import test from 'node:test'

import {
  clearSheetBackupCircuit,
  gateSheetBackupAttempt,
  getSheetBackupCircuitState,
  recordSheetBackupFailure,
  recordSheetBackupSuccess,
  SHEET_BACKUP_CIRCUIT_VERSION,
} from '../src/sheet-backup-circuit.js'

function fakeEnv() {
  const values = new Map()
  return {
    APP_DATA_PACKS: {
      async get(key, type) {
        const value = values.get(key)
        if (value == null) return null
        return type === 'json' ? JSON.parse(value) : value
      },
      async put(key, value) { values.set(key, value) },
      async delete(key) { values.delete(key) },
    },
  }
}

function failure(status) {
  return {
    decision: {
      upstreamStatus: status,
      reason: `google_http_${status}`,
    },
    lastError: `Google API ${status}: synthetic failure`,
  }
}

test('repeated permanent Google 4xx failures open the optional Sheet backup circuit', async () => {
  const env = fakeEnv()
  await clearSheetBackupCircuit(env)

  for (let index = 1; index <= 4; index += 1) {
    await recordSheetBackupFailure(env, {
      ...failure(400),
      mutationId: `mutation-${index}`,
    })
    const state = await getSheetBackupCircuitState(env, { force: true })
    assert.equal(state.is_open, false)
    assert.equal(state.failure_count, index)
  }

  await recordSheetBackupFailure(env, {
    ...failure(400),
    mutationId: 'mutation-5',
  })
  const opened = await getSheetBackupCircuitState(env, { force: true })
  assert.equal(opened.is_open, true)
  assert.equal(opened.is_deferred, true)
  assert.equal(opened.reason, 'google_http_400_burst')

  const gate = await gateSheetBackupAttempt(env, {
    mutationId: 'mutation-6',
    allowProbe: true,
  })
  assert.equal(gate.allowed, false)
  assert.ok(gate.nextAttemptAt)
})

test('authorization failures open faster than ordinary permanent 4xx failures', async () => {
  const env = fakeEnv()
  await clearSheetBackupCircuit(env)

  await recordSheetBackupFailure(env, {
    ...failure(403),
    mutationId: 'auth-1',
  })
  assert.equal((await getSheetBackupCircuitState(env, { force: true })).is_open, false)

  await recordSheetBackupFailure(env, {
    ...failure(403),
    mutationId: 'auth-2',
  })
  const state = await getSheetBackupCircuitState(env, { force: true })
  assert.equal(state.is_open, true)
  assert.equal(state.reason, 'google_auth_http_403_burst')
})

test('an expired circuit permits one probe and closes only after that probe succeeds', async () => {
  const env = fakeEnv()
  await clearSheetBackupCircuit(env)

  const realNow = Date.now
  let clock = 1_800_000_000_000
  Date.now = () => clock
  try {
    for (let index = 1; index <= 5; index += 1) {
      await recordSheetBackupFailure(env, {
        ...failure(400),
        mutationId: `probe-seed-${index}`,
      })
    }

    let state = await getSheetBackupCircuitState(env, { force: true })
    assert.equal(state.is_open, true)
    clock = Date.parse(state.retry_after) + 1

    const firstProbe = await gateSheetBackupAttempt(env, {
      mutationId: 'recovery-probe',
      allowProbe: true,
    })
    assert.equal(firstProbe.allowed, true)
    assert.equal(firstProbe.probe, true)

    const competingProbe = await gateSheetBackupAttempt(env, {
      mutationId: 'other-mutation',
      allowProbe: true,
    })
    assert.equal(competingProbe.allowed, false)

    await recordSheetBackupSuccess(env, { mutationId: 'recovery-probe' })
    state = await getSheetBackupCircuitState(env, { force: true })
    assert.equal(state.is_open, false)
  } finally {
    Date.now = realNow
  }
})

test('circuit contract has a stable diagnostic version', () => {
  assert.equal(SHEET_BACKUP_CIRCUIT_VERSION, 'sheet-backup-circuit-v1')
})
