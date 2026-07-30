import test from 'node:test'
import assert from 'node:assert/strict'

import {
  applyCreatedLabelSizeContract,
  resolveLabelSizeContract,
} from '../../web/src/lib/label-size-contract-v14.js'

test('explicit future printer media remains the single created and raster size', () => {
  const contract = resolveLabelSizeContract({
    label_width_mm: 50,
    label_height_mm: 25,
    dpi: 300,
    orientation: 'auto',
  })

  assert.equal(contract.physical_width_mm, 50)
  assert.equal(contract.physical_height_mm, 25)
  assert.equal(contract.created_canvas_width_mm, 50)
  assert.equal(contract.created_canvas_height_mm, 25)
  assert.equal(contract.raster_width_dots, 591)
  assert.equal(contract.raster_height_dots, 295)
})

test('when no saved profile exists, the creator page size is preserved instead of being forced to 40x30', () => {
  const html = '<!doctype html><html><head><style>@page { size: 50mm 25mm; margin:0 }</style></head><body><div class="label">TEST</div></body></html>'
  const result = applyCreatedLabelSizeContract(html, {
    label_width_mm: 50,
    label_height_mm: 25,
    dpi: 203,
    orientation: 'auto',
  })

  assert.equal(result.contract.physical_width_mm, 50)
  assert.equal(result.contract.physical_height_mm, 25)
  assert.equal(result.source_matched_setting, true)
  assert.match(result.html, /@page\{size:50mm 25mm!important/)
})
