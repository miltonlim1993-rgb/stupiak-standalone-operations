import {
  normalizePrinterProfile,
  readPrinterDeviceBinding,
  readPrinterProfilesSnapshot,
  selectPrinterProfile,
} from './label-printer-profile.js'

const STYLE_ID = 'chefops-content-orientation'
const RASTER_MARKER = 'chefops-force-raster-orientation'
let installed = false

function clean(value = '') {
  return String(value ?? '').trim().toLowerCase()
}

function numberValue(value, fallback, minimum = 1, maximum = 500) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(maximum, Math.max(minimum, number))
}

export function resolveLabelContentOrientation(profile = {}) {
  const normalized = normalizePrinterProfile(profile)
  const widthMm = numberValue(normalized.label_width_mm, 40)
  const heightMm = numberValue(normalized.label_height_mm, 30)
  const mediaOrientation = widthMm >= heightMm ? 'landscape' : 'portrait'
  const requested = ['portrait', 'landscape'].includes(clean(normalized.orientation))
    ? clean(normalized.orientation)
    : 'auto'
  const contentOrientation = requested === 'auto' ? mediaOrientation : requested
  const rotateContent = contentOrientation !== mediaOrientation

  return {
    orientation_mode: requested,
    media_orientation: mediaOrientation,
    content_orientation: contentOrientation,
    rotate_content: rotateContent,
    rotation_degrees: rotateContent ? 90 : 0,
    width_mm: widthMm,
    height_mm: heightMm,
    content_width_mm: rotateContent ? heightMm : widthMm,
    content_height_mm: rotateContent ? widthMm : heightMm,
  }
}

function removePreviousOrientation(source = '') {
  return String(source || '')
    .replace(new RegExp(`<style\\s+id=["']${STYLE_ID}["'][^>]*>[\\s\\S]*?<\\/style>`, 'gi'), '')
    .replace(new RegExp(`<span\\b[^>]*data-${RASTER_MARKER}=["']1["'][^>]*>[\\s\\S]*?<\\/span>`, 'gi'), '')
}

function insertIntoHead(source, style) {
  return source.includes('</head>')
    ? source.replace('</head>', `${style}</head>`)
    : `${style}${source}`
}

function forceRasterForRotatedNativeTspl(source) {
  const marker = `<span data-${RASTER_MARKER}="1" style="display:none!important">旋</span>`
  const titlePattern = /(<(?:div|h1|h2|span)\b[^>]*class=["'][^"']*\btitle\b[^"']*["'][^>]*>)/i
  return titlePattern.test(source) ? source.replace(titlePattern, `$1${marker}`) : source
}

export function applyLabelContentOrientation(html, profile = {}) {
  const layout = resolveLabelContentOrientation(profile)
  let source = removePreviousOrientation(html)
  if (!layout.rotate_content) return { html: source, layout }

  const style = `<style id="${STYLE_ID}">
html body .label{
  width:${layout.content_width_mm}mm!important;
  min-width:${layout.content_width_mm}mm!important;
  max-width:${layout.content_width_mm}mm!important;
  height:${layout.content_height_mm}mm!important;
  min-height:${layout.content_height_mm}mm!important;
  max-height:${layout.content_height_mm}mm!important;
  transform-origin:0 0!important;
  transform:translateX(${layout.width_mm}mm) rotate(90deg)!important;
}
</style>`

  source = insertIntoHead(source, style)
  source = forceRasterForRotatedNativeTspl(source)
  return { html: source, layout }
}

function currentOutletId() {
  try {
    return String(window.localStorage.getItem('chefops.data-pack.outlet') || '').trim()
  } catch {
    return ''
  }
}

function cachedProfile() {
  const outletId = currentOutletId()
  if (!outletId) return null
  const binding = readPrinterDeviceBinding(outletId)
  return selectPrinterProfile(
    readPrinterProfilesSnapshot(outletId),
    outletId,
    binding.selected_profile_id,
  )
}

function isLabelPopup(url, target, features) {
  const featureText = String(features || '').toLowerCase()
  return String(target || '') === '_blank'
    && (!url || String(url) === 'about:blank')
    && featureText.includes('width=480')
    && featureText.includes('height=640')
}

function decorateLabelWindow(opened) {
  if (!opened?.document) return opened

  const wrapWriter = () => {
    const currentWrite = opened.document.write
    if (typeof currentWrite !== 'function' || currentWrite.__chefopsContentOrientationV7) return
    const originalWrite = currentWrite.bind(opened.document)
    const wrappedWrite = (value) => {
      const profile = cachedProfile()
      if (!profile) return originalWrite(value)
      const transformed = applyLabelContentOrientation(String(value ?? ''), profile)
      window.__chefopsContentOrientation = transformed.layout
      return originalWrite(transformed.html)
    }
    wrappedWrite.__chefopsContentOrientationV7 = true
    opened.document.write = wrappedWrite
  }

  if (typeof opened.document.open === 'function' && !opened.document.open.__chefopsContentOrientationV7) {
    const originalOpen = opened.document.open.bind(opened.document)
    const wrappedOpen = (...args) => {
      const result = originalOpen(...args)
      wrapWriter()
      return result
    }
    wrappedOpen.__chefopsContentOrientationV7 = true
    opened.document.open = wrappedOpen
  }

  wrapWriter()
  return opened
}

function orientationSelect() {
  return [...document.querySelectorAll('select')].find((select) => {
    const values = new Set([...select.options].map((option) => option.value))
    return values.has('auto') && values.has('portrait') && values.has('landscape')
  })
}

function updateOrientationStatus() {
  const select = orientationSelect()
  if (!select) return
  const host = select.parentElement || select
  let status = host.querySelector('#chefops-content-orientation-status')
  if (!status) {
    status = document.createElement('p')
    status.id = 'chefops-content-orientation-status'
    status.className = 'mt-2 rounded-xl border border-border bg-muted/30 px-3 py-2 text-xs leading-5 text-muted-foreground'
    host.appendChild(status)
  }

  const selected = clean(select.value) || 'auto'
  status.textContent = selected === 'portrait'
    ? '直向内容 / Portrait content：纸张宽度与进纸长度保持不变；需要时只旋转内容 90°。'
    : selected === 'landscape'
      ? '横向内容 / Landscape content：纸张宽度与进纸长度保持不变；需要时只旋转内容 90°。'
      : '自动方向 / Auto：内容跟随实际纸张方向，纸张尺寸不会互换。'
}

export function installLabelContentOrientationV7() {
  if (installed || typeof window === 'undefined') return
  installed = true

  const underlyingOpen = window.open.bind(window)
  window.open = function chefopsContentOrientationWindowOpen(url = '', target = '', features = '') {
    const opened = underlyingOpen(url, target, features)
    return isLabelPopup(url, target, features) ? decorateLabelWindow(opened) : opened
  }

  const startUi = () => {
    updateOrientationStatus()
    document.addEventListener('change', (event) => {
      if (event.target === orientationSelect()) updateOrientationStatus()
    })
    const observer = new MutationObserver(() => updateOrientationStatus())
    observer.observe(document.body, { childList: true, subtree: true })
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', startUi, { once: true })
  else startUi()
}
