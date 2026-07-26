import test from 'node:test'
import assert from 'node:assert/strict'

import {
  enrichTaskWorkflowV3,
  parseTaskWorkflowV3,
  taskProgressSummary,
  taskStatusKey,
} from '../src/task-workflow-v3.js'

function task(overrides = {}) {
  return {
    id: 'task-1',
    title: 'Toilet Full Cleaning',
    description: 'Complete the full toilet cleaning checklist.',
    status: 'pending',
    access_state: 'OPEN',
    period: 'NIGHT',
    notes: JSON.stringify({
      schema: 'operational-checklist-v1',
      responses: {},
      started_at: '',
      completion_notes: '',
    }),
    config: {
      timezone: 'Asia/Kuching',
      title_cn: '厕所完整清洁',
      title_en: 'Toilet Full Cleaning',
      instruction_cn: '完成厕所完整清洁。',
      instruction_en: 'Complete the full toilet cleaning checklist.',
      schedule: {
        shift_id: 'NIGHT',
        shift_name: 'Evening Shift',
        shift_name_cn: '晚班',
        open_time: '21:00',
        due_time: '23:00',
        lock_time: '23:30',
      },
      sections: [],
      photo_groups: [{ id: 'overview', name: 'Overview', rule: 'REQUIRED', min_photos: 1 }],
    },
    ...overrides,
  }
}

test('maps server access and stored outcomes to stable task statuses', () => {
  assert.equal(taskStatusKey(task({ access_state: 'NOT_OPEN' })), 'locked')
  assert.equal(taskStatusKey(task({ access_state: 'OVERDUE' })), 'overdue')
  assert.equal(taskStatusKey(task({ access_state: 'LOCKED' })), 'overdue')
  assert.equal(taskStatusKey(task({ status: 'in_progress' })), 'in_progress')
  assert.equal(taskStatusKey(task({ status: 'done' })), 'completed')
})

test('issue and unable outcomes never count as completed', () => {
  const issue = task({
    status: 'issue',
    notes: JSON.stringify({ schema: 'operational-checklist-v1', workflow_v3: { outcome: 'issue' } }),
  })
  const unable = task({
    status: 'unable',
    notes: JSON.stringify({ schema: 'operational-checklist-v1', workflow_v3: { outcome: 'unable' } }),
  })
  assert.equal(taskStatusKey(issue), 'issue')
  assert.equal(taskStatusKey(unable), 'issue')
})

test('enriches bilingual display and sheet-controlled time fields', () => {
  const enriched = enrichTaskWorkflowV3(task({ access_state: 'NOT_OPEN' }))
  assert.equal(enriched.display.task_name_cn, '厕所完整清洁')
  assert.equal(enriched.display.task_name_en, 'Toilet Full Cleaning')
  assert.equal(enriched.earliest_start, '21:00')
  assert.equal(enriched.due_time_config, '23:00')
  assert.equal(enriched.timezone, 'Asia/Kuching')
  assert.equal(enriched.photo_requirement, 'required')
  assert.equal(enriched.can_start, false)
  assert.match(enriched.lock_reason_en, /21:00/)
})

test('progress keeps locked separate from overdue and issue', () => {
  const rows = [
    task({ id: 'a', access_state: 'NOT_OPEN' }),
    task({ id: 'b', access_state: 'OVERDUE' }),
    task({ id: 'c', status: 'done', access_state: 'DONE' }),
    task({ id: 'd', status: 'in_progress' }),
    task({
      id: 'e',
      status: 'issue',
      notes: JSON.stringify({ schema: 'operational-checklist-v1', workflow_v3: { outcome: 'issue' } }),
    }),
  ]
  const summary = taskProgressSummary(rows)
  assert.equal(summary.NIGHT.total, 5)
  assert.equal(summary.NIGHT.locked, 1)
  assert.equal(summary.NIGHT.overdue, 1)
  assert.equal(summary.NIGHT.completed, 1)
  assert.equal(summary.NIGHT.in_progress, 1)
  assert.equal(summary.NIGHT.issue, 1)
  assert.deepEqual(summary.ALL, { shift_id: 'ALL', total: 5, completed: 1, pending: 0, in_progress: 1, locked: 1, issue: 1, overdue: 1 })
})

test('parses workflow metadata without losing operational state', () => {
  const parsed = parseTaskWorkflowV3(task({
    notes: JSON.stringify({
      schema: 'operational-checklist-v1',
      responses: { item: { value: 'Ready' } },
      workflow_v3: { outcome: 'issue', issue_type: 'equipment_problem' },
    }),
  }))
  assert.equal(parsed.state.responses.item.value, 'Ready')
  assert.equal(parsed.workflow.issue_type, 'equipment_problem')
})
