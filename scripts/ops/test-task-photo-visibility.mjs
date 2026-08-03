import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  clearOptimisticTaskPhotos,
  commitOptimisticTaskPhoto,
  mergeOptimisticTaskPhotos,
  rejectOptimisticTaskPhoto,
  trackOptimisticTaskPhoto,
} from '../../web/src/lib/task-photo-optimistic.js'

const mutation = {
  mutation_id: 'photo-mutation-1',
  entity: 'TaskPhoto',
  entity_id: 'photo-1',
  outlet_id: 'RR-KCH',
  operation: 'create',
  queued_at: '2026-08-03T04:00:00.000Z',
  payload: {
    id: 'photo-1',
    outlet_id: 'RR-KCH',
    task_id: 'task-1',
    photo_type: 'checklist:opening-sauce',
    drive_file_id: 'drive-1',
    file_url: '/api/files/drive-1',
    status: 'active',
  },
}

clearOptimisticTaskPhotos()
trackOptimisticTaskPhoto(mutation, 'uploading')
let merged = mergeOptimisticTaskPhotos({ tasks: [{ id: 'task-1' }], task_photos: [] }, { outletId: 'RR-KCH' })
assert.equal(merged.task_photos.length, 1, 'captured photo must remain visible before D1 confirmation')
assert.equal(merged.task_photos[0].client_upload_state, 'uploading')

commitOptimisticTaskPhoto(mutation, {
  record: {
    ...mutation.payload,
    __realtime: { version: 1, sync_status: 'pending' },
  },
})
merged = mergeOptimisticTaskPhotos({ task_photos: [] }, { outletId: 'RR-KCH' })
assert.equal(merged.task_photos.length, 1, 'committed photo must not disappear while bootstrap catches up')
assert.equal(merged.task_photos[0].client_upload_state, 'committed')

merged = mergeOptimisticTaskPhotos({
  task_photos: [{ ...mutation.payload, updated_date: '2026-08-03T04:01:00.000Z' }],
}, { outletId: 'RR-KCH' })
assert.equal(merged.task_photos.length, 1, 'server confirmation must deduplicate the optimistic photo')
assert.equal(merged.optimistic_task_photo_count, 0)

trackOptimisticTaskPhoto({ ...mutation, entity_id: 'photo-2', payload: { ...mutation.payload, id: 'photo-2' } }, 'uploading')
rejectOptimisticTaskPhoto({ ...mutation, entity_id: 'photo-2', payload: { ...mutation.payload, id: 'photo-2' } }, 'rejected')
merged = mergeOptimisticTaskPhotos({ task_photos: [] }, { outletId: 'RR-KCH' })
assert.equal(merged.task_photos.length, 0, 'rejected evidence must not be falsely shown as saved')

const rosterSource = readFileSync('web/src/lib/roster-task-assignment.js', 'utf8')
assert(rosterSource.includes('mergeOptimisticTaskPhotos'), 'roster wrapper must merge optimistic TaskPhoto records')
assert(rosterSource.includes("cache_mode: 'live-d1-roster-background'"), 'task bootstrap must use live D1 data immediately')
assert(rosterSource.includes('blocks_task_bootstrap: false'), 'roster metadata must never block Task bootstrap')
assert(rosterSource.includes('void refreshRosterInBackground(args)'), 'roster refresh must run in the background')
assert(rosterSource.includes('attendance_required_for_visibility: false'), 'attendance must not control task visibility')
assert(!rosterSource.includes('Promise.all([dataPromise, rosterPromise])'), 'Task bootstrap must not wait for Attendance')
assert(!rosterSource.includes('decorated.filter((task) => task.assigned_to_current_user)'), 'roster wrapper must not hide tasks from off-duty staff')
assert(!rosterSource.includes('userIsExcludedLeadership(user)'), 'leader and supervisor task lists must not be emptied')
assert(!rosterSource.includes('tasks: [],\n    task_photos: []'), 'first load must not return a fabricated empty task response')
assert(!rosterSource.includes('TASK_STORAGE_PREFIX'), 'stale Task snapshots must not remain authoritative')

const realtimePhotoSource = readFileSync('worker/src/realtime-task-photo.js', 'utf8')
assert(realtimePhotoSource.includes('publishedTaskTemplates'), 'TaskPhoto validation must use the published Task package')
assert(realtimePhotoSource.includes('publishedTaskMediaRule'), 'TaskPhoto media validation must use the published core package')
assert(realtimePhotoSource.includes('d1TaskPhotos'), 'TaskPhoto count must come from D1')
assert(realtimePhotoSource.includes('d1-published-package-v3'), 'TaskPhoto response must expose the verified D1 path')
assert(!realtimePhotoSource.includes("from './sheets.js'"), 'TaskPhoto realtime mutation must not import Sheet runtime reads')
assert(!realtimePhotoSource.includes("from './media-rules.js'"), 'TaskPhoto realtime mutation must not call a helper that reads Sheets')
assert(!realtimePhotoSource.includes('getMediaRule('), 'TaskPhoto realtime mutation must not indirectly read MediaRule Sheet')
assert(!realtimePhotoSource.includes('listRecords('), 'TaskPhoto realtime mutation must not read Sheet records')
assert(!realtimePhotoSource.includes('findRecord('), 'TaskPhoto realtime mutation must not fall back to Sheet records')

const appSource = readFileSync('web/src/App.jsx', 'utf8')
const cameraSource = readFileSync('web/src/components/NativeMediaCaptureBridge.jsx', 'utf8')
const taskPageSource = readFileSync('web/src/pages/OperationalTasksV2.jsx', 'utf8')
const taskLiveSource = readFileSync('web/src/pages/OperationalTasksLive.jsx', 'utf8')

assert(!appSource.includes('TaskPhotoSyncStatus'), 'global TaskPhoto status overlay must not be mounted')
assert(!cameraSource.includes('照片已取得并显示'), 'camera bridge must not create a separate photo-save panel')
assert(!cameraSource.includes('chefops:task-photo-sync-state'), 'camera bridge must not wait on or display global persistence states')
assert(cameraSource.includes("return null"), 'camera bridge must remain a silent native file bridge')
assert(cameraSource.includes('chefops:task-photo-inline-error'), 'camera launch failure must be scoped to the relevant photo group')

assert(taskPageSource.includes('localPhotos'), 'captured photo must be rendered directly in the Task photo group')
assert(taskPageSource.includes('data-task-photo-ui'), 'Task photo controls must be clearly scoped away from draft autosave')
assert(taskPageSource.includes("folderType: 'Task Checklist Photos'"), 'Task upload category must match the Worker media rule')
assert(taskPageSource.includes('重试'), 'a failed photo tile must offer one inline retry action')
assert(taskPageSource.includes('removeLocalPhoto'), 'a failed local photo must be removable without touching saved photos')
assert(!taskPageSource.includes("error(uploadError?.message || 'Unable to upload photo')"), 'photo failure must not create a whole-page error banner')

assert(taskLiveSource.includes("target.matches('input[type=\"file\"]')"), 'file inputs must be excluded from Task draft autosave')
assert(taskLiveSource.includes("target.closest('[data-task-photo-ui]')"), 'all Task photo controls must be excluded from draft autosave')
assert(!taskLiveSource.includes('chefops-autosave-toast'), 'silent autosave must not show a global saved/saving toast')
assert(!taskLiveSource.includes("'保存中…'"), 'silent autosave must not show saving text')
assert(!taskLiveSource.includes("'已保存'"), 'silent autosave must not show misleading saved text')

console.log('TASK_PHOTO_VISIBILITY_TEST_OK=true')
console.log('OFF_DUTY_TASK_VISIBILITY=true')
console.log('ROSTER_FILTERS_TASKS=false')
console.log('ROSTER_BLOCKS_TASK_BOOTSTRAP=false')
console.log('STALE_TASK_SNAPSHOT_PRIMARY=false')
console.log('CAPTURED_PHOTO_PREVIEW_IMMEDIATE=true')
console.log('CAPTURED_PHOTO_RENDER_TARGET=TASK_GRID')
console.log('CAPTURED_PHOTO_OPTIMISTICALLY_VISIBLE=true')
console.log('GLOBAL_TASK_PHOTO_OVERLAYS=false')
console.log('PHOTO_FILE_INPUT_TRIGGERS_AUTOSAVE=false')
console.log('PHOTO_FAILURE_SCOPE=PHOTO_TILE')
console.log('TASK_UPLOAD_FOLDER_RULE_MATCH=true')
console.log('TASK_PHOTO_D1_ONLY=true')
console.log('TASK_PHOTO_PUBLISHED_MEDIA_RULE=true')
console.log('TASK_PHOTO_SHEET_RUNTIME_READ=false')
