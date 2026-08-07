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
assert.equal(merged.task_photos.length, 1, 'captured photo must remain visible before D1 acknowledgement')
assert.equal(merged.task_photos[0].client_upload_state, 'uploading')

commitOptimisticTaskPhoto(mutation, {
  record: {
    ...mutation.payload,
    __realtime: { version: 1, sync_status: 'pending' },
  },
})
merged = mergeOptimisticTaskPhotos({ task_photos: [] }, { outletId: 'RR-KCH' })
assert.equal(merged.task_photos.length, 1, 'committed photo must remain visible while other caches catch up')
assert.equal(merged.task_photos[0].client_upload_state, 'committed')

merged = mergeOptimisticTaskPhotos({ task_photos: [{ ...mutation.payload, updated_date: '2026-08-03T04:01:00.000Z' }] }, { outletId: 'RR-KCH' })
assert.equal(merged.task_photos.length, 1, 'server copy must deduplicate an optimistic photo')
assert.equal(merged.optimistic_task_photo_count, 0)

trackOptimisticTaskPhoto({ ...mutation, entity_id: 'photo-2', payload: { ...mutation.payload, id: 'photo-2' } }, 'uploading')
rejectOptimisticTaskPhoto({ ...mutation, entity_id: 'photo-2', payload: { ...mutation.payload, id: 'photo-2' } }, 'rejected')
merged = mergeOptimisticTaskPhotos({ task_photos: [] }, { outletId: 'RR-KCH' })
assert.equal(merged.task_photos.length, 0, 'rejected evidence must not be shown as saved')

const rosterSource = readFileSync('web/src/lib/roster-task-assignment.js', 'utf8')
assert(rosterSource.includes('mergeOptimisticTaskPhotos'), 'roster wrapper must preserve optimistic TaskPhoto records')
assert(rosterSource.includes("cache_mode: 'live-d1-roster-background'"), 'task bootstrap must use live D1 data immediately')
assert(rosterSource.includes('blocks_task_bootstrap: false'), 'roster metadata must never block Task bootstrap')
assert(rosterSource.includes('void refreshRosterInBackground(args)'), 'roster refresh must remain background-only')
assert(rosterSource.includes('attendance_required_for_visibility: false'), 'attendance must not control Task visibility')
assert(!rosterSource.includes('Promise.all([dataPromise, rosterPromise])'), 'Task bootstrap must not wait for Attendance')
assert(!rosterSource.includes('decorated.filter((task) => task.assigned_to_current_user)'), 'off-duty staff must not lose Task visibility')

const realtimePhotoSource = readFileSync('worker/src/realtime-task-photo.js', 'utf8')
assert(realtimePhotoSource.includes('publishedTaskTemplates'), 'TaskPhoto validation must use the published Task package')
assert(realtimePhotoSource.includes('publishedTaskMediaRule'), 'TaskPhoto media validation must use the published core package')
assert(realtimePhotoSource.includes('d1TaskPhotos'), 'TaskPhoto counts must come from D1')
assert(realtimePhotoSource.includes('d1-published-package-v3'), 'TaskPhoto response must expose the verified D1 path')
assert(!realtimePhotoSource.includes("from './sheets.js'"), 'TaskPhoto mutation must not read Sheets at runtime')
assert(!realtimePhotoSource.includes('listRecords('), 'TaskPhoto mutation must not fall back to Sheet records')

const appSource = readFileSync('web/src/App.jsx', 'utf8')
const cameraSource = readFileSync('web/src/components/NativeMediaCaptureBridge.jsx', 'utf8')
const taskSource = readFileSync('web/src/pages/OperationalTasksRealtime.jsx', 'utf8')
const taskPhotoCss = readFileSync('web/src/operational-task-policy.css', 'utf8')

assert(!appSource.includes('TaskPhotoSyncStatus'), 'global TaskPhoto status overlay must not be mounted')
assert(!cameraSource.includes('chefops:task-photo-sync-state'), 'camera bridge must not wait on global persistence state')
assert(cameraSource.includes('return null'), 'camera bridge must remain a silent native file bridge')
assert(cameraSource.includes('chefops:task-photo-inline-error'), 'camera launch errors must stay scoped to one photo group')

assert(taskSource.includes('localPhotos'), 'captured photos must render directly in their Task group')
assert(taskSource.includes('data-task-photo-ui'), 'Task photo controls must remain scoped from checklist autosave')
assert(taskSource.includes("folderType: 'Task Checklist Photos'"), 'Task upload category must match Worker media policy')
assert(taskSource.includes("entity: 'TaskPhoto'"), 'Task photos must register through the canonical realtime D1 mutation')
assert(taskSource.includes('mutationRecord(mutation'), 'successful D1 mutation response must be the photo commit acknowledgement')
assert(taskSource.includes('removeLocalPhoto(localId)'), 'local preview must clear immediately after D1 acknowledgement')
assert(taskSource.includes('重试'), 'failed photo tile must expose a local retry action')
assert(taskSource.includes('removeLocalPhoto'), 'failed local photo must be removable without touching saved photos')
assert(taskSource.includes('<MediaLightbox'), 'saved and local Task photos must retain full-screen preview/zoom')
assert(!taskSource.includes('ensureTaskPhotoPersisted'), 'photo success must not depend on a full Task bootstrap reread')
assert(!taskSource.includes('MutationObserver'), 'photo saving must not infer success from DOM mutations')
assert(!taskSource.includes('setInterval('), 'Task page must not poll to confirm photos')
assert(taskSource.includes('if (localPhotos.length)'), 'Complete must wait for pending/failed local photos')

assert(taskSource.includes('aria-label="打开刚拍摄的任务照片"'), 'failed/local photo image itself must remain the primary zoom control')
assert(taskSource.includes('data-task-photo-local-state={photo.phase}'), 'local photo tile must expose explicit state without replacing the image')
assert(taskSource.includes('data-task-photo-error-actions'), 'retry/delete actions must render in their own block below the image')
assert(!taskSource.includes('className="absolute inset-0 flex flex-col items-center justify-center gap-2 rounded-xl bg-black/70 p-2 text-center"'), 'failed photo must not render a full-card error overlay')
assert(!taskPhotoCss.includes('[data-task-photo-ui] > button +'), 'failed photo preview must be owned by React structure, not a CSS overlay workaround')

console.log('TASK_PHOTO_VISIBILITY_TEST_OK=true')
console.log('OFF_DUTY_TASK_VISIBILITY=true')
console.log('ROSTER_FILTERS_TASKS=false')
console.log('ROSTER_BLOCKS_TASK_BOOTSTRAP=false')
console.log('CAPTURED_PHOTO_PREVIEW_IMMEDIATE=true')
console.log('PHOTO_FAILURE_SCOPE=PHOTO_TILE')
console.log('FAILED_PHOTO_PREVIEW_UNOBSTRUCTED=true')
console.log('FAILED_PHOTO_ACTIONS_BELOW_PREVIEW=true')
console.log('FAILED_PHOTO_REACT_STRUCTURE=true')
console.log('TASK_UPLOAD_FOLDER_RULE_MATCH=true')
console.log('TASK_PHOTO_D1_ONLY=true')
console.log('TASK_PHOTO_PUBLISHED_MEDIA_RULE=true')
console.log('TASK_PHOTO_DIRECT_D1_ACK=true')
console.log('TASK_PHOTO_BOOTSTRAP_CONFIRMATION=false')
console.log('TASK_PHOTO_FULLSCREEN_PREVIEW=true')
console.log('TASK_PHOTO_COMPLETE_GATE=LOCAL_PENDING_ONLY')
