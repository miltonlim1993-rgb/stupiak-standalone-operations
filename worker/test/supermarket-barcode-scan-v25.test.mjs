import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

import {
  isLikelyHardwareScannerInput,
  normaliseScannedValue,
  SUPERMARKET_BARCODE_SCANNER_VERSION,
} from '../../web/src/lib/supermarket-barcode-scan-v25.js'

const root = new URL('../../', import.meta.url)

async function source(path) {
  return readFile(new URL(path, root), 'utf8')
}

test('scanner input recognises fast keyboard-wedge barcode data', () => {
  assert.equal(SUPERMARKET_BARCODE_SCANNER_VERSION, '4.6.24-supermarket-barcode-scanner-v25')
  assert.equal(normaliseScannedValue(' 9551234567890\r\n'), '9551234567890')
  assert.equal(isLikelyHardwareScannerInput('9551234567890', 260), true)
  assert.equal(isLikelyHardwareScannerInput('SSSS-260730-1283', 420), true)
  assert.equal(isLikelyHardwareScannerInput('12345', 80), false)
  assert.equal(isLikelyHardwareScannerInput('9551234567890', 2400), false)
})

test('web scanner is live and submits immediately without photo upload when supported', async () => {
  const scanner = await source('web/src/lib/supermarket-barcode-scan-v25.js')
  assert.match(scanner, /getUserMedia/)
  assert.match(scanner, /BarcodeDetector/)
  assert.match(scanner, /requestAnimationFrame\(frame\)/)
  assert.match(scanner, /submitScannedLookup/)
  assert.match(scanner, /Point at the barcode — it reads automatically/)
  assert.match(scanner, /NativeBarcodeScanner/)
  assert.match(scanner, /document\.addEventListener\('keydown', hardwareKeydown, true\)/)
})

test('Android configuration installs Google Code Scanner with auto zoom', async () => {
  const configure = await source('scripts/configure-android-barcode-scanner-v25.mjs')
  assert.match(configure, /play-services-code-scanner:16\.1\.0/)
  assert.match(configure, /barcode_ui/)
  assert.match(configure, /NativeBarcodeScannerPlugin/)
  assert.match(configure, /enableAutoZoom/)
  assert.match(configure, /Barcode\.FORMAT_EAN_13/)
  assert.match(configure, /Barcode\.FORMAT_CODE_128/)
  assert.match(configure, /Barcode\.FORMAT_QR_CODE/)
})
