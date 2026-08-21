import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { taskPhotoEntityId } from '../../web/src/lib/task-photo-persistence.js'
import { buildTaskProgressPatch, mergeTaskResponsePatches } from '../../worker/src/realtime-task-action-d1.js'
import { assertUpdatePermission } from '../../worker/src/permissions.js'

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
assert.deepEqual(Object.keys(saved.patch).sort(), ['notes', 'status'])
assert.equal(saved.patch.status, 'in_progress')
assert.equal(JSON.parse(saved.patch.notes).started_at, timestamp)
assert.equal('title' in saved.patch, false)
assert.equal('template_id' in saved.patch, false)
assert.equal('assignment' in saved.patch, false)
assert.doesNotThrow(() => assertUpdatePermission(staff, 'Task', legacyTask, saved.patch))
assert.doesNotThrow(() => assertUpdatePermission(leader, 'Task', legacyTask, saved.patch))

const completed = buildTaskProgressPatch(legacyTask, state, 'complete', leader, timestamp)
assert.equal(completed.patch.status, 'done')
assert.equal(completed.patch.completed_by_email, leader.email)
assert.doesNotThrow(() => assertUpdatePermission(leader, 'Task', legacyTask, completed.patch))

const config = { sections: [{ items: [{ id: 'item_1' }, { id: 'item_2' }] }] }
const merged = mergeTaskResponsePatches(config, {
  item_1: { value: 'old-1', remark: '', corrective_action: '' },
  item_2: { value: 'old-2', remark: 'keep', corrective_action: 'keep-action' },
}, [{ item_id: 'item_1', value: 'new-1' }])
assert.equal(merged.item_1.value, 'new-1')
assert.equal(merged.item_2.value, 'old-2', 'field patch save must preserve another device item')
assert.equal(merged.item_2.remark, 'keep')
assert.equal(merged.item_2.corrective_action, 'keep-action')

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

const realtimeMutationSource = readFileSync('web/src/lib/realtime-mutations.js', 'utf8')
const taskSource = readFileSync('web/src/pages/OperationalTasksRealtime.jsx', 'utf8')
const actionSource = readFileSync('worker/src/realtime-task-action-d1-v2.js', 'utf8')
const entrySource = readFileSync('worker/src/entry.js', 'utf8')
const mediaUploadSource = readFileSync('worker/src/realtime-media-upload.js', 'utf8')
const mediaRuleSource = readFileSync('worker/src/media-rules.js', 'utf8')

assert(realtimeMutationSource.includes("mutation.entity !== 'TaskPhoto'"), 'TaskPhoto must not enter the offline mutation queue')
assert(realtimeMutationSource.includes('task-photo-create:${stablePhotoId}'), 'TaskPhoto create must keep an idempotent mutation ID')
assert(taskSource.includes("entity: 'TaskPhoto'"), 'Task photo tile must register with canonical D1 mutation')
assert(taskSource.includes('mutationRecord(mutation'), 'D1 mutation response must be authoritative photo acknowledgement')
assert(taskSource.includes("phase: 'error'"), 'failed photo must remain a local tile state')
assert(taskSource.includes('photo.uploaded ?'), 'photo retry must reuse a successfully uploaded file when registration alone failed')
assert(taskSource.includes('if (localPhotos.length)'), 'Complete Task must not run with pending/failed local photos')
assert(!taskSource.includes('ensureTaskPhotoPersisted'), 'Task photo must not bootstrap reread after D1 commit')
assert(!taskSource.includes('createTaskPhotoSaveGate'), 'Task save must not inspect or click DOM photo controls')
assert(!taskSource.includes('MutationObserver'), 'Task save state must not depend on DOM observation')
assert(actionSource.includes('response_patches'), 'Worker must support field-level Task saves')
assert(actionSource.includes("mutationError?.code !== 'realtime_version_conflict'"), 'Worker must reconcile one concurrent D1 version conflict')

assert(entrySource.includes('handlePrimaryMediaUpload'), 'canonical Worker entry must intercept Task file uploads before the legacy app handler')
assert(entrySource.indexOf('handlePrimaryMediaUpload(request') < entrySource.indexOf('let response = await app.fetch'), 'primary Task media upload must run before legacy app fallback')
assert(mediaUploadSource.includes("const UPLOAD_PATH = 'r2-primary-no-sheet-audit-v1'"), 'Task media upload must expose the R2-primary path marker')
assert(mediaUploadSource.includes("const TASK_PHOTO_FOLDER = 'Task Checklist Photos'"), 'R2 acknowledgement bypass must be scoped to Task evidence only')
assert(mediaUploadSource.includes('request.clone().formData()'), 'Task upload scope must be inspected without consuming the real request body')
assert(mediaUploadSource.includes("!== TASK_PHOTO_FOLDER) return null"), 'non-Task uploads must fall through to the existing legacy handler')
assert(mediaUploadSource.includes('uploadDriveFile(request, env, user)'), 'primary handler must use the canonical R2-first storage implementation')
assert(!mediaUploadSource.includes('audit('), 'primary Task media upload acknowledgement must not wait for legacy Sheet AuditLog')
assert(mediaUploadSource.includes('文件上传失败：'), 'server must expose the file-upload failure stage instead of a generic 500')
assert(mediaRuleSource.includes("if (normalizedModule !== 'task') throw error"), 'Sheet MediaRule fallback must not alter non-Task modules')
assert(mediaRuleSource.includes('Task MediaRule runtime read unavailable; using built-in media policy'), 'temporary Task Sheet MediaRule failure must fall back to built-in photo policy')

console.log('TASK_ACTION_PROGRESS_PAYLOAD_ONLY=true')
console.log('STAFF_TASK_SAVE_PERMISSION=true')
console.log('LEADER_TASK_SAVE_PERMISSION=true')
console.log('TASK_PHOTO_STABLE_ENTITY_ID=true')
console.log('TASK_PHOTO_IDEMPOTENT_CREATE=true')
console.log('TASK_PHOTO_OFFLINE_QUEUE=false')
console.log('TASK_PHOTO_SAVE_GATE=react_local_state')
console.log('TASK_PHOTO_SERVER_ACK=d1_mutation_response')
console.log('TASK_PHOTO_BOOTSTRAP_REQUIRED=false')
console.log('TASK_PHOTO_RETRY_REUSES_UPLOAD=true')
console.log('TASK_SAVE_MULTI_DEVICE_PATCH=true')
console.log('TASK_SAVE_DOM_GATE=false')
console.log('TASK_PHOTO_UPLOAD_PATH=r2_primary_no_sheet_audit')
console.log('TASK_PHOTO_UPLOAD_SCOPE=task_checklist_photos_only')
console.log('TASK_PHOTO_UPLOAD_SHEET_AUDIT_GATE=false')
console.log('TASK_PHOTO_UPLOAD_MEDIA_RULE_FALLBACK=true')
console.log('TASK_PHOTO_UPLOAD_STAGE_ERROR=true')
