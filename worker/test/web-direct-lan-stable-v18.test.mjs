import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'

const root = new URL('../../', import.meta.url)

async function source(path) {
  return readFile(new URL(path, root), 'utf8')
}

test('Web Direct LAN sends the stable TSPL payload through the local connector', async () => {
  const value = await source('web/src/lib/stable-label-print-v18.js')
  assert.match(value, /Web Direct Wi-Fi\/LAN via Local Connector/)
  assert.match(value, /payloadBase64: asciiBase64\(command\)/)
  assert.match(value, /mode: 'raw_tcp'/)
  assert.match(value, /host: clean\(normalized\.ip_address\)/)
  assert.match(value, /rawCommandBase64: asciiBase64\(stable\.command\)/)
  assert.match(value, /html: ''/)
  assert.doesNotMatch(value, /delegateSystemPrint/)
  assert.doesNotMatch(value, /html-raster/)
})

test('Food and Test labels explicitly block browser page printing', async () => {
  const value = await source('web/src/lib/stable-label-print-v18.js')
  assert.match(value, /Browser\/System Print is disabled for Food Labels/)
  assert.match(value, /printStableLabelHtmlV18/)
  assert.match(value, /window\.__chefopsPrintStableLabelHtml/)
})

test('Label Settings exposes Direct Wi-Fi LAN to staff on Web', async () => {
  const page = await source('web/src/pages/LabelPrinterSettingsStableV18.jsx')
  const app = await source('web/src/App.jsx')
  assert.match(page, /All staff/)
  assert.match(page, /Web Direct LAN connector/)
  assert.match(page, /http:\/\/127\.0\.0\.1:8787/)
  assert.match(page, /printStableLabelHtmlV18\(testLabelHtml/)
  assert.match(page, /No browser page or Raster fallback was used/)
  assert.match(app, /LabelPrinterSettingsStableV18/)
})

test('Web Direct LAN transport requires a printer IP and connector credentials', async () => {
  const value = await source('web/src/lib/printer-transport-v12.js')
  assert.match(value, /Web Direct Wi-Fi\/LAN requires the Local Print Connector URL/)
  assert.match(value, /Enter the Local Print Connector pairing token/)
  assert.match(value, /viaConnector: true/)
  assert.doesNotMatch(value, /On Windows or macOS, choose System Print or Driver Bridge/)
})
