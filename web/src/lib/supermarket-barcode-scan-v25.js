export const SUPERMARKET_BARCODE_SCANNER_VERSION = '4.6.24-supermarket-barcode-scanner-v25'

const SEARCH_SELECTOR = 'input[placeholder="Barcode or batch code"]'
const CAMERA_BUTTON_SELECTOR = 'button[aria-label="Scan label with camera"]'
const MIN_SCAN_LENGTH = 6
const MAX_KEY_GAP_MS = 120
const MAX_SCAN_DURATION_MS = 1800

let installed = false
let hardwareBuffer = ''
let hardwareStartedAt = 0
let hardwareLastAt = 0
let hardwareResetTimer = 0
let activeScannerCleanup = null

function clean(value = '') {
  return String(value ?? '').trim()
}

export function normaliseScannedValue(value = '') {
  return clean(value).replace(/[\r\n\t]/g, '').trim()
}

export function isLikelyHardwareScannerInput(value, durationMs) {
  const code = normaliseScannedValue(value)
  if (code.length < MIN_SCAN_LENGTH || code.length > 128) return false
  if (!Number.isFinite(durationMs) || durationMs < 0 || durationMs > MAX_SCAN_DURATION_MS) return false
  const averageGap = code.length > 1 ? durationMs / (code.length - 1) : durationMs
  return averageGap <= MAX_KEY_GAP_MS
}

function onLabelsPage() {
  return window.location.pathname === '/labels'
}

function nativeAndroid() {
  const capacitor = window.Capacitor
  return Boolean(
    (capacitor?.isNativePlatform?.() && capacitor?.getPlatform?.() === 'android')
    || window.location.origin === 'https://localhost'
    || window.location.origin === 'capacitor://localhost',
  )
}

function searchInput() {
  return document.querySelector(SEARCH_SELECTOR)
}

function setNativeInputValue(input, value) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
  if (setter) setter.call(input, value)
  else input.value = value
}

export function submitScannedLookup(value) {
  const code = normaliseScannedValue(value)
  const input = searchInput()
  if (!code || !input) return false

  setNativeInputValue(input, code)
  input.dispatchEvent(new Event('input', { bubbles: true }))
  input.dispatchEvent(new Event('change', { bubbles: true }))
  input.focus({ preventScroll: true })

  window.setTimeout(() => {
    input.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Enter',
      code: 'Enter',
      bubbles: true,
      cancelable: true,
    }))
  }, 40)
  return true
}

function resetHardwareBuffer() {
  hardwareBuffer = ''
  hardwareStartedAt = 0
  hardwareLastAt = 0
  window.clearTimeout(hardwareResetTimer)
  hardwareResetTimer = 0
}

function hardwareKeydown(event) {
  if (!onLabelsPage() || activeScannerCleanup) return
  if (event.ctrlKey || event.altKey || event.metaKey) return

  const now = performance.now()
  if (event.key === 'Enter') {
    const duration = hardwareStartedAt > 0 ? now - hardwareStartedAt : Infinity
    const code = hardwareBuffer
    resetHardwareBuffer()
    if (!isLikelyHardwareScannerInput(code, duration)) return

    event.preventDefault()
    event.stopImmediatePropagation()
    submitScannedLookup(code)
    return
  }

  if (event.key.length !== 1) return
  if (hardwareLastAt > 0 && now - hardwareLastAt > MAX_KEY_GAP_MS) resetHardwareBuffer()
  if (!hardwareBuffer) hardwareStartedAt = now
  hardwareBuffer += event.key
  hardwareLastAt = now
  window.clearTimeout(hardwareResetTimer)
  hardwareResetTimer = window.setTimeout(resetHardwareBuffer, 300)
}

function beep() {
  try {
    const Context = window.AudioContext || window.webkitAudioContext
    if (!Context) return
    const context = new Context()
    const oscillator = context.createOscillator()
    const gain = context.createGain()
    oscillator.frequency.value = 1250
    gain.gain.setValueAtTime(0.0001, context.currentTime)
    gain.gain.exponentialRampToValueAtTime(0.12, context.currentTime + 0.01)
    gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.09)
    oscillator.connect(gain)
    gain.connect(context.destination)
    oscillator.start()
    oscillator.stop(context.currentTime + 0.1)
    oscillator.addEventListener('ended', () => context.close().catch(() => undefined), { once: true })
  } catch {
    // Sound is optional; scanning must still complete.
  }
}

function completeScan(value) {
  const code = normaliseScannedValue(value)
  if (!code) return false
  navigator.vibrate?.(80)
  beep()
  return submitScannedLookup(code)
}

function fallbackPhotoCapture(message = '') {
  if (message) console.info(message)
  const input = document.querySelector('input[type="file"][capture="environment"]')
  input?.click()
}

function scannerOverlay() {
  const overlay = document.createElement('div')
  overlay.dataset.supermarketScanner = SUPERMARKET_BARCODE_SCANNER_VERSION
  overlay.setAttribute('role', 'dialog')
  overlay.setAttribute('aria-modal', 'true')
  overlay.setAttribute('aria-label', 'Live barcode scanner')
  Object.assign(overlay.style, {
    position: 'fixed', inset: '0', zIndex: '2147483647', background: '#050505', color: '#fff',
    display: 'flex', flexDirection: 'column', alignItems: 'stretch', justifyContent: 'stretch',
  })

  const top = document.createElement('div')
  Object.assign(top.style, { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '16px' })
  top.innerHTML = '<div><strong style="font-size:17px">Scan barcode</strong><div data-scan-status style="font-size:12px;color:#d4d4d4;margin-top:3px">Point at the barcode — it reads automatically</div></div>'

  const close = document.createElement('button')
  close.type = 'button'
  close.textContent = 'Close'
  close.setAttribute('aria-label', 'Close barcode scanner')
  Object.assign(close.style, { border: '1px solid #666', borderRadius: '10px', background: '#171717', color: '#fff', padding: '9px 14px', fontWeight: '700' })
  top.appendChild(close)

  const stage = document.createElement('div')
  Object.assign(stage.style, { position: 'relative', flex: '1', minHeight: '0', overflow: 'hidden', background: '#000' })
  const video = document.createElement('video')
  video.autoplay = true
  video.muted = true
  video.setAttribute('playsinline', '')
  Object.assign(video.style, { width: '100%', height: '100%', objectFit: 'cover' })

  const guide = document.createElement('div')
  Object.assign(guide.style, {
    position: 'absolute', left: '8%', right: '8%', top: '36%', height: '28%',
    border: '3px solid #f6b900', borderRadius: '18px', boxShadow: '0 0 0 9999px rgba(0,0,0,.42)',
  })
  const line = document.createElement('div')
  Object.assign(line.style, { position: 'absolute', left: '4%', right: '4%', top: '50%', height: '2px', background: '#f6b900', boxShadow: '0 0 10px #f6b900' })
  guide.appendChild(line)
  stage.append(video, guide)
  overlay.append(top, stage)
  document.body.appendChild(overlay)
  return { overlay, video, close, status: top.querySelector('[data-scan-status]') }
}

async function startWebLiveScanner() {
  if (!navigator.mediaDevices?.getUserMedia || !('BarcodeDetector' in globalThis)) {
    fallbackPhotoCapture('Live barcode scanning is unavailable in this browser; using photo scan fallback.')
    return
  }

  const { overlay, video, close, status } = scannerOverlay()
  let stream = null
  let stopped = false
  let detecting = false
  let lastDetectionAt = 0

  const cleanup = () => {
    if (stopped) return
    stopped = true
    stream?.getTracks?.().forEach((track) => track.stop())
    overlay.remove()
    activeScannerCleanup = null
  }
  activeScannerCleanup = cleanup
  close.addEventListener('click', cleanup, { once: true })

  try {
    const preferred = ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'qr_code']
    const supported = typeof globalThis.BarcodeDetector.getSupportedFormats === 'function'
      ? await globalThis.BarcodeDetector.getSupportedFormats()
      : preferred
    const formats = preferred.filter((format) => supported.includes(format))
    const detector = formats.length
      ? new globalThis.BarcodeDetector({ formats })
      : new globalThis.BarcodeDetector()

    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        facingMode: { ideal: 'environment' },
        width: { ideal: 1280 },
        height: { ideal: 720 },
      },
    })
    video.srcObject = stream
    await video.play()

    const frame = async (timestamp) => {
      if (stopped) return
      if (!detecting && timestamp - lastDetectionAt >= 120 && video.readyState >= 2) {
        detecting = true
        lastDetectionAt = timestamp
        try {
          const results = await detector.detect(video)
          const value = results.map((result) => normaliseScannedValue(result.rawValue)).find(Boolean)
          if (value) {
            cleanup()
            completeScan(value)
            return
          }
        } catch (error) {
          status.textContent = clean(error?.message) || 'Keep the barcode inside the frame'
        } finally {
          detecting = false
        }
      }
      window.requestAnimationFrame(frame)
    }
    window.requestAnimationFrame(frame)
  } catch (error) {
    cleanup()
    fallbackPhotoCapture(clean(error?.message) || 'Camera could not start; using photo scan fallback.')
  }
}

async function startNativeScanner() {
  const scanner = window.Capacitor?.Plugins?.NativeBarcodeScanner
  if (!scanner?.scan) {
    await startWebLiveScanner()
    return
  }

  try {
    const result = await scanner.scan()
    const value = normaliseScannedValue(result?.rawValue || result?.value)
    if (!value) throw new Error('No barcode was returned')
    completeScan(value)
  } catch (error) {
    const message = clean(error?.message)
    if (/cancel/i.test(message)) return
    console.error('Native barcode scan failed', error)
    await startWebLiveScanner()
  }
}

async function startScanner() {
  if (activeScannerCleanup) return
  if (nativeAndroid()) await startNativeScanner()
  else await startWebLiveScanner()
}

function cameraButtonClick(event) {
  if (!onLabelsPage()) return
  const button = event.target?.closest?.(CAMERA_BUTTON_SELECTOR)
  if (!button) return
  event.preventDefault()
  event.stopImmediatePropagation()
  void startScanner()
}

function markScannerUi() {
  if (!onLabelsPage()) return
  const button = document.querySelector(CAMERA_BUTTON_SELECTOR)
  if (!button) return
  button.setAttribute('aria-label', 'Open live barcode scanner')
  button.setAttribute('title', 'Live barcode scanner · reads automatically')
  const input = searchInput()
  if (input) input.setAttribute('autocomplete', 'off')
}

export function installSupermarketBarcodeScannerV25() {
  if (installed || typeof window === 'undefined') return
  installed = true
  document.addEventListener('keydown', hardwareKeydown, true)
  document.addEventListener('click', cameraButtonClick, true)

  const apply = () => window.requestAnimationFrame(markScannerUi)
  const observer = new MutationObserver(apply)
  const start = () => {
    observer.observe(document.body, { childList: true, subtree: true })
    window.addEventListener('popstate', apply)
    window.addEventListener('pageshow', apply)
    apply()
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true })
  else start()
}
