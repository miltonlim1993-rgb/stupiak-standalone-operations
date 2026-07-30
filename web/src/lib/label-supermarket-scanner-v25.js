export const LABEL_SUPERMARKET_SCANNER_VERSION = '4.6.24-supermarket-scanner-v25'

const SCAN_GAP_MS = 80
const MIN_SCAN_LENGTH = 6
const DUPLICATE_LOCK_MS = 1400
const CAMERA_FORMATS = [
  'ean_13',
  'ean_8',
  'upc_a',
  'upc_e',
  'code_128',
  'code_39',
  'itf',
  'qr_code',
  'data_matrix',
]

let installed = false
let observer = null
let cameraSession = null
let keyboardBuffer = ''
let keyboardStartedAt = 0
let keyboardLastAt = 0
let keyboardMaxGap = 0
let lastAcceptedCode = ''
let lastAcceptedAt = 0
let toastTimer = 0

function labelsPage() {
  return window.location.pathname === '/labels'
}

function searchInput() {
  return document.querySelector('input[placeholder="Barcode or batch code"], input[data-label-barcode-search]')
}

function cameraButton() {
  return document.querySelector('button[aria-label="Scan label with camera"]')
}

function fallbackCameraInput() {
  return document.querySelector('input[type="file"][accept*="image"][capture]')
}

function cleanCode(value) {
  return String(value || '').trim().replace(/[\r\n\t]+/g, '')
}

export function normalizeSupermarketScan(value) {
  const raw = cleanCode(value).toUpperCase()
  if (!raw) return ''

  const digits = raw.replace(/\D/g, '')
  const ean13 = digits.match(/\d{13}/)
  if (ean13) return ean13[0]

  const ean8 = digits.match(/^\d{8}$/)
  if (ean8) return ean8[0]

  const batch = raw.match(/\b([A-Z0-9]{2,8})[\s-]*(\d{6})[\s-]*(\d{3,4})\b/)
  if (batch) return `${batch[1]}-${batch[2]}-${batch[3]}`

  const legacy = raw.replace(/[^A-Z0-9]/g, '').match(/B[0-9O]{16}/)
  if (legacy) return legacy[0].replace(/O/g, '0')

  const generic = raw.replace(/[^A-Z0-9._/-]/g, '')
  return generic.length >= MIN_SCAN_LENGTH && generic.length <= 96 ? generic : ''
}

function setReactInputValue(input, value) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
  if (setter) setter.call(input, value)
  else input.value = value
  input.dispatchEvent(new Event('input', { bubbles: true }))
  input.dispatchEvent(new Event('change', { bubbles: true }))
}

function showToast(message, tone = 'neutral') {
  window.clearTimeout(toastTimer)
  document.querySelector('[data-supermarket-scan-toast]')?.remove()

  const toast = document.createElement('div')
  toast.dataset.supermarketScanToast = 'true'
  toast.setAttribute('role', 'status')
  toast.textContent = message
  const palette = tone === 'success'
    ? 'background:#059669;color:#fff;'
    : tone === 'error'
      ? 'background:#b91c1c;color:#fff;'
      : 'background:#111827;color:#fff;'
  toast.style.cssText = `position:fixed;left:50%;bottom:calc(22px + env(safe-area-inset-bottom));transform:translateX(-50%);z-index:2147483647;max-width:min(92vw,520px);padding:10px 14px;border-radius:12px;box-shadow:0 12px 30px rgba(0,0,0,.24);font:700 13px/1.25 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;text-align:center;${palette}`
  document.body.appendChild(toast)
  toastTimer = window.setTimeout(() => toast.remove(), 1900)
}

function scanFeedback() {
  try {
    navigator.vibrate?.(45)
  } catch {}

  try {
    const AudioContext = window.AudioContext || window.webkitAudioContext
    if (!AudioContext) return
    const context = new AudioContext()
    const oscillator = context.createOscillator()
    const gain = context.createGain()
    oscillator.type = 'sine'
    oscillator.frequency.value = 980
    gain.gain.setValueAtTime(0.0001, context.currentTime)
    gain.gain.exponentialRampToValueAtTime(0.12, context.currentTime + 0.01)
    gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.09)
    oscillator.connect(gain)
    gain.connect(context.destination)
    oscillator.start()
    oscillator.stop(context.currentTime + 0.1)
    oscillator.addEventListener('ended', () => context.close().catch(() => undefined), { once: true })
  } catch {}
}

function submitLookupCode(rawValue, source = 'scanner') {
  const code = normalizeSupermarketScan(rawValue)
  if (!code) {
    showToast('Barcode could not be read', 'error')
    return false
  }

  const now = Date.now()
  if (code === lastAcceptedCode && now - lastAcceptedAt < DUPLICATE_LOCK_MS) return false
  lastAcceptedCode = code
  lastAcceptedAt = now

  const input = searchInput()
  if (!input) {
    showToast('Open Food Labels before scanning', 'error')
    return false
  }

  setReactInputValue(input, code)
  scanFeedback()
  showToast(source === 'camera' ? `Barcode read · ${code}` : `Scanned · ${code}`, 'success')

  window.setTimeout(() => {
    input.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Enter',
      code: 'Enter',
      keyCode: 13,
      which: 13,
      bubbles: true,
      cancelable: true,
    }))
  }, 35)
  return true
}

function resetKeyboardScanner() {
  keyboardBuffer = ''
  keyboardStartedAt = 0
  keyboardLastAt = 0
  keyboardMaxGap = 0
}

function editableTarget(target) {
  if (!(target instanceof Element)) return false
  return Boolean(target.closest('textarea, select, [contenteditable="true"], input:not([placeholder="Barcode or batch code"])'))
}

function onHardwareScannerKeydown(event) {
  if (!labelsPage() || cameraSession || event.defaultPrevented) return
  if (event.ctrlKey || event.altKey || event.metaKey) return
  if (editableTarget(event.target)) {
    resetKeyboardScanner()
    return
  }

  const now = performance.now()
  const terminator = event.key === 'Enter' || event.key === 'Tab'
  if (terminator) {
    const candidate = keyboardBuffer
    const duration = keyboardStartedAt ? now - keyboardStartedAt : Number.POSITIVE_INFINITY
    const looksLikeScanner = candidate.length >= MIN_SCAN_LENGTH
      && keyboardMaxGap <= SCAN_GAP_MS
      && duration <= Math.max(900, candidate.length * SCAN_GAP_MS)
    resetKeyboardScanner()
    if (!looksLikeScanner) return
    event.preventDefault()
    event.stopPropagation()
    submitLookupCode(candidate, 'hardware')
    return
  }

  if (event.key.length !== 1) return
  if (keyboardLastAt && now - keyboardLastAt > SCAN_GAP_MS) resetKeyboardScanner()
  if (!keyboardStartedAt) keyboardStartedAt = now
  if (keyboardLastAt) keyboardMaxGap = Math.max(keyboardMaxGap, now - keyboardLastAt)
  keyboardLastAt = now
  keyboardBuffer += event.key
  if (keyboardBuffer.length > 128) resetKeyboardScanner()
}

function stopCameraScanner() {
  const session = cameraSession
  cameraSession = null
  if (!session) return
  window.clearTimeout(session.timer)
  session.stream?.getTracks?.().forEach((track) => track.stop())
  session.modal?.remove()
  document.documentElement.style.removeProperty('overflow')
}

function cameraModal() {
  const modal = document.createElement('div')
  modal.dataset.supermarketCameraScanner = 'true'
  modal.style.cssText = 'position:fixed;inset:0;z-index:2147483646;background:#050505;color:#fff;display:flex;flex-direction:column;font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;'
  modal.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;padding:14px 16px;background:rgba(0,0,0,.78);">
      <div><div style="font-size:16px;font-weight:800;">Scan barcode</div><div data-camera-status style="margin-top:2px;font-size:12px;color:#d1d5db;">Starting camera…</div></div>
      <button type="button" data-camera-close aria-label="Close scanner" style="height:40px;width:40px;border:1px solid rgba(255,255,255,.35);border-radius:12px;background:rgba(255,255,255,.1);color:#fff;font-size:24px;line-height:1;">×</button>
    </div>
    <div style="position:relative;min-height:0;flex:1;overflow:hidden;background:#000;">
      <video data-camera-video autoplay muted playsinline style="height:100%;width:100%;object-fit:cover;"></video>
      <div style="pointer-events:none;position:absolute;left:10%;right:10%;top:32%;height:30%;border:3px solid #f6b900;border-radius:18px;box-shadow:0 0 0 9999px rgba(0,0,0,.34);">
        <div style="position:absolute;left:8%;right:8%;top:50%;height:2px;background:#f6b900;box-shadow:0 0 10px rgba(246,185,0,.9);"></div>
      </div>
      <div style="position:absolute;left:16px;right:16px;bottom:24px;padding:10px 12px;border-radius:12px;background:rgba(0,0,0,.7);font-size:13px;font-weight:650;text-align:center;">Place the complete barcode inside the yellow frame. It reads automatically.</div>
    </div>
  `
  modal.querySelector('[data-camera-close]')?.addEventListener('click', stopCameraScanner)
  return modal
}

async function openContinuousCameraScanner() {
  if (cameraSession) return
  if (!('BarcodeDetector' in globalThis) || !navigator.mediaDevices?.getUserMedia) {
    showToast('Live scanner is unavailable here. Opening photo scan.', 'neutral')
    fallbackCameraInput()?.click()
    return
  }

  const modal = cameraModal()
  document.body.appendChild(modal)
  document.documentElement.style.overflow = 'hidden'
  const status = modal.querySelector('[data-camera-status]')
  const video = modal.querySelector('[data-camera-video]')
  cameraSession = { modal, stream: null, timer: 0, detecting: false }

  try {
    const supported = typeof globalThis.BarcodeDetector.getSupportedFormats === 'function'
      ? await globalThis.BarcodeDetector.getSupportedFormats()
      : CAMERA_FORMATS
    const formats = CAMERA_FORMATS.filter((format) => supported.includes(format))
    const detector = formats.length
      ? new globalThis.BarcodeDetector({ formats })
      : new globalThis.BarcodeDetector()
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        facingMode: { ideal: 'environment' },
        width: { ideal: 1280 },
        height: { ideal: 720 },
      },
    })
    if (!cameraSession) {
      stream.getTracks().forEach((track) => track.stop())
      return
    }
    cameraSession.stream = stream
    video.srcObject = stream
    await video.play()
    if (status) status.textContent = 'Scanner ready · reading continuously'

    const detectFrame = async () => {
      const session = cameraSession
      if (!session) return
      try {
        if (!session.detecting && video.readyState >= 2) {
          session.detecting = true
          const results = await detector.detect(video)
          const code = results.map((result) => normalizeSupermarketScan(result.rawValue)).find(Boolean)
          session.detecting = false
          if (code && submitLookupCode(code, 'camera')) {
            stopCameraScanner()
            return
          }
        }
      } catch (error) {
        session.detecting = false
        console.debug('Continuous barcode detection retry', error)
      }
      if (cameraSession) cameraSession.timer = window.setTimeout(detectFrame, 120)
    }
    detectFrame()
  } catch (error) {
    if (status) status.textContent = error?.name === 'NotAllowedError'
      ? 'Camera permission was not allowed.'
      : 'Camera could not start.'
    showToast(error?.name === 'NotAllowedError' ? 'Allow camera permission to scan' : 'Camera scanner could not start', 'error')
  }
}

function enhanceCameraButton() {
  const button = cameraButton()
  if (!button || button.dataset.supermarketScannerReady === 'true') return
  button.dataset.supermarketScannerReady = 'true'
  button.title = 'Live barcode scanner'
  button.addEventListener('click', (event) => {
    event.preventDefault()
    event.stopImmediatePropagation()
    openContinuousCameraScanner()
  }, true)
}

function markScannerReady() {
  const input = searchInput()
  if (!input) return
  input.dataset.labelBarcodeSearch = 'true'
  input.setAttribute('autocomplete', 'off')
  input.setAttribute('inputmode', 'none')
  input.title = 'Scan with a USB/Bluetooth barcode scanner at any time, or type a batch code.'
  enhanceCameraButton()
}

function apply() {
  if (!labelsPage()) {
    stopCameraScanner()
    return
  }
  markScannerReady()
}

export function installLabelSupermarketScannerV25() {
  if (installed || typeof window === 'undefined') return
  installed = true
  window.addEventListener('keydown', onHardwareScannerKeydown, true)
  window.addEventListener('popstate', apply)
  window.addEventListener('pageshow', apply)
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stopCameraScanner()
  })

  const start = () => {
    apply()
    observer = new MutationObserver(apply)
    observer.observe(document.body, { childList: true, subtree: true })
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true })
  else start()
}
