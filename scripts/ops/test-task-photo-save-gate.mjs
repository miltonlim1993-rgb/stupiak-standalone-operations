import assert from 'node:assert/strict'
import { createTaskPhotoSaveGate } from '../../web/src/lib/task-photo-save-gate.js'
import { buildTaskProgressPatch } from '../../worker/src/realtime-task-action-d1.js'
import { assertUpdatePermission } from '../../worker/src/permissions.js'

function progressKeys(patch) {
  return Object.keys(patch).sort()
}

const legacyTask = {
  id: 'task-1',
  outlet_id: 'RR-KCH',
  title: 'Opening checklist',
  template_id: 'template-1',
  assignment: 'all-staff',
  due_date: '2026-08-03',
  status: 'pending',
  notes: '',
}
const state = {
  schema: 'operational-checklist-v1',
  responses: { item_1: { value: 'Done' } },
  started_at: '',
  completion_notes: 'Checked by staff',
}
const staff = { role: 'staff', email: 'staff@example.com', full_name: 'Staff User' }
const leader = { role: 'leader', email: 'leader@example.com', full_name: 'Leader User' }
const timestamp = '2026-08-03T07:30:00.000Z'

const saved = buildTaskProgressPatch(legacyTask, state, 'save', staff, timestamp)
assert.deepEqual(progressKeys(saved.patch), ['notes', 'status'])
assert.equal(saved.patch.status, 'in_progress')
assert.equal(JSON.parse(saved.patch.notes).started_at, timestamp)
assert.equal('title' in saved.patch, false)
assert.equal('template_id' in saved.patch, false)
assert.equal('assignment' in saved.patch, false)
assert.doesNotThrow(() => assertUpdatePermission(staff, 'Task', legacyTask, saved.patch))
assert.doesNotThrow(() => assertUpdatePermission(leader, 'Task', legacyTask, saved.patch))

const alreadyStarted = buildTaskProgressPatch(
  { ...legacyTask, status: 'in_progress' },
  { ...state, started_at: '2026-08-03T07:00:00.000Z' },
  'save',
  staff,
  timestamp,
)
assert.deepEqual(progressKeys(alreadyStarted.patch), ['notes'])
assert.equal(JSON.parse(alreadyStarted.patch.notes).started_at, '2026-08-03T07:00:00.000Z')
assert.doesNotThrow(() => assertUpdatePermission(staff, 'Task', legacyTask, alreadyStarted.patch))

const completed = buildTaskProgressPatch(legacyTask, state, 'complete', leader, timestamp)
assert.deepEqual(progressKeys(completed.patch), [
  'completed_by_email',
  'completed_by_name',
  'completed_date',
  'completion_notes',
  'notes',
  'status',
])
assert.equal(completed.patch.status, 'done')
assert.equal(completed.patch.completed_by_email, leader.email)
assert.doesNotThrow(() => assertUpdatePermission(leader, 'Task', legacyTask, completed.patch))

assert.throws(
  () => assertUpdatePermission(staff, 'Task', legacyTask, { ...saved.patch, title: legacyTask.title }),
  /You may only update task progress/,
)

function createHarness(initialSnapshot) {
  let snapshot = initialSnapshot
  const listeners = new Set()
  let timeoutCallback = null
  const gate = createTaskPhotoSaveGate({
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    setTimer: (callback) => {
      timeoutCallback = callback
      return 1
    },
    clearTimer: () => {
      timeoutCallback = null
    },
  })
  return {
    gate,
    update(next) {
      snapshot = next
      listeners.forEach((listener) => listener())
    },
    timeout() {
      timeoutCallback?.()
    },
  }
}

let retryClicks = 0
const retryButton = { disabled: false, click: () => { retryClicks += 1 } }
const successHarness = createHarness({ localCount: 1, retryButtons: [retryButton] })
const firstCommit = successHarness.gate.commit()
const duplicateCommit = successHarness.gate.commit()
assert.equal(firstCommit, duplicateCommit, 'recursive Save clicks must share one in-flight photo gate')
assert.equal(retryClicks, 1, 'failed local photo must be retried automatically exactly once')
successHarness.update({ localCount: 1, retryButtons: [] })
successHarness.update({ localCount: 0, retryButtons: [] })
assert.equal(await firstCommit, true, 'Task save may continue only after no local photo remains')
assert.equal(successHarness.gate.isInFlight(), false)

let repeatedRetryClicks = 0
const failedRetryButton = { disabled: false, click: () => { repeatedRetryClicks += 1 } }
const failureHarness = createHarness({ localCount: 1, retryButtons: [failedRetryButton] })
const failedCommit = failureHarness.gate.commit()
assert.equal(repeatedRetryClicks, 1)
failureHarness.update({ localCount: 1, retryButtons: [] })
failureHarness.update({ localCount: 1, retryButtons: [failedRetryButton] })
assert.equal(await failedCommit, false, 'Task save must remain blocked when the inline retry fails again')
assert.equal(repeatedRetryClicks, 1, 'the gate must not recursively retry the same failed photo')

const timeoutHarness = createHarness({ localCount: 1, retryButtons: [] })
const timedCommit = timeoutHarness.gate.commit()
timeoutHarness.timeout()
assert.equal(await timedCommit, false, 'an unconfirmed local photo must block Task save on timeout')

console.log('TASK_ACTION_PROGRESS_PAYLOAD_ONLY=true')
console.log('STAFF_TASK_SAVE_PERMISSION=true')
console.log('LEADER_TASK_SAVE_PERMISSION=true')
console.log('TASK_PHOTO_GATE_BEHAVIOR_TEST=true')
console.log('TASK_PHOTO_RETRY_ONCE=true')
console.log('TASK_PHOTO_DUPLICATE_SAVE_BLOCKED=true')
console.log('TASK_SAVE_WAITS_FOR_SERVER_CONFIRMED_PHOTO=true')
