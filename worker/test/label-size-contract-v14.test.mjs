import test from 'node:test'
import assert from 'node:assert/strict'

import {
  applyCreatedLabelSizeContract,
  auditLabelSizeChain,
  extractLastPageSizeMm,
  resolveLabelSizeContract,
} from '../../web/src/lib/label-size-contract-v14.js'
import { applyPrinterLayoutToHtml } from '../../web/src/lib/label-printer-profile.js'
import { applyLabelContentOrientation } from '../../web/src/lib/label-content-orientation-v7.js'
import { buildTsplFoodLabelCommand } from '../../web/src/lib/tspl-food-label-compat.js'

const foodLabelHtml = `<!doctype html>
<html><head><style>@page { size: 60mm 40mm; margin: 0; }.label{width:60mm;height:40mm}</style></head>
<body><div class="label"><div class="top"><div class="title">PORK PATTY</div><div class="context"><span>PREP</span><span>•</span><span class="storage">CHILLER</span></div></div><div class="times"><div class="time-box"><div class="time-head"><span>Made</span><strong>14:22</strong></div><div class="time-date">29 JUL 2026</div></div><div class="time-box"><div class="time-head"><span>Use By</span><strong>14:22</strong></div><div class="time-date">30 JUL 2026</div></div></div><div class="operator">BY: TEST</div><div class="barcode-wrap"><div class="batch">BATCH PP-260729-001</div><div class="barcode">9551234567890</div></div></div></body></html>`

const profile = {
  label_width_mm: 40,
  label_height_mm: 30,
  dpi: 203,
  orientation: 'landscape',
  padding_top_mm: 1.2,
  padding_right_mm: 1.7,
  padding_bottom_mm: 0.75,
  padding_left_mm: 1.7,
}

test('40x30 mm at 203 dpi resolves to one exact 320x240-dot created canvas', () => {
  const contract = resolveLabelSizeContract(profile)
  assert.equal(contract.physical_width_mm, 40)
  assert.equal(contract.physical_height_mm, 30)
  assert.equal(contract.created_canvas_width_mm, 40)
  assert.equal(contract.created_canvas_height_mm, 30)
  assert.equal(contract.raster_width_dots, 320)
  assert.equal(contract.raster_height_dots, 240)
  assert.equal(contract.android_width_mils, 1575)
  assert.equal(contract.android_height_mils, 1181)
  assert.equal(contract.signature, '40.0x30.0mm@203dpi=320x240dots')
})

test('an old 60x40 creator document is rewritten to the 40x30 printer setting before printing', () => {
  const created = applyCreatedLabelSizeContract(foodLabelHtml, profile)
  assert.deepEqual(created.source_dimensions, { width_mm: 60, height_mm: 40 })
  assert.equal(created.source_matched_setting, false)
  assert.deepEqual(extractLastPageSizeMm(created.html), { width_mm: 40, height_mm: 30 })
  assert.match(created.html, /name="chefops-created-label-geometry" content="40\.0x30\.0mm@203dpi=320x240dots"/)
  assert.match(created.html, /@page\{size:40mm 30mm!important;margin:0!important\}/)
  assert.match(created.html, /\.label\{[^}]*width:40mm!important[^}]*height:30mm!important/)
})

test('portrait changes only the content plane while the created physical page remains 40x30', () => {
  const portraitProfile = { ...profile, orientation: 'portrait' }
  const oriented = applyLabelContentOrientation(foodLabelHtml, portraitProfile)
  const created = applyCreatedLabelSizeContract(oriented.html, portraitProfile)

  assert.deepEqual(extractLastPageSizeMm(created.html), { width_mm: 40, height_mm: 30 })
  assert.equal(created.contract.content_width_mm, 30)
  assert.equal(created.contract.content_height_mm, 40)
  assert.equal(created.contract.rotate_content, true)
  assert.match(created.html, /width:30mm!important/)
  assert.match(created.html, /height:40mm!important/)
  assert.match(created.html, /translateX\(40mm\) rotate\(90deg\)!important/)
})

test('final HTML layout, raster contract and native TSPL command use the same physical size', () => {
  const created = applyCreatedLabelSizeContract(foodLabelHtml, profile)
  const finalLayout = applyPrinterLayoutToHtml(created.html, profile)
  const tspl = buildTsplFoodLabelCommand(finalLayout.html, {
    commandLanguage: 'tspl',
    widthMm: finalLayout.layout.width_mm,
    heightMm: finalLayout.layout.height_mm,
    dpi: profile.dpi,
    copies: 1,
    mediaSensor: 'gap',
    gapMm: 2,
    gapOffsetMm: 0,
  })

  assert.ok(tspl)
  assert.match(tspl.command, /^SIZE 40\.0 mm,30\.0 mm\r\nGAP 2\.0 mm,0\.0 mm\r\n/)
  const audit = auditLabelSizeChain({
    html: finalLayout.html,
    contract: created.contract,
    layout: finalLayout.layout,
    tsplCommand: tspl.command,
  })
  assert.equal(audit.matched, true)
  assert.equal(audit.page_matched, true)
  assert.equal(audit.layout_matched, true)
  assert.equal(audit.tspl_matched, true)
})

test('the size audit rejects a print layout that no longer matches the created canvas', () => {
  const contract = resolveLabelSizeContract(profile)
  const audit = auditLabelSizeChain({
    html: foodLabelHtml,
    contract,
    layout: { width_mm: 60, height_mm: 40 },
    tsplCommand: 'SIZE 60.0 mm,40.0 mm\r\nPRINT 1,1\r\n',
  })
  assert.equal(audit.matched, false)
  assert.equal(audit.page_matched, false)
  assert.equal(audit.layout_matched, false)
  assert.equal(audit.tspl_matched, false)
})
