import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

import {
  STABLE_4BARCODE_MEDIA,
  localConnectorTarget,
  stablePrinterProfile,
} from '../../web/src/lib/device-printer-v20.js'

const root = new URL('../../', import.meta.url)

async function source(path) {
  return readFile(new URL(path, root), 'utf8')
}

test('accepted APK media values are locked to the proven 4BARCODE setup', () => {
  assert.deepEqual({
    width: STABLE_4BARCODE_MEDIA.label_width_mm,
    height: STABLE_4BARCODE_MEDIA.label_height_mm,
    dpi: STABLE_4BARCODE_MEDIA.dpi,
    gap: STABLE_4BARCODE_MEDIA.gap_mm,
    x: STABLE_4BARCODE_MEDIA.x_offset_mm,
    y: STABLE_4BARCODE_MEDIA.y_offset_mm,
    darkness: STABLE_4BARCODE_MEDIA.darkness,
    port: STABLE_4BARCODE_MEDIA.port,
  }, {
    width: 40,
    height: 30,
    dpi: 203,
    gap: 2,
    x: 0,
    y: 0,
    darkness: 8,
    port: 9100,
  })

  const repaired = stablePrinterProfile({
    ip_address: '192.168.0.211',
    label_width_mm: 60,
    label_height_mm: 40,
    dpi: 300,
    gap_mm: 0.9,
    x_offset_mm: 7,
  })
  assert.equal(repaired.label_width_mm, 40)
  assert.equal(repaired.label_height_mm, 30)
  assert.equal(repaired.dpi, 203)
  assert.equal(repaired.gap_mm, 2)
  assert.equal(repaired.x_offset_mm, 0)
  assert.equal(repaired.ip_address, '192.168.0.211')
})

test('Android installs the accepted stable v16 route while Web installs isolated v20', async () => {
  const main = await source('web/src/main.jsx')
  assert.match(main, /if \(isNativeAndroid\(\)\) installStableLabelPrintV16\(\)/)
  assert.match(main, /else installStableLabelPrintV20\(\)/)
  assert.match(main, /androidStablePrint: 'frozen-v16'/)
  assert.match(main, /webStablePrint: 'device-local-v20-date-fit-v21'/)
  assert.match(main, /labelDateBoxes: 'narrow-1x2-centered-2-dot-safe-area'/)
  assert.doesNotMatch(main, /installStableLabelPrintV19\(\)/)
})

test('Web printer route is device-local and supports Windows queue plus direct IP', async () => {
  const device = await source('web/src/lib/device-printer-v20.js')
  assert.match(device, /stupiaks_ops\.web_printer_device\.v20/)
  assert.match(device, /web_transport/)
  assert.match(device, /web_queue/)
  assert.match(device, /targetAddressSpace: 'loopback'/)
  assert.match(device, /Chrome blocked local printing/)

  assert.deepEqual(localConnectorTarget({ web_transport: 'queue', web_queue: 'Kitchen Label Printer' }), {
    mode: 'queue',
    queue: 'Kitchen Label Printer',
  })
  assert.deepEqual(localConnectorTarget({ web_transport: 'raw_tcp', ip_address: '192.168.0.211', port: 9100 }), {
    mode: 'raw_tcp',
    host: '192.168.0.211',
    port: 9100,
  })
})

test('Web labels send one stable TSPL document through the selected local route', async () => {
  const printer = await source('web/src/lib/stable-label-print-v20.js')
  assert.match(printer, /payloadBase64: asciiBase64\(stable\.command\)/)
  assert.match(printer, /webPrinterRouteLabel/)
  assert.match(printer, /fixed 40×30 mm/)
  assert.match(printer, /fitStableTsplDateBoxes/)
  assert.doesNotMatch(printer, /html-raster/)
  assert.doesNotMatch(printer, /BITMAP/)
  assert.doesNotMatch(printer, /opsClient/)
})

test('staff settings expose only two understandable routes and keep them device-local', async () => {
  const settings = await source('web/src/pages/LabelPrinterSettingsSimpleV20.jsx')
  assert.match(settings, /Windows Printer/)
  assert.match(settings, /Direct IP/)
  assert.match(settings, /Kitchen Label Printer/)
  assert.match(settings, /Printer IP/)
  assert.match(settings, /40 × 30 mm/)
  assert.match(settings, /Stable TSPL v16/)
  assert.match(settings, /Connect/)
  assert.match(settings, /Test label/)
  assert.match(settings, /Save/)
  assert.match(settings, /Android and other devices were not changed/)
  assert.doesNotMatch(settings, /Pairing token/)
  assert.doesNotMatch(settings, /LPR queue/)
})

test('production shell explicitly permits loopback/local network permission prompts', async () => {
  const worker = await source('worker/src/entry-v3.js')
  assert.match(worker, /Permissions-Policy', 'local-network=\(self\), loopback-network=\(self\)'/)
})
