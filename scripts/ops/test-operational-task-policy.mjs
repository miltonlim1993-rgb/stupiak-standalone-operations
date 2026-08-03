import assert from 'node:assert/strict'
import { applyOperationalTaskPolicyPayload as applyServerPolicy } from '../../worker/src/operational-task-policy.js'
import { applyOperationalTaskPayloadPolicy as applyClientPolicy } from '../../web/src/lib/operational-task-policy.js'

const sample = {
  tasks: [
    {
      id: 'task-opening',
      template_id: 'tmpl-rr-opening-checklist-v3',
      title: 'Opening Preparation Check',
      config: {
        photo_groups: [
          { id: 'opening-sauce', max_photos: 2 },
          { id: 'opening-material', max_photos: 4 },
        ],
      },
      photo_requirements: [
        { id: 'opening-sauce', max_photos: 2, uploaded_count: 1 },
      ],
    },
    {
      id: 'task-daily-standards',
      template_id: 'tmpl-rr-daily-standards-v4',
      title: 'Daily Operations Standards Check',
      config: { photo_groups: [{ id: 'daily-standard', max_photos: 2 }] },
      photo_requirements: [{ id: 'daily-standard', max_photos: 2 }],
    },
    {
      id: 'task-unrelated',
      template_id: 'tmpl-night-closing-v1',
      title: 'Night Closing Check',
      config: { photo_groups: [{ id: 'night-close', max_photos: 1 }] },
      photo_requirements: [{ id: 'night-close', max_photos: 1 }],
    },
  ],
  task_photos: [
    { id: 'photo-opening', task_id: 'task-opening' },
    { id: 'photo-retired', task_id: 'task-daily-standards' },
    { id: 'photo-unrelated', task_id: 'task-unrelated' },
    { id: 'photo-unlinked', task_id: '' },
  ],
  template_photos: [
    { id: 'template-photo-opening', template_id: 'tmpl-rr-opening-checklist-v3' },
    { id: 'template-photo-retired', template_id: 'tmpl-rr-daily-standards-v4' },
    { id: 'template-photo-unrelated', template_id: 'tmpl-night-closing-v1' },
  ],
}

function verify(label, result) {
  assert.equal(result.tasks.length, 2, `${label}: exactly the retained opening and unrelated task must remain`)
  assert.deepEqual(
    result.tasks.map((task) => task.template_id),
    ['tmpl-rr-opening-checklist-v3', 'tmpl-night-closing-v1'],
    `${label}: retired Daily Standards task must be filtered without hiding unrelated tasks`,
  )

  for (const task of result.tasks) {
    for (const group of task.config?.photo_groups || []) {
      assert.equal(group.max_photos, 10, `${label}: every returned photo group must support ten photos`)
      assert.match(group.grouping_guidance_cn || '', /同类物品/, `${label}: Chinese grouping guidance must be present`)
      assert.match(group.grouping_guidance_en || '', /matching items together/i, `${label}: English grouping guidance must be present`)
    }
    for (const requirement of task.photo_requirements || []) {
      assert.equal(requirement.max_photos, 10, `${label}: every photo requirement must support ten photos`)
    }
    assert.equal(task.photo_policy?.max_photos_per_group, 10, `${label}: task photo policy metadata must be ten`)
  }

  assert.deepEqual(
    result.task_photos.map((photo) => photo.id),
    ['photo-opening', 'photo-unrelated', 'photo-unlinked'],
    `${label}: photos attached to the retired duplicate task must not leak into the list`,
  )
  assert.deepEqual(
    result.template_photos.map((photo) => photo.id),
    ['template-photo-opening', 'template-photo-unrelated'],
    `${label}: retired template photos must be filtered`,
  )
  assert.equal(result.operational_task_policy?.retained_template_id, 'tmpl-rr-opening-checklist-v3')
  assert.deepEqual(result.operational_task_policy?.retired_template_ids, ['tmpl-rr-daily-standards-v4'])
  assert.equal(result.operational_task_policy?.max_photos_per_group, 10)
}

const serverResult = applyServerPolicy(structuredClone(sample))
const clientResult = applyClientPolicy(structuredClone(sample))
verify('server policy', serverResult)
verify('client policy', clientResult)
assert.deepEqual(clientResult, serverResult, 'server and client task policy outputs must remain equivalent')

console.log('OPERATIONAL_TASK_POLICY_TEST_OK=true')
console.log('CANONICAL_TASK=tmpl-rr-opening-checklist-v3')
console.log('RETIRED_TASK=tmpl-rr-daily-standards-v4')
console.log('PHOTO_LIMIT=10')
console.log('HISTORICAL_RECORD_DELETE=false')
