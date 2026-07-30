import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'

const root = new URL('../../', import.meta.url)

async function source(path) {
  return readFile(new URL(path, root), 'utf8')
}

test('Web Direct LAN sends the stable TSPL payload through the automatic local connector', async () => {
  const value = await source('web/src/lib/stable-label-print-v19.js')
  assert.match(value, /Web Direct Wi-Fi\/LAN · Automatic Local Connector/)
  assert.match(value, /payloadBase64: asciiBase64\(stable\.command\)/)
  assert.match(value, /localConnectorTarget\(normalized\)/)
  assert.match(value, /DEFAULT_LOCAL_PRINT_CONNECTOR_URL/)
  assert.match(value, /printStableLabelHtmlV18\(html, profile\)/)
  assert.doesNotMatch(value, /delegateSystemPrint/)
  assert.doesNotMatch(value, /html-raster/)
  assert.doesNotMatch(value, /BITMAP/)
  assert.doesNotMatch(value, /X-Print-Bridge-Token/)
})

test('Food and Test labels still block browser page printing', async () => {
  const stableV18 = await source('web/src/lib/stable-label-print-v18.js')
  const stableV19 = await source('web/src/lib/stable-label-print-v19.js')
  assert.match(stableV18, /Browser\/System Print is disabled for Food Labels/)
  assert.match(stableV19, /printStableLabelHtmlV19/)
  assert.match(stableV19, /window\.__chefopsPrintStableLabelHtml/)
})

test('Label Settings exposes simple Direct Wi-Fi LAN to staff on Web', async () => {
  const page = await source('web/src/pages/LabelPrinterSettingsStableV19.jsx')
  const app = await source('web/src/App.jsx')
  assert.match(page, /All staff/)
  assert.match(page, /Automatic Local Connector/)
  assert.match(page, /Pairing token: <b>Not required<\/b>/)
  assert.match(page, /DEFAULT_LOCAL_PRINT_CONNECTOR_URL/)
  assert.match(page, /printStableLabelHtmlV19\(testLabelHtml/)
  assert.match(page, /No pairing token, browser page or Raster fallback was used/)
  assert.match(app, /LabelPrinterSettingsStableV19/)
})

test('Simple Web Direct LAN requires only printer IP while advanced Bridge retains credentials', async () => {
  const page = await source('web/src/pages/LabelPrinterSettingsStableV19.jsx')
  const connector = await source('web/src/lib/local-print-connector-v19.js')
  assert.match(page, /Enter the printer’s own Wi-Fi\/LAN IP address/)
  assert.match(page, /Advanced mode for a connector running on another computer/)
  assert.match(page, /Enter the Print Bridge pairing token/)
  assert.match(connector, /bridge_token: ''/)
  assert.match(connector, /http:\/\/127\.0\.0\.1:8788/)
  assert.doesNotMatch(page, /Web Direct LAN requires the Local Print Connector pairing token/)
})
