import assert from 'node:assert/strict'
import test from 'node:test'

import { normalizeTaskWorkflowShiftView } from '../../web/src/lib/task-shift-view-v3.js'

function task(id, shiftId, opensAt, locksAt, statusKey = 'pending') {
  return {
    id,
    shift_id: shiftId,
    status_key: statusKey,
    opens_at: opensAt,
    locks_at: locksAt,
    due_at: locksAt,
    config: { schedule: { shift_id: shiftId } },
  }
}

test('SHIFT_CONTROLLED task follows the active morning shift', () => {
  const result = normalizeTaskWorkflowShiftView({
    server_time: '2026-07-27T03:00:00.000Z',
    current_shift_id: 'MORNING',
    tasks: [
      task('morning', 'MORNING', '2026-07-27T02:00:00.000Z', '2026-07-27T07:30:00.000Z'),
      task('quick', 'SHIFT_CONTROLLED', '2026-07-27T02:00:00.000Z', '2026-07-27T12:59:00.000Z'),
      task('night', 'NIGHT', '2026-07-27T13:00:00.000Z', '2026-07-27T15:45:00.000Z'),
    ],
  })

  assert.equal(result.current_shift_id, 'MORNING')
  assert.equal(result.tasks.find((row) => row.id === 'quick').shift_id, 'MORNING')
  assert.equal(result.tasks.find((row) => row.id === 'quick').source_shift_id, 'SHIFT_CONTROLLED')
  assert.equal(result.progress.MORNING.total, 2)
  assert.equal(result.progress.NIGHT.total, 1)
  assert.equal(result.progress.ALL.total, 3)
})

test('SHIFT_CONTROLLED task follows the active evening shift', () => {
  const result = normalizeTaskWorkflowShiftView({
    server_time: '2026-07-27T13:15:00.000Z',
    current_shift_id: 'NIGHT',
    tasks: [
      task('morning', 'MORNING', '2026-07-27T02:00:00.000Z', '2026-07-27T07:30:00.000Z'),
      task('quick', 'SHIFT_CONTROLLED', '2026-07-27T02:00:00.000Z', '2026-07-27T12:59:00.000Z', 'overdue'),
      task('night', 'NIGHT', '2026-07-27T13:00:00.000Z', '2026-07-27T15:45:00.000Z'),
    ],
  })

  assert.equal(result.current_shift_id, 'NIGHT')
  assert.equal(result.tasks.find((row) => row.id === 'quick').shift_id, 'NIGHT')
  assert.equal(result.progress.MORNING.total, 1)
  assert.equal(result.progress.NIGHT.total, 2)
  assert.equal(result.progress.NIGHT.overdue, 1)
})
