import assert from 'node:assert/strict'
import test from 'node:test'

import {
  attachScheduledTaskAssignees,
  practicalTaskAppliesOnDate,
} from '../src/task-practical-schedule-v5.js'

function monthly(weekOfMonth, weekday = 'WE') {
  return {
    recurrence: {
      frequency: 'MONTHLY_NTH_WEEKDAY',
      weekday,
      week_of_month: weekOfMonth,
    },
  }
}

test('whiteboard July dates map to the intended monthly weekday rotation', () => {
  assert.equal(practicalTaskAppliesOnDate(monthly(1), '2026-07-01'), true)
  assert.equal(practicalTaskAppliesOnDate(monthly(2), '2026-07-08'), true)
  assert.equal(practicalTaskAppliesOnDate(monthly(3), '2026-07-15'), true)
  assert.equal(practicalTaskAppliesOnDate(monthly(4), '2026-07-22'), true)
  assert.equal(practicalTaskAppliesOnDate({ recurrence: { frequency: 'MONTHLY_LAST_WEEKDAY', weekday: 'TH' } }, '2026-07-30'), true)
})

test('monthly tasks do not appear on unrelated dates', () => {
  assert.equal(practicalTaskAppliesOnDate(monthly(1), '2026-07-08'), false)
  assert.equal(practicalTaskAppliesOnDate(monthly(4), '2026-07-29'), false)
  assert.equal(practicalTaskAppliesOnDate({ recurrence: { frequency: 'MONTHLY_LAST_WEEKDAY', weekday: 'TH' } }, '2026-07-23'), false)
  assert.equal(practicalTaskAppliesOnDate({}, '2026-07-23'), true)
})

test('assignee comes only from the duty roster schedule', () => {
  const task = {
    id: 'task-week-1',
    template_id: 'tmpl-week-1',
    config: {
      schedule: { open_time: '14:00', due_time: '17:00' },
      assignment: {
        mode: 'ROSTER',
        prefer_roles: ['staff', 'leader'],
        prefer_duty_codes: ['DF'],
        minimum_overlap_minutes: 60,
      },
    },
  }
  const roster = [
    {
      id: 'roster-a',
      date: '2026-07-01',
      staff_name: 'Scheduled Staff A',
      staff_role: 'Staff',
      clock_in: '11:00',
      clock_out: '18:00',
      status: 'scheduled',
      notes: 'Imported from weekly duty roster; planned duties: 11:00-18:00 P. Scheduled shift only.',
    },
    {
      id: 'roster-b',
      date: '2026-07-01',
      staff_name: 'Scheduled Staff B',
      staff_role: 'Staff',
      clock_in: '11:00',
      clock_out: '18:00',
      status: 'scheduled',
      notes: 'Imported from weekly duty roster; planned duties: 11:00-18:00 DF. Scheduled shift only.',
    },
  ]

  const [assigned] = attachScheduledTaskAssignees([task], roster, '2026-07-01')
  assert.equal(assigned.assigned_to_name, 'Scheduled Staff B')
  assert.equal(assigned.assigned_schedule_id, 'roster-b')
  assert.equal(assigned.assignment_source, 'DUTY_ROSTER_SCHEDULE')
})

test('no roster row means no invented employee name', () => {
  const task = {
    id: 'task-week-1',
    config: {
      schedule: { open_time: '14:00', due_time: '17:00' },
      assignment: { mode: 'ROSTER' },
    },
  }
  const [unassigned] = attachScheduledTaskAssignees([task], [], '2026-07-01')
  assert.equal(unassigned.assigned_to_name, undefined)
  assert.equal(unassigned.assignment_source, undefined)
})
