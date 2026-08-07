import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mergeTaskResponsePatches } from '../../worker/src/realtime-task-action-d1.js'

const config = {
  sections: [{
    id: 'opening',
    items: [
      { id: 'item-a' },
      { id: 'item-b' },
    ],
  }],
}

const current = {
  'item-a': { value: 'A-old', remark: 'keep-a', corrective_action: '' },
  'item-b': { value: 'B-old', remark: 'keep-b', corrective_action: 'keep-action' },
}

const firstDevice = mergeTaskResponsePatches(config, current, [
  { item_id: 'item-a', value: 'A-new', remark: 'device-a' },
])
assert.equal(firstDevice['item-a'].value, 'A-new')
assert.equal(firstDevice['item-a'].remark, 'device-a')
assert.deepEqual(firstDevice['item-b'], current['item-b'], 'saving item A must never overwrite item B')

const secondDevice = mergeTaskResponsePatches(config, firstDevice, [
  { item_id: 'item-b', value: 'B-new' },
])
assert.equal(secondDevice['item-a'].value, 'A-new', 'device B must preserve the latest item A state')
assert.equal(secondDevice['item-b'].value, 'B-new')
assert.equal(secondDevice['item-b'].remark, 'keep-b', 'partial field patch must preserve untouched response fields')
assert.equal(secondDevice['item-b'].corrective_action, 'keep-action')

const unknown = mergeTaskResponsePatches(config, secondDevice, [
  { item_id: 'unknown-item', value: 'must-not-enter-state' },
])
assert.equal(unknown['unknown-item'], undefined, 'unknown checklist items must be rejected from the patch merge')

const pageSource = readFileSync('web/src/pages/OperationalTasksRealtime.jsx', 'utf8')
const liveSource = readFileSync('web/src/pages/OperationalTasksLive.jsx', 'utf8')
const realtimeClientSource = readFileSync('web/src/lib/realtime-client.js', 'utf8')
const actionSource = readFileSync('worker/src/realtime-task-action-d1-v2.js', 'utf8')

assert(liveSource.includes('OperationalTasksRealtime'), 'live Task route must use the state-driven workspace')
assert(pageSource.includes('const AUTOSAVE_DELAY_MS = 800'), 'Task edits must use bounded state-driven debounce')
assert(pageSource.includes('response_patches'), 'Task autosave must send field-level response patches')
assert(pageSource.includes("window.addEventListener('chefops:realtime'"), 'Task workspace must consume realtime events directly')
assert(pageSource.includes('event.preventDefault()'), 'handled Task realtime events must bypass global query invalidation')
assert(pageSource.includes("entity: 'TaskPhoto'"), 'Task photos must commit through the canonical realtime mutation path')
assert(!pageSource.includes('ensureTaskPhotoPersisted'), 'Task photo success must not require a full bootstrap confirmation reread')
assert(!pageSource.includes('MutationObserver'), 'Task saving must not infer state from DOM mutations')
assert(!pageSource.includes('setInterval('), 'Task page must not poll on an interval')

assert(actionSource.includes('mergeTaskResponsePatches'), 'Worker must merge Task response patches into current D1 state')
assert(actionSource.includes("mutationError?.code !== 'realtime_version_conflict'"), 'Worker must retry one optimistic concurrency conflict for patch saves')
assert(actionSource.includes("merge_mode: Array.isArray(body.response_patches) ? 'field-patch' : 'legacy-full'"), 'Task response must expose patch merge mode')

assert(!realtimeClientSource.includes('reconnectAll'), 'focus must not force-close healthy realtime sockets')
assert(realtimeClientSource.includes('ensureConnections'), 'foreground recovery must only ensure missing/stale connections')
assert(realtimeClientSource.includes('HEARTBEAT_TIMEOUT_MS'), 'socket recovery must be heartbeat-based')
assert(realtimeClientSource.includes("socket.close(4001, 'Heartbeat stale')"), 'only a stale healthy-looking socket may be recycled')

console.log('TASK_REALTIME_STATE_MODEL_TEST_OK=true')
console.log('TASK_SAVE_MODEL=debounced_serialized_field_patch')
console.log('TASK_MULTI_DEVICE_MERGE=preserve_unmodified_items')
console.log('TASK_REALTIME_UI_PATCH=true')
console.log('TASK_PAGE_POLLING=false')
console.log('TASK_DOM_SAVE_OBSERVER=false')
console.log('TASK_PHOTO_BOOTSTRAP_CONFIRMATION=false')
console.log('REALTIME_FOCUS_FORCE_RECONNECT=false')
