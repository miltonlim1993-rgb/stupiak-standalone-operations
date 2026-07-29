import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

import {
  browserPlatformName,
  detectAppleMobileEnvironment,
} from '../../web/src/lib/device-viewport-v15.js'
import {
  detectInstallPlatform,
  installInstructions,
} from '../../web/src/lib/install-platform-v15.js'

const root = new URL('../../', import.meta.url)

async function source(path) {
  return readFile(new URL(path, root), 'utf8')
}

test('iPhone and touch iPad environments are detected without treating desktop Mac as iOS', () => {
  assert.equal(detectAppleMobileEnvironment({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)' }), true)
  assert.equal(detectAppleMobileEnvironment({ userAgent: 'Mozilla/5.0 (Macintosh)', platform: 'MacIntel', maxTouchPoints: 5 }), true)
  assert.equal(detectAppleMobileEnvironment({ userAgent: 'Mozilla/5.0 (Macintosh)', platform: 'MacIntel', maxTouchPoints: 0 }), false)
  assert.equal(browserPlatformName({ userAgent: 'Mozilla/5.0 (Linux; Android 15)', platform: 'Linux armv8l' }), 'android-browser')
})

test('install routes separate iPhone PWA, Android APK and desktop browser', () => {
  assert.equal(detectInstallPlatform({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)' }), 'ios')
  assert.equal(detectInstallPlatform({ userAgent: 'Mozilla/5.0 (Linux; Android 15)' }), 'android')
  assert.equal(detectInstallPlatform({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }), 'desktop')
  assert.match(installInstructions('ios').action, /Add to Home Screen/)
  assert.match(installInstructions('android').action, /APK/)
})

test('package objects use Cache Storage first with IndexedDB ArrayBuffer fallback and repair', async () => {
  const value = await source('web/src/lib/data-package-store-v2.js')
  assert.match(value, /OBJECT_CACHE = 'stupiaks-ops-data-package-v2-objects-v2'/)
  assert.match(value, /storage_backend: 'cache-v2'/)
  assert.match(value, /storage_backend: 'indexeddb-arraybuffer-v2'/)
  assert.match(value, /for \(let attempt = 0; attempt < 3; attempt \+= 1\)/)
  assert.match(value, /export async function repairLocalDataPackageStorage/)
  assert.match(value, /The current working release was kept/)
  assert.doesNotMatch(value, /blob,\n\s*verified: true/)
})

test('iPhone scroll uses one flex scroll owner and dynamic visual viewport height', async () => {
  const css = await source('web/src/cross-device-v15.css')
  const runtime = await source('web/src/lib/device-viewport-v15.js')
  assert.match(css, /--chefops-viewport-height/)
  assert.match(css, /#chefops-mobile-main[\s\S]*flex: 1 1 auto !important/)
  assert.match(css, /overflow-y: auto !important/)
  assert.match(css, /-webkit-overflow-scrolling: touch !important/)
  assert.match(css, /html\[data-chefops-ios='true'\]/)
  assert.match(runtime, /window\.visualViewport\?\.addEventListener\('resize'/)
})

test('data package gate starts at the top, remains scrollable and offers storage repair', async () => {
  const gate = await source('web/src/components/DataPackGate.jsx')
  assert.match(gate, /chefops-data-pack-gate/)
  assert.match(gate, /Repair local download storage & retry/)
  assert.match(gate, /automaticRepairOutlet/)
  assert.doesNotMatch(gate, /className="flex min-h-full w-full items-center justify-center/)
})

test('install page does not offer Android APK as the iPhone install path', async () => {
  const install = await source('web/src/pages/InstallApp.jsx')
  assert.match(install, /platform === 'ios'/)
  assert.match(install, /Android APK files cannot be installed on iPhone/)
  assert.match(install, /target="_blank"/)
  assert.match(install, /Safari Share → Add to Home Screen/)
})
