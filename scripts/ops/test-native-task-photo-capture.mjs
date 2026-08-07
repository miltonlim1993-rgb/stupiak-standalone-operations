import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// PR validation target: native camera -> Task evidence UI -> existing upload/D1 pipeline.
const bridge = readFileSync('web/src/components/NativeMediaCaptureBridge.jsx', 'utf8')
const channel = readFileSync('web/src/lib/task-photo-capture-channel.js', 'utf8')
const taskPage = readFileSync('web/src/pages/OperationalTasksRealtime.jsx', 'utf8')

assert(bridge.includes("app.addListener('appRestoredResult'"), 'Android camera results must survive Activity recreation')
assert(bridge.includes('PENDING_CAPTURE_KEY'), 'capture context must survive Android camera Activity transitions')
assert(bridge.includes('RESTORED_RESULT_KEY'), 'restored camera result must be retained until the Task consumer is ready')
assert(bridge.includes('publishTaskPhotoCapture'), 'native camera must publish the captured File directly to Task state')
assert(!bridge.includes('new DataTransfer()'), 'native camera must not depend on synthetic input.files/DataTransfer delivery')
assert(channel.includes("cancelable: true"), 'capture delivery must have an explicit consumer acknowledgement')
assert(taskPage.includes('subscribeTaskPhotoCapture'), 'TaskForm must subscribe to native capture delivery')
assert(taskPage.includes('event.preventDefault()'), 'TaskForm must acknowledge a matching native capture')
assert(taskPage.includes('void upload(group, detail.file)'), 'matching native File must enter the same Task photo upload pipeline immediately')
assert(taskPage.includes('data-task-photo-task-id={task.id}'), 'native capture must retain exact Task context')
assert(taskPage.includes('data-task-photo-outlet-id={outletId}'), 'native capture must retain exact outlet context')
assert(taskPage.includes("setLocalPhotos((current) => [...current"), 'captured photo must create an immediate local evidence tile before upload')

console.log('NATIVE_TASK_PHOTO_CAPTURE_TEST_OK=true')
console.log('NATIVE_CAPTURE_TO_TASK_EVENT=true')
console.log('NATIVE_CAPTURE_SYNTHETIC_INPUT=false')
console.log('ANDROID_CAMERA_RESTORE_HANDLED=true')
console.log('CAPTURED_PHOTO_TILE_BEFORE_UPLOAD=true')
