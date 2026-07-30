export const SUPERMARKET_BARCODE_SCANNER_VERSION = '4.6.24-supermarket-barcode-scanner-v25'

const SEARCH_SELECTOR = 'input[placeholder="Barcode or batch code"]'
const CAMERA_SELECTOR = 'button[data-live-barcode-scanner],button[aria-label="Scan label with camera"],button[aria-label="Open live barcode scanner"]'
const MIN_LENGTH = 6
const MAX_GAP_MS = 120
const MAX_DURATION_MS = 1800

let installed = false
let buffer = ''
let startedAt = 0
let lastKeyAt = 0
let resetTimer = 0
let scannerCleanup = null
let lastCode = ''
let lastCodeAt = 0

const clean = (value = '') => String(value ?? '').trim()
export const normaliseScannedValue = (value = '') => clean(value).replace(/[\r\n\t]/g, '').trim()

export function isLikelyHardwareScannerInput(value, durationMs) {
  const code = normaliseScannedValue(value)
  if (code.length < MIN_LENGTH || code.length > 128) return false
  if (!Number.isFinite(durationMs) || durationMs < 0 || durationMs > MAX_DURATION_MS) return false
  return durationMs / Math.max(1, code.length - 1) <= MAX_GAP_MS
}

function labelsPage() {
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

export function submitScannedLookup(value) {
  const code = normaliseScannedValue(value)
  const input = searchInput()
  if (!code || !input) return false

  const now = Date.now()
  if (code === lastCode && now - lastCodeAt < 1200) return false
  lastCode = code
  lastCodeAt = now

  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
  if (setter) setter.call(input, code)
  else input.value = code
  input.dispatchEvent(new Event('input', { bubbles: true }))
  input.dispatchEvent(new Event('change', { bubbles: true }))
  input.focus({ preventScroll: true })
  window.setTimeout(() => input.dispatchEvent(new KeyboardEvent('keydown', {
    key: 'Enter', code: 'Enter', bubbles: true, cancelable: true,
  })), 40)
  return true
}

function resetBuffer() {
  buffer = ''
  startedAt = 0
  lastKeyAt = 0
  window.clearTimeout(resetTimer)
  resetTimer = 0
}

function hardwareKeydown(event) {
  if (!labelsPage() || scannerCleanup || event.ctrlKey || event.altKey || event.metaKey) return
  const now = performance.now()

  if (event.key === 'Enter' || event.key === 'Tab') {
    const code = buffer
    const duration = startedAt ? now - startedAt : Infinity
    resetBuffer()
    if (!isLikelyHardwareScannerInput(code, duration)) return
    event.preventDefault()
    event.stopImmediatePropagation()
    submitScannedLookup(code)
    return
  }

  if (event.key.length !== 1) return
  if (lastKeyAt && now - lastKeyAt > MAX_GAP_MS) resetBuffer()
  if (!buffer) startedAt = now
  buffer += event.key
  lastKeyAt = now
  window.clearTimeout(resetTimer)
  resetTimer = window.setTimeout(resetBuffer, 300)
}

function successFeedback() {
  navigator.vibrate?.(80)
  try {
    const Audio = window.AudioContext || window.webkitAudioContext
    if (!Audio) return
    const context = new Audio()
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
    // Feedback is optional.
  }
}

function complete(value) {
  if (!submitScannedLookup(value)) return false
  successFeedback()
  return true
}

function photoFallback(message = '') {
  if (message) console.info(message)
  document.querySelector('input[type="file"][capture="environment"]')?.click()
}

function createOverlay() {
  const overlay = document.createElement('div')
  overlay.dataset.supermarketScanner = SUPERMARKET_BARCODE_SCANNER_VERSION
  overlay.setAttribute('role', 'dialog')
  overlay.setAttribute('aria-modal', 'true')
  Object.assign(overlay.style, {
    position: 'fixed', inset: '0', zIndex: '2147483647', background: '#050505', color: '#fff',
    display: 'flex', flexDirection: 'column',
  })
  overlay.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;padding:16px">
      <div><strong style="font-size:17px">Scan barcode</strong><div data-scan-status style="font-size:12px;color:#d4d4d4;margin-top:3px">Point at the barcode — it reads automatically</div></div>
      <button data-scan-close type="button" style="border:1px solid #666;border-radius:10px;background:#171717;color:#fff;padding:9px 14px;font-weight:700">Close</button>
    </div>
    <div style="position:relative;flex:1;min-height:0;overflow:hidden;background:#000">
      <video autoplay muted playsinline style="width:100%;height:100%;object-fit:cover"></video>
      <div style="position:absolute;left:8%;right:8%;top:36%;height:28%;border:3px solid #f6b900;border-radius:18px;box-shadow:0 0 0 9999px rgba(0,0,0,.42)">
        <div style="position:absolute;left:4%;right:4%;top:50%;height:2px;background:#f6b900;box-shadow:0 0 10px #f6b900"></div>
      </div>
    </div>`
  document.body.appendChild(overlay)
  return {
    overlay,
    video: overlay.querySelector('video'),
    close: overlay.querySelector('[data-scan-close]'),
    status: overlay.querySelector('[data-scan-status]'),
  }
}

async function liveWebScan() {
  if (!navigator.mediaDevices?.getUserMedia || !('BarcodeDetector' in globalThis)) {
    photoFallback('Live barcode scanning is unavailable in this browser; using photo scan fallback.')
    return
  }

  const { overlay, video, close, status } = createOverlay()
  let stream = null
  let stopped = false
  let detecting = false
  let lastDetect = 0
  const cleanup = () => {
    if (stopped) return
    stopped = true
    stream?.getTracks?.().forEach((track) => track.stop())
    overlay.remove()
    scannerCleanup = null
  }
  scannerCleanup = cleanup
  close.addEventListener('click', cleanup, { once: true })

  try {
    const preferred = ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'qr_code']
    const supported = typeof globalThis.BarcodeDetector.getSupportedFormats === 'function'
      ? await globalThis.BarcodeDetector.getSupportedFormats()
      : preferred
    const formats = preferred.filter((format) => supported.includes(format))
    const detector = formats.length ? new globalThis.BarcodeDetector({ formats }) : new globalThis.BarcodeDetector()
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
    })
    video.srcObject = stream
    await video.play()

    const frame = async (timestamp) => {
      if (stopped) return
      if (!detecting && timestamp - lastDetect >= 120 && video.readyState >= 2) {
        detecting = true
        lastDetect = timestamp
        try {
          const results = await detector.detect(video)
          const code = results.map((result) => normaliseScannedValue(result.rawValue)).find(Boolean)
          if (code) {
            cleanup()
            complete(code)
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
    photoFallback(clean(error?.message) || 'Camera could not start; using photo scan fallback.')
  }
}

async function startScanner() {
  if (scannerCleanup) return
  const nativeScanner = window.Capacitor?.Plugins?.NativeBarcodeScanner
  if (nativeAndroid() && nativeScanner?.scan) {
    try {
      const result = await nativeScanner.scan()
      const value = normaliseScannedValue(result?.rawValue || result?.value)
      if (!value) throw new Error('No barcode was returned')
      complete(value)
      return
    } catch (error) {
      if (/cancel/i.test(clean(error?.message))) return
      console.error('Native barcode scan failed', error)
    }
  }
  await liveWebScan()
}

function cameraClick(event) {
  if (!labelsPage()) return
  const button = event.target?.closest?.(CAMERA_SELECTOR)
  if (!button) return
  event.preventDefault()
  event.stopImmediatePropagation()
  void startScanner()
}

function markUi() {
  if (!labelsPage()) return
  const button = document.querySelector(CAMERA_SELECTOR)
  if (button) {
    button.dataset.liveBarcodeScanner = SUPERMARKET_BARCODE_SCANNER_VERSION
    button.setAttribute('aria-label', 'Open live barcode scanner')
    button.setAttribute('title', 'Live barcode scanner · reads automatically')
  }
  searchInput()?.setAttribute('autocomplete', 'off')
}

export function installSupermarketBarcodeScannerV25() {
  if (installed || typeof window === 'undefined') return
  installed = true
  document.addEventListener('keydown', hardwareKeydown, true)
  document.addEventListener('click', cameraClick, true)
  const apply = () => window.requestAnimationFrame(markUi)
  const start = () => {
    new MutationObserver(apply).observe(document.body, { childList: true, subtree: true })
    window.addEventListener('popstate', apply)
    window.addEventListener('pageshow', apply)
    apply()
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true })
  else start()
}
