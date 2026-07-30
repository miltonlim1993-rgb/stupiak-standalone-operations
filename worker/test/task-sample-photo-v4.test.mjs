import test from 'node:test'
import assert from 'node:assert/strict'

import {
  firstSamplePhotoForGroup,
  samplePhotosForGroup,
} from '../../web/src/lib/task-sample-photo-v4.js'

test('maps enabled sample photos to the matching checklist photo group', () => {
  const samples = [
    { id: 'wrong', photo_type: 'toilet-floor', display_order: 1, enabled: true },
    { id: 'second', photo_type: 'toilet-basin', display_order: 2, enabled: 'TRUE' },
    { id: 'first', photo_type: 'checklist:toilet-basin', display_order: 1, enabled: true },
    { id: 'disabled', photo_type: 'toilet-basin', display_order: 0, enabled: false },
    { id: 'deleted', photo_type: 'toilet-basin', display_order: 0, enabled: true, deleted_at: '2026-07-27' },
  ]

  assert.deepEqual(
    samplePhotosForGroup(samples, 'toilet-basin').map((row) => row.id),
    ['first', 'second'],
  )
  assert.equal(firstSamplePhotoForGroup(samples, 'toilet-basin')?.id, 'first')
  assert.equal(firstSamplePhotoForGroup(samples, 'missing'), null)
})
