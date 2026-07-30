import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'

const root = new URL('../../', import.meta.url)

async function source(path) {
  return readFile(new URL(path, root), 'utf8')
}

test('Web Direct LAN sends the stable TSPL payload through the device-local connector', async () => {
  const value = await source('web/src/lib/stable-label-print-v20.js')
  assert.match(value, /Web device-local RAW TCP/)
  assert.match(value, /payloadBase64: asciiBase64\(stable\.command\)/)
  assert.match(value, /localConnectorTarget\(profile\)/)
  assert.match(value, /fetchLocalConnector\('\/print'/)
  assert.doesNotMatch(value, /delegateSystemPrint/)
  assert.doesNotMatch(value, /html-raster/)
  assert.doesNotMatch(value, /BITMAP/)
  assert.doesNotMatch(value, /X-Print-Bridge-Token/)
})

test('Food and Test labels still block browser page printing', async () => {
  const stableV18 = await source('web/src/lib/stable-label-print-v18.js')
  const stableV20 = await source('web/src/lib/stable-label-print-v20.js')
  assert.match(stableV18, /Browser\/System Print is disabled for Food Labels/)
  assert.match(stableV20, /printStableLabelHtmlV20/)
  assert.match(stableV20, /window\.__chefopsPrintStableLabelHtml/)
})

test('Label Settings exposes one simple Direct Wi-Fi LAN setup to staff', async () => {
  const page = await source('web/src/pages/LabelPrinterSettingsSimpleV20.jsx')
  const app = await source('web/src/App.jsx')
  assert.match(page, /标签打印机 \/ Label Printer/)
  assert.match(page, /Direct Wi-Fi \/ LAN/)
  assert.match(page, /Printer IP/)
  assert.match(page, /Stable TSPL v16/)
  assert.match(page, /printStableLabelHtmlV20/)
  assert.match(app, /LabelPrinterSettingsSimpleV20/)
})

test('Simple Web Direct LAN keeps bridge credentials out of staff settings', async () => {
  const page = await source('web/src/pages/LabelPrinterSettingsSimpleV20.jsx')
  const connector = await source('web/src/lib/device-printer-v20.js')
  assert.match(page, /Enter the printer IP/)
  assert.match(connector, /http:\/\/127\.0\.0\.1:8788/)
  assert.match(connector, /targetAddressSpace: 'loopback'/)
  assert.doesNotMatch(page, /Advanced Bridge/)
  assert.doesNotMatch(page, /Pairing token/)
  assert.doesNotMatch(page, /Bridge URL/)
})
