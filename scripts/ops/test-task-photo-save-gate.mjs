import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createTaskPhotoSaveGate } from '../../web/src/lib/task-photo-save-gate.js'
import {
  ensureTaskPhotoPersisted,
  serverConfirmedTaskPhoto,
  taskPhotoEntityId,
  unconfirmedLocalTaskPhotos,
} from '../../web/src/lib/task-photo-persistence.js'
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

let continuationCount = 0
const continuationHarness = createHarness({ localCount: 1, retryButtons: [] })
function requestContinuation() {
  if (continuationHarness.gate.isInFlight()) return null
  const commit = continuationHarness.gate.commit()
  commit.then((success) => {
    if (success) continuationCount += 1
  })
  return commit
}
const continuationCommit = requestContinuation()
assert.equal(requestContinuation(), null, 'a second click must not attach another Task action continuation')
continuationHarness.update({ localCount: 0, retryButtons: [] })
assert.equal(await continuationCommit, true)
await Promise.resolve()
assert.equal(continuationCount, 1, 'photo confirmation must continue exactly one Task action')

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

const photoPayload = {
  outlet_id: 'RR-KCH',
  task_id: 'task-1',
  photo_type: 'checklist:opening-sauce',
  drive_file_id: 'drive-file-1',
}
const stablePhotoId = taskPhotoEntityId(photoPayload)
assert.equal(stablePhotoId, 'task-photo:drive-file-1')
assert.equal(taskPhotoEntityId({ ...photoPayload, id: 'random-a' }), stablePhotoId)
assert.equal(taskPhotoEntityId({ ...photoPayload, id: 'random-b' }), stablePhotoId)

const confirmedPhoto = {
  ...photoPayload,
  id: stablePhotoId,
  __realtime: { entity: 'TaskPhoto', version: 1 },
}
assert.equal(serverConfirmedTaskPhoto([confirmedPhoto], stablePhotoId), confirmedPhoto)
assert.equal(serverConfirmedTaskPhoto([
  { ...confirmedPhoto, client_upload_state: 'committed' },
], stablePhotoId), null, 'optimistic records must never satisfy D1 confirmation')

let createCalls = 0
let bootstrapReads = 0
const persisted = await ensureTaskPhotoPersisted({
  payload: photoPayload,
  createTaskPhoto: async (payload) => {
    createCalls += 1
    assert.equal(payload.id, stablePhotoId)
    return payload
  },
  readBootstrap: async () => {
    bootstrapReads += 1
    return { task_photos: [confirmedPhoto] }
  },
})
assert.equal(persisted.entityId, stablePhotoId)
assert.equal(persisted.created, true)
assert.equal(createCalls, 1)
assert.equal(bootstrapReads, 1)

let replayCreateCalls = 0
const replayed = await ensureTaskPhotoPersisted({
  payload: photoPayload,
  checkExisting: true,
  createTaskPhoto: async () => {
    replayCreateCalls += 1
    throw new Error('must not create twice')
  },
  readBootstrap: async () => ({ task_photos: [confirmedPhoto] }),
})
assert.equal(replayed.replayed, true)
assert.equal(replayCreateCalls, 0, 'retry must reuse the server TaskPhoto instead of creating another row')

let lostResponseCreateCalls = 0
const recovered = await ensureTaskPhotoPersisted({
  payload: photoPayload,
  createTaskPhoto: async () => {
    lostResponseCreateCalls += 1
    throw new Error('network response lost after D1 commit')
  },
  readBootstrap: async () => ({ task_photos: [confirmedPhoto] }),
})
assert.equal(recovered.replayed, true)
assert.equal(lostResponseCreateCalls, 1)

await assert.rejects(
  ensureTaskPhotoPersisted({
    payload: photoPayload,
    createTaskPhoto: async (payload) => payload,
    readBootstrap: async () => ({ task_photos: [] }),
  }),
  /未能从服务器重新确认/,
)

const visibleLocal = unconfirmedLocalTaskPhotos([
  { id: 'local-1', serverId: stablePhotoId },
  { id: 'local-2', serverId: 'task-photo:drive-file-2' },
], [confirmedPhoto])
assert.deepEqual(visibleLocal.map((photo) => photo.id), ['local-2'], 'one photo must not render as both local and saved')

const realtimeMutationSource = readFileSync('web/src/lib/realtime-mutations.js', 'utf8')
const rosterSource = readFileSync('web/src/lib/roster-task-assignment.js', 'utf8')
const taskPageSource = readFileSync('web/src/pages/OperationalTasksV2.jsx', 'utf8')
const taskLiveSource = readFileSync('web/src/pages/OperationalTasksLive.jsx', 'utf8')
assert(realtimeMutationSource.includes("mutation.entity !== 'TaskPhoto'"), 'TaskPhoto must not enter the offline queue')
assert(realtimeMutationSource.includes('task-photo-create:${stablePhotoId}'), 'TaskPhoto create must use an idempotent mutation ID')
assert(rosterSource.includes('includeUnconfirmed: false'), 'Task bootstrap must not present optimistic TaskPhoto as D1 confirmation')
assert(taskPageSource.includes('ensureTaskPhotoPersisted'), 'Task photo tile must use the tested D1 confirmation flow')
assert(taskPageSource.includes('throwOnError: true'), 'bootstrap confirmation failure must return to the local photo tile')
assert(taskPageSource.includes('suppressError: true'), 'photo persistence failure must not create a global error panel')
assert(taskPageSource.includes('unconfirmedLocalTaskPhotos'), 'confirmed and local copies must not render twice')
assert(taskLiveSource.includes('if (photoSaveGate.isInFlight()) return true'), 'duplicate Save clicks must not attach duplicate continuation')
assert(taskLiveSource.includes('onTouchMove'), 'mobile photo preview must support pinch zoom')

console.log('TASK_ACTION_PROGRESS_PAYLOAD_ONLY=true')
console.log('STAFF_TASK_SAVE_PERMISSION=true')
console.log('LEADER_TASK_SAVE_PERMISSION=true')
console.log('TASK_PHOTO_GATE_BEHAVIOR_TEST=true')
console.log('TASK_PHOTO_RETRY_ONCE=true')
console.log('TASK_PHOTO_DUPLICATE_SAVE_BLOCKED=true')
console.log('TASK_PHOTO_CONTINUATION_ONCE=true')
console.log('TASK_PHOTO_STABLE_ENTITY_ID=true')
console.log('TASK_PHOTO_IDEMPOTENT_CREATE=true')
console.log('TASK_PHOTO_OFFLINE_QUEUE=false')
console.log('TASK_PHOTO_SERVER_BOOTSTRAP_REQUIRED=true')
console.log('TASK_PHOTO_DUPLICATE_RENDER=false')
console.log('TASK_SAVE_WAITS_FOR_SERVER_CONFIRMED_PHOTO=true')
