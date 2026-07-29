import test from 'node:test'
import assert from 'node:assert/strict'

import {
  applyLabelContentOrientation,
  resolveLabelContentOrientation,
} from '../../web/src/lib/label-content-orientation-v7.js'

const SAMPLE = '<!doctype html><html><head></head><body><div class="label"><div class="title">PORK PATTY</div><div class="barcode-wrap"><div class="time-box"></div></div></div></body></html>'

test('auto follows 40x30 landscape media without rotating or swapping dimensions', () => {
  const layout = resolveLabelContentOrientation({
    label_width_mm: 40,
    label_height_mm: 30,
    orientation: 'auto',
  })

  assert.equal(layout.width_mm, 40)
  assert.equal(layout.height_mm, 30)
  assert.equal(layout.media_orientation, 'landscape')
  assert.equal(layout.content_orientation, 'landscape')
  assert.equal(layout.rotate_content, false)
})

test('portrait preference rotates only the content inside fixed 40x30 media', () => {
  const result = applyLabelContentOrientation(SAMPLE, {
    label_width_mm: 40,
    label_height_mm: 30,
    orientation: 'portrait',
  })

  assert.equal(result.layout.width_mm, 40)
  assert.equal(result.layout.height_mm, 30)
  assert.equal(result.layout.content_width_mm, 30)
  assert.equal(result.layout.content_height_mm, 40)
  assert.equal(result.layout.rotate_content, true)
  assert.match(result.html, /translateX\(40mm\) rotate\(90deg\)/)
  assert.match(result.html, /data-chefops-force-raster-orientation="1"/)
})

test('landscape preference stays unrotated on 40x30 media', () => {
  const result = applyLabelContentOrientation(SAMPLE, {
    label_width_mm: 40,
    label_height_mm: 30,
    orientation: 'landscape',
  })

  assert.equal(result.layout.rotate_content, false)
  assert.equal(result.layout.content_width_mm, 40)
  assert.equal(result.layout.content_height_mm, 30)
  assert.doesNotMatch(result.html, /chefops-content-orientation/)
})

test('landscape preference rotates only content inside fixed 30x40 portrait media', () => {
  const result = applyLabelContentOrientation(SAMPLE, {
    label_width_mm: 30,
    label_height_mm: 40,
    orientation: 'landscape',
  })

  assert.equal(result.layout.width_mm, 30)
  assert.equal(result.layout.height_mm, 40)
  assert.equal(result.layout.content_width_mm, 40)
  assert.equal(result.layout.content_height_mm, 30)
  assert.equal(result.layout.rotate_content, true)
  assert.match(result.html, /translateX\(30mm\) rotate\(90deg\)/)
})
