import test from 'node:test'
import assert from 'node:assert/strict'

import {
  asciiBase64,
  buildTsplFoodLabelCommand,
  extractFoodLabelForTspl,
} from '../../web/src/lib/tspl-food-label-compat.js'

const foodLabelHtml = `<!doctype html>
<html>
<head><style>@page { size: 40mm 30mm; margin: 0; }</style></head>
<body>
  <div class="label">
    <div class="top">
      <div class="title">blueberry sauce</div>
      <div class="context"><span>REFILL</span><span>•</span><span class="storage">CHILLER</span></div>
    </div>
    <div class="times">
      <div class="time-box">
        <div class="time-head"><span>Made</span><strong>14:22</strong></div>
        <div class="time-date">26 JUL 2026</div>
      </div>
      <div class="time-box">
        <div class="time-head"><span>Use By</span><strong>14:22</strong></div>
        <div class="time-date">25 AUG 2026</div>
      </div>
    </div>
    <div class="operator">REPRINT · BY: STUPIAK PORK BURGER</div>
    <div class="barcode-wrap">
      <div class="batch">BATCH BS-260726-001</div>
      <div class="barcode">9551234567890</div>
    </div>
  </div>
</body>
</html>`

test('extracts the structured food-label fields from the existing print HTML', () => {
  assert.deepEqual(extractFoodLabelForTspl(foodLabelHtml), {
    title: 'blueberry sauce',
    action: 'REFILL',
    storage: 'CHILLER',
    made: { label: 'Made', time: '14:22', date: '26 JUL 2026' },
    useBy: { label: 'Use By', time: '14:22', date: '25 AUG 2026' },
    quantity: '',
    operator: 'REPRINT · BY: STUPIAK PORK BURGER',
    batch: 'BS-260726-001',
    barcode: '9551234567890',
  })
})

test('uses native TSPL text and barcode commands instead of a page-sized bitmap', () => {
  const result = buildTsplFoodLabelCommand(foodLabelHtml, {
    commandLanguage: 'tspl',
    widthMm: 40,
    heightMm: 30,
    dpi: 203,
    copies: 2,
    mediaSensor: 'gap',
    gapMm: 2,
    gapOffsetMm: 0,
  })

  assert.ok(result)
  assert.equal(result.mode, 'tspl-native-food-label')
  assert.match(result.command, /^SIZE 40\.0 mm,30\.0 mm\r\nGAP 2\.0 mm,0\.0 mm\r\n/)
  assert.match(result.command, /DENSITY 8\r\nSPEED 4\r\nDIRECTION 1\r\nREFERENCE 0,0\r\nCLS\r\n/)
  assert.match(result.command, /TEXT \d+,\d+,"3",0,1,1,"blueberry sauce"/)
  assert.match(result.command, /BOX \d+,\d+,\d+,\d+,1/)
  assert.match(result.command, /BARCODE \d+,\d+,"128",\d+,0,0,2,2,"9551234567890"/)
  assert.match(result.command, /PRINT 1,2\r\n$/)
  assert.doesNotMatch(result.command, /BITMAP/)
})

test('falls back when a food label needs characters unsupported by printer built-in fonts', () => {
  const chinese = foodLabelHtml.replace('blueberry sauce', '蓝莓酱')
  assert.equal(buildTsplFoodLabelCommand(chinese, {
    commandLanguage: 'tspl',
    widthMm: 40,
    heightMm: 30,
    dpi: 203,
    copies: 1,
  }), null)
})

test('encodes the raw ASCII command for the native Android bridge', () => {
  const encoded = asciiBase64('SIZE 40 mm,30 mm\r\nPRINT 1,1\r\n')
  assert.equal(Buffer.from(encoded, 'base64').toString('ascii'), 'SIZE 40 mm,30 mm\r\nPRINT 1,1\r\n')
})
