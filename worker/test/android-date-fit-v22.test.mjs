import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

import { buildStableTsplLabelCommand } from '../../web/src/lib/stable-tspl-label-v16.js'

const html = `<!doctype html><html><head><title>Food Label</title><style>@page{size:40mm 30mm;margin:0}</style></head><body><div class="label"><div class="title">Sweet Sour Spicy Sauce</div><div class="context"><span>Prepare</span><span>Dry Storage</span></div><div class="times"><div class="time-box"><div class="time-head"><span>Made</span><strong>11:02</strong></div><div class="time-date">30 JUL 2026</div></div><div class="time-box"><div class="time-head"><span>Use By</span><strong>11:02</strong></div><div class="time-date">26 JAN 2027</div></div></div><div class="operator">REPRINT - BY: Milton</div><div class="batch">BATCH SSSS-260730-1283</div><div class="barcode">5616764491283</div></div><script>window.print()</script></body></html>`

const options = {
  commandLanguage: 'tspl',
  widthMm: 40,
  heightMm: 30,
  dpi: 203,
  mediaSensor: 'gap',
  gapMm: 2,
  xOffsetMm: 0,
  yOffsetMm: 0,
  copies: 1,
}

function parseBox(line) {
  const match = line.match(/^BOX\s+(\d+),(\d+),(\d+),(\d+),1$/)
  return match ? { x1: Number(match[1]), x2: Number(match[3]) } : null
}

function parseDate(line) {
  const match = line.match(/^TEXT\s+(\d+),(\d+),"1",0,1,2,"([^"]+)"$/)
  return match ? { x: Number(match[1]), text: match[3] } : null
}

test('shared TSPL core fits Made and Use By dates before Android transport receives the payload', () => {
  const result = buildStableTsplLabelCommand(html, options)
  const lines = result.command.trim().split('\r\n')
  const boxes = lines.map(parseBox).filter(Boolean).slice(0, 2)
  const dates = lines.map(parseDate).filter(Boolean).filter((entry) => /2026|2027/.test(entry.text))

  assert.equal(result.mode, 'tspl-stable-v16-date-fit-v22')
  assert.equal(result.report.date_boxes_fitted, true)
  assert.equal(result.report.date_box_padding_dots, 2)
  assert.equal(result.report.date_font, '1x2')
  assert.deepEqual(dates.map((entry) => entry.text), ['30 JUL 2026', '26 JAN 2027'])

  dates.forEach((entry, index) => {
    const width = entry.text.length * 8
    assert.ok(entry.x >= boxes[index].x1 + 2)
    assert.ok(entry.x + width <= boxes[index].x2 - 2)
  })

  assert.doesNotMatch(result.command, /,"2",0,1,1,"30 JUL 2026"/)
  assert.doesNotMatch(result.command, /,"2",0,1,1,"26 JAN 2027"/)
  assert.match(result.command, /PRINT 1,1\r\n$/)
})

test('Android route sends the already-fitted shared command without HTML raster fallback', async () => {
  const source = await readFile(new URL('../../web/src/lib/stable-label-print-v16.js', import.meta.url), 'utf8')
  const main = await readFile(new URL('../../web/src/main.jsx', import.meta.url), 'utf8')

  assert.match(source, /buildStableTsplLabelCommand/)
  assert.match(source, /rawCommandBase64: asciiBase64\(stable\.command\)/)
  assert.match(source, /html: ''/)
  assert.doesNotMatch(source, /html-raster/)
  assert.match(main, /if \(isNativeAndroid\(\)\) installStableLabelPrintV16\(\)/)
  assert.match(main, /androidStablePrint: 'v16-date-fit-v22'/)
})
