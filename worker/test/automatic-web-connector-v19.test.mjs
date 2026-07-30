import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

import {
  DEFAULT_LOCAL_PRINT_CONNECTOR_URL,
  isAutomaticLocalConnectorUrl,
  localConnectorTarget,
  normalizeLocalConnectorUrl,
  webDirectProfile,
} from '../../web/src/lib/local-print-connector-v19.js'

const root = new URL('../../', import.meta.url)

async function source(path) {
  return readFile(new URL(path, root), 'utf8')
}

test('same-computer Web Direct LAN always uses the automatic local connector', () => {
  assert.equal(DEFAULT_LOCAL_PRINT_CONNECTOR_URL, 'http://127.0.0.1:8788')
  assert.equal(normalizeLocalConnectorUrl('192.168.0.211'), DEFAULT_LOCAL_PRINT_CONNECTOR_URL)
  assert.equal(isAutomaticLocalConnectorUrl(DEFAULT_LOCAL_PRINT_CONNECTOR_URL), true)

  const profile = webDirectProfile({
    ip_address: '192.168.0.211',
    port: 9100,
    network_protocol: 'raw_tcp',
    bridge_url: '192.168.0.211',
    bridge_token: 'guessed-token',
  })
  assert.equal(profile.bridge_url, DEFAULT_LOCAL_PRINT_CONNECTOR_URL)
  assert.equal(profile.bridge_token, '')
  assert.equal(profile.bridge_printer_ip, '192.168.0.211')
  assert.deepEqual(localConnectorTarget(profile), {
    mode: 'raw_tcp',
    host: '192.168.0.211',
    port: 9100,
  })
})

test('automatic connector is loopback-only and origin locked', async () => {
  const connector = await source('tools/print-bridge/automatic-local-web-v19.mjs')
  assert.match(connector, /const HOST = '127\.0\.0\.1'/)
  assert.match(connector, /https:\/\/stupiaks-ops\.sporkburger19\.workers\.dev/)
  assert.match(connector, /authorizeBrowser/)
  assert.match(connector, /Same-computer Stupiak’s Ops Web requires no pairing token/)
  assert.match(connector, /X-Print-Bridge-Token/)
  assert.doesNotMatch(connector, /Access-Control-Allow-Origin': '\*'/)
})

test('Web settings ask only for printer IP in simple Direct LAN mode', async () => {
  const settings = await source('web/src/pages/LabelPrinterSettingsStableV19.jsx')
  assert.match(settings, /Pairing token: <b>Not required<\/b>/)
  assert.match(settings, /Enter only the printer IP/)
  assert.match(settings, /Automatic Local Connector/)
  assert.match(settings, /DEFAULT_LOCAL_PRINT_CONNECTOR_URL/)
  assert.match(settings, /printStableLabelHtmlV19/)
  assert.match(settings, /Advanced mode for a connector running on another computer/)
})

test('Stable Label v19 posts the APK-identical TSPL to port 8788 without a token header', async () => {
  const printer = await source('web/src/lib/stable-label-print-v19.js')
  assert.match(printer, /DEFAULT_LOCAL_PRINT_CONNECTOR_URL.*\/print/s)
  assert.match(printer, /payloadBase64: asciiBase64\(stable\.command\)/)
  assert.match(printer, /localConnectorHeaders\(\)/)
  assert.doesNotMatch(printer, /X-Print-Bridge-Token/)
  assert.doesNotMatch(printer, /html-raster/)
  assert.doesNotMatch(printer, /BITMAP/)
})

test('macOS and Windows installers launch the automatic connector', async () => {
  const mac = await source('scripts/install-print-bridge-macos.sh')
  const windows = await source('scripts/install-print-bridge-windows.ps1')
  for (const installer of [mac, windows]) {
    assert.match(installer, /automatic-local-web-v19\.mjs/)
    assert.match(installer, /8788/)
    assert.match(installer, /NOT REQUIRED/)
  }
})
