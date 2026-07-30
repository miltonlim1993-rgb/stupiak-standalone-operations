import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

import {
  STABLE_4BARCODE_MEDIA,
  chooseRecommendedQueue,
  localConnectorTarget,
  stablePrinterProfile,
} from '../../web/src/lib/device-printer-v20.js'

const root = new URL('../../', import.meta.url)

async function source(path) {
  return readFile(new URL(path, root), 'utf8')
}

test('accepted APK media values remain locked to the proven 4BARCODE setup', () => {
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

test('Android stays on stable v16 while Web uses isolated two-route printing', async () => {
  const main = await source('web/src/main.jsx')
  assert.match(main, /if \(isNativeAndroid\(\)\) installStableLabelPrintV16\(\)/)
  assert.match(main, /else installStableLabelPrintV20\(\)/)
  assert.match(main, /androidStablePrint: 'v16-date-fit-v22'/)
  assert.match(main, /webStablePrint: 'device-local-v24-windows-queue-kitchen-ip'/)
  assert.match(main, /labelSettingsStaff: 'two-route-service-v24'/)
  assert.doesNotMatch(main, /installStableLabelPrintV19\(\)/)
})

test('Web printer route is device-local and supports Windows queue plus direct IP', async () => {
  const device = await source('web/src/lib/device-printer-v20.js')
  assert.match(device, /stupiaks_ops\.web_printer_device\.v20/)
  assert.match(device, /web_transport/)
  assert.match(device, /web_queue/)
  assert.match(device, /targetAddressSpace: 'loopback'/)
  assert.match(device, /LOCAL_CONNECTOR_INSTALLER/)
  assert.match(device, /one-time Stupiak Print Service installation/)

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

test('recommended queue prefers the existing Kitchen Label Printer', () => {
  assert.equal(chooseRecommendedQueue([
    { name: 'Bar Label Printer', port: 'USB004' },
    { name: 'Kitchen Label Printer', port: '192.168.0.211' },
  ]), 'Kitchen Label Printer')
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

test('staff settings present Windows Queue and Kitchen IP as two simple device choices', async () => {
  const settings = await source('web/src/pages/LabelPrinterSettingsSimpleV20.jsx')
  assert.match(settings, /Windows Printer/)
  assert.match(settings, /Kitchen Printer · Direct IP/)
  assert.match(settings, /FeedMe/)
  assert.match(settings, /Install \/ Repair Print Service/)
  assert.match(settings, /Kitchen printer IP/)
  assert.match(settings, /40 × 30 mm/)
  assert.match(settings, /Stable TSPL v16/)
  assert.match(settings, /Test route/)
  assert.match(settings, /Test label/)
  assert.match(settings, /Use here/)
  assert.doesNotMatch(settings, /Pairing token/)
  assert.doesNotMatch(settings, /LPR queue/)
})

test('standalone Windows service supports queue and Raw TCP without Node or pairing token', async () => {
  const service = await source('web/public/print-service/stupiaks-print-service.ps1')
  const installer = await source('web/public/print-service/install-stupiaks-print-service.ps1')
  const launcher = await source('web/public/print-service/install-stupiaks-print-service.cmd')
  assert.match(service, /StupiaksRawPrinterV24/)
  assert.match(service, /Get-PrinterRows/)
  assert.match(service, /Send-RawTcp/)
  assert.match(service, /pairing_token_required = \$false/)
  assert.match(service, /queue_accepted/)
  assert.match(service, /raw_tcp_data_sent/)
  assert.doesNotMatch(service, /node\.exe/)
  assert.match(installer, /schtasks\.exe \/Create/)
  assert.match(installer, /Stupiaks Print Service/)
  assert.match(launcher, /ExecutionPolicy Bypass/)
})

test('production shell explicitly permits loopback/local network permission prompts', async () => {
  const worker = await source('worker/src/entry-v3.js')
  assert.match(worker, /Permissions-Policy', 'local-network=\(self\), loopback-network=\(self\)'/)
})
