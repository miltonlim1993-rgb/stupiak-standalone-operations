import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  OPERATIONAL_TASK_AUDIENCE_POLICY,
  canExecuteOperationalTask,
  canonicalOperationalShift,
  decorateOperationalTaskForUser,
  operationalTaskAssignment,
} from '../../worker/src/operational-task-audience.js'

const staffA = {
  id: 'user-a',
  email: 'a@example.com',
  role: 'staff',
  outlet_id: 'RR-KCH',
  outlet_ids: '["RR-KCH"]',
}
const staffB = {
  id: 'user-b',
  email: 'b@example.com',
  role: 'staff',
  outlet_id: 'RR-KCH',
  outlet_ids: '["RR-KCH"]',
}
const leader = {
  id: 'leader-1',
  email: 'leader@example.com',
  role: 'leader',
  outlet_id: 'RR-KCH',
  outlet_ids: '["RR-KCH"]',
}
const manager = {
  id: 'manager-1',
  email: 'manager@example.com',
  role: 'manager',
  outlet_id: 'RR-KCH',
  outlet_ids: '["RR-KCH"]',
}

const directTask = {
  id: 'task-direct',
  outlet_id: 'RR-KCH',
  due_date: '2026-08-03',
  status: 'pending',
  access_state: 'OPEN',
  assigned_to_user_id: 'user-a',
  assigned_to_name: 'Staff A',
  assigned_to_role: 'staff',
  period: 'MORNING',
  config: { schedule: { shift_id: 'MORNING' } },
}

assert.equal(canExecuteOperationalTask(staffA, directTask), true, 'direct assignee must be able to execute')
assert.equal(canExecuteOperationalTask(staffB, directTask), false, 'another staff member may view but cannot execute a directly assigned task')
assert.equal(canExecuteOperationalTask(manager, directTask), true, 'manager must retain operational override')
assert.deepEqual(operationalTaskAssignment(directTask), {
  mode: 'user',
  user_id: 'user-a',
  role: 'staff',
  name: 'Staff A',
  label: 'Staff A',
})

const roleTask = {
  ...directTask,
  id: 'task-role-staff',
  assigned_to_user_id: '',
  assigned_to_name: '',
  assigned_to_role: 'staff',
}
assert.equal(canExecuteOperationalTask(staffA, roleTask), true)
assert.equal(canExecuteOperationalTask(staffB, roleTask), true)
assert.equal(canExecuteOperationalTask(leader, roleTask), true, 'leader may execute staff-role work')
assert.equal(canExecuteOperationalTask(manager, roleTask), true)

const leaderTask = {
  ...roleTask,
  id: 'task-role-leader',
  assigned_to_role: 'leader',
}
assert.equal(canExecuteOperationalTask(staffA, leaderTask), false)
assert.equal(canExecuteOperationalTask(leader, leaderTask), true)
assert.equal(canExecuteOperationalTask(manager, leaderTask), true)

const viewerCopy = decorateOperationalTaskForUser(directTask, staffB)
assert.equal(viewerCopy.can_view, true, 'off-duty/non-assignee outlet member must still receive the task')
assert.equal(viewerCopy.can_execute, false)
assert.equal(viewerCopy.assignment_read_only, true)
assert.equal(viewerCopy.assignment_access_state, 'VIEW_ONLY')
assert.equal(viewerCopy.time_access_state, 'OPEN')
assert.equal(viewerCopy.access_state, 'LOCKED', 'existing clients must open non-assignee tasks in read-only mode')
assert.equal(viewerCopy.attendance_required_for_visibility, false)
assert.equal(viewerCopy.visibility_scope, 'assigned_outlet')
assert.equal(viewerCopy.assigned_to_user_id, 'user-a', 'response decoration must not erase assignment')

const assigneeCopy = decorateOperationalTaskForUser(directTask, staffA)
assert.equal(assigneeCopy.can_view, true)
assert.equal(assigneeCopy.can_execute, true)
assert.equal(assigneeCopy.access_state, 'OPEN')
assert.equal(assigneeCopy.assigned_to_user_id, 'user-a')

const completedViewerCopy = decorateOperationalTaskForUser({ ...directTask, status: 'done', access_state: 'DONE' }, staffB)
assert.equal(completedViewerCopy.access_state, 'DONE', 'completed state must not be rewritten as assignment lock')
assert.equal(completedViewerCopy.can_view, true)
assert.equal(completedViewerCopy.can_execute, false)

assert.equal(canonicalOperationalShift({ period: 'OPENING' }), 'MORNING')
assert.equal(canonicalOperationalShift({ period: 'closing' }), 'NIGHT')
assert.equal(canonicalOperationalShift({ period: 'unknown custom shift' }), 'DAILY')
assert.equal(canonicalOperationalShift({}), 'DAILY')

const unknownShiftCopy = decorateOperationalTaskForUser({
  ...roleTask,
  id: 'task-unknown-shift',
  period: 'PREP-CREW',
  config: { schedule: { shift_id: 'PREP-CREW' } },
}, staffA)
assert.equal(unknownShiftCopy.period, 'DAILY')
assert.equal(unknownShiftCopy.shift_id, 'DAILY')
assert.equal(unknownShiftCopy.config.schedule.shift_id, 'DAILY')
assert.equal(unknownShiftCopy.config.schedule.source_shift_id, 'PREP-CREW')

const outletTasks = [directTask, roleTask, leaderTask]
const visibleToStaffB = outletTasks.map((task) => decorateOperationalTaskForUser(task, staffB))
assert.equal(visibleToStaffB.length, outletTasks.length, 'audience policy must decorate, never filter, outlet tasks')
assert(visibleToStaffB.every((task) => task.can_view === true))
assert.equal(visibleToStaffB.filter((task) => task.can_execute).length, 1, 'assignment still controls execution separately from visibility')

assert.equal(OPERATIONAL_TASK_AUDIENCE_POLICY.attendance_required, false)
assert.equal(OPERATIONAL_TASK_AUDIENCE_POLICY.visibility_scope, 'assigned_outlet_members')
assert.equal(OPERATIONAL_TASK_AUDIENCE_POLICY.unassigned_access, 'view_only')
assert.equal(OPERATIONAL_TASK_AUDIENCE_POLICY.assignment_enforced, true)
assert.equal(OPERATIONAL_TASK_AUDIENCE_POLICY.unknown_shift_fallback, 'DAILY')

const entrySource = readFileSync('worker/src/entry.js', 'utf8')
const audienceSource = readFileSync('worker/src/operational-task-audience.js', 'utf8')

assert(
  entrySource.indexOf('const taskAssignmentResponse = await guardOperationalTaskAssignment')
    < entrySource.indexOf('const d1TaskResponse ='),
  'assignment guard must run before D1 task action',
)
assert(
  entrySource.indexOf('const taskPhotoAssignmentResponse = await guardOperationalTaskPhotoAssignment')
    < entrySource.indexOf('const taskPhotoResponse = await handleRealtimeTaskPhotoMutation'),
  'assignment guard must run before TaskPhoto mutation validation',
)
assert(
  entrySource.indexOf('await applyOperationalTaskPolicyResponse')
    < entrySource.indexOf('await applyOperationalTaskAudienceResponse'),
  'audience decoration must run after canonical task policy filtering',
)
assert.match(entrySource, /realtime-resilience-v23-device-outbox-batch-sync/)
assert.match(audienceSource, /attendance_required: false/)
assert.match(audienceSource, /visibility_scope: 'assigned_outlet_members'/)
assert.match(audienceSource, /unassigned_access: 'view_only'/)
assert.match(audienceSource, /unknown_shift_fallback: 'DAILY'/)
assert.doesNotMatch(audienceSource, /INSERT INTO ops_records/)
assert.doesNotMatch(audienceSource, /UPDATE ops_records/)
assert.doesNotMatch(audienceSource, /listRecords\(env, 'Attendance'/)

console.log('OPERATIONAL_TASK_AUDIENCE_TEST_OK=true')
console.log('OFF_DUTY_VISIBILITY=true')
console.log('ATTENDANCE_REQUIRED_FOR_VISIBILITY=false')
console.log('ASSIGNMENT_FIELDS_RETAINED=true')
console.log('UNASSIGNED_ACCESS=VIEW_ONLY')
console.log('TASK_ACTION_ASSIGNMENT_GUARD=true')
console.log('TASK_PHOTO_ASSIGNMENT_GUARD=true')
console.log('UNKNOWN_SHIFT_FALLBACK=DAILY')
console.log('TASK_AUDIENCE_D1_WRITES=false')
console.log('D1_MIGRATION_RUN=false')
