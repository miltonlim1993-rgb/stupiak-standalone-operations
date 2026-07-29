import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

import {
  asciiBase64,
  buildStableTsplLabelCommand,
  countStableLabelCopies,
  extractStableLabelJob,
} from '../../web/src/lib/stable-tspl-label-v16.js'

const foodLabelHtml = `<!doctype html><html><head><title>Food Label - Blueberry Sauce</title><style>@page{size:40mm 30mm;margin:0}</style></head><body>
<div class="label"><div class="title">Blueberry Sauce</div><div class="context"><span>REFILL</span><span>•</span><span class="storage">CHILLER</span></div><div class="times"><div class="time-box"><div class="time-head"><span>Made</span><strong>14:22</strong></div><div class="time-date">26 JUL 2026</div></div><div class="time-box"><div class="time-head"><span>Use By</span><strong>14:22</strong></div><div class="time-date">25 AUG 2026</div></div></div><div class="operator">REPRINT · BY: STUPIAK PORK BURGER</div><div class="barcode-wrap"><div class="batch">BATCH BS-260726-001</div><div class="barcode">9551234567890</div></div></div>
<div class="label"><div class="title">Blueberry Sauce</div></div><script>window.print()</script></body></html>`

const testLabelHtml = `<!doctype html><html><head><title>Stupiak's Ops Test Label</title><style>@page{size:40mm 30mm;margin:0}</style></head><body><div class="label"><div class="title">TEST LABEL</div><div class="meta">TSPL • RR-KCH</div><div class="time"><div class="box">MADE 14:30<strong>29 JUL 2026</strong></div><div class="box">USE BY 14:30<strong>30 JUL 2026</strong></div></div><div class="batch">Food Label Printer · TEST</div></div><script>window.print()</script></body></html>`

const options = {
  commandLanguage: 'tspl',
  widthMm: 40,
  heightMm: 30,
  dpi: 203,
  mediaSensor: 'gap',
  gapMm: 2,
  gapOffsetMm: 0,
  xOffsetMm: 0,
  yOffsetMm: 0,
}

test('extracts the existing Food Label page into a stable print record', () => {
  assert.equal(countStableLabelCopies(foodLabelHtml), 2)
  assert.deepEqual(extractStableLabelJob(foodLabelHtml), {
    kind: 'food',
    title: 'Blueberry Sauce',
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

test('matches the stable APK command order and copy semantics', () => {
  const result = buildStableTsplLabelCommand(foodLabelHtml, options)
  assert.equal(result.mode, 'tspl-stable-v16')
  assert.equal(result.copies, 2)
  assert.equal(result.report.fits, true)
  assert.match(result.command, /^SIZE 40 mm,30 mm\r\nGAP 2 mm,0 mm\r\n/)
  assert.match(result.command, /DENSITY 8\r\nSPEED 4\r\nDIRECTION 1\r\nREFERENCE 0,0\r\nCLS\r\n/)
  assert.match(result.command, /TEXT \d+,\d+,"3",0,1,1,"Blueberry Sauce"/)
  assert.match(result.command, /BARCODE \d+,\d+,"128",\d+,0,0,2,2,"9551234567890"/)
  assert.match(result.command, /PRINT 2,1\r\n$/)
  assert.doesNotMatch(result.command, /BITMAP|@page|<div/i)
})

test('the Settings test label uses the same native TSPL core instead of HTML raster', () => {
  const result = buildStableTsplLabelCommand(testLabelHtml, { ...options, copies: 1 })
  assert.equal(result.job.kind, 'test')
  assert.match(result.command, /TEXT \d+,\d+,"3",0,1,1,"TEST LABEL"/)
  assert.match(result.command, /TSPL - RR-KCH/)
  assert.match(result.command, /PRINT 1,1\r\n$/)
  assert.doesNotMatch(result.command, /BARCODE|BITMAP/)
})

test('unsupported printer characters are sanitized without switching to raster', () => {
  const result = buildStableTsplLabelCommand(foodLabelHtml.replace('Blueberry Sauce', '蓝莓酱 Blueberry Sauce'), options)
  assert.match(result.command, /\?\?\? Blueberry Sauce/)
  assert.doesNotMatch(result.command, /BITMAP/)
})

test('Bridge and Android direct routes send the exact same base64 TSPL document', async () => {
  const result = buildStableTsplLabelCommand(foodLabelHtml, options)
  const encoded = asciiBase64(result.command)
  assert.equal(Buffer.from(encoded, 'base64').toString('ascii'), result.command)

  const wrapper = await readFile(new URL('../../web/src/lib/stable-label-print-v16.js', import.meta.url), 'utf8')
  assert.match(wrapper, /payloadBase64: asciiBase64\(command\)/)
  assert.match(wrapper, /rawCommandBase64: asciiBase64\(stable\.command\)/)
  assert.match(wrapper, /renderMode: stable\.mode/)
  assert.doesNotMatch(wrapper, /html-raster|BITMAP/)
})
