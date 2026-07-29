import {
  normalizePrinterProfile,
  readPrinterDeviceBinding,
  readPrinterProfilesSnapshot,
  selectPrinterProfile,
} from './label-printer-profile.js'

export const LABEL_SIZE_CONTRACT_VERSION = '4.6.12-label-size-contract-v14'
const STYLE_ID = 'chefops-created-label-geometry'
const META_NAME = 'chefops-created-label-geometry'
let installed = false

function numberValue(value, fallback, minimum = 0.1, maximum = 1000) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(maximum, Math.max(minimum, number))
}

function clean(value = '') {
  return String(value ?? '').trim().toLowerCase()
}

function almostEqual(left, right, tolerance = 0.01) {
  return Math.abs(Number(left) - Number(right)) <= tolerance
}

export function mmToPrinterDots(mm, dpi) {
  return Math.max(1, Math.round((numberValue(mm, 1) / 25.4) * numberValue(dpi, 203, 72, 1200)))
}

export function mmToAndroidMils(mm) {
  return Math.max(1, Math.round((numberValue(mm, 1) / 25.4) * 1000))
}

export function extractLastPageSizeMm(html = '') {
  const matches = [...String(html || '').matchAll(/@page\s*\{[^}]*size\s*:\s*([0-9.]+)mm\s+([0-9.]+)mm/gi)]
  const match = matches.at(-1)
  return match
    ? { width_mm: numberValue(match[1], 40), height_mm: numberValue(match[2], 30) }
    : { width_mm: 40, height_mm: 30 }
}

export function resolveLabelSizeContract(profile = {}, sourceDimensions = {}) {
  const normalized = normalizePrinterProfile(profile)
  const widthMm = numberValue(
    normalized.label_width_mm ?? normalized.width_mm,
    numberValue(sourceDimensions.width_mm ?? sourceDimensions.widthMm, 40),
    1,
    500,
  )
  const heightMm = numberValue(
    normalized.label_height_mm ?? normalized.height_mm,
    numberValue(sourceDimensions.height_mm ?? sourceDimensions.heightMm, 30),
    1,
    500,
  )
  const dpi = numberValue(normalized.dpi ?? profile.dpi, 203, 72, 1200)
  const mediaOrientation = widthMm >= heightMm ? 'landscape' : 'portrait'
  const requested = ['portrait', 'landscape'].includes(clean(normalized.orientation))
    ? clean(normalized.orientation)
    : 'auto'
  const contentOrientation = requested === 'auto' ? mediaOrientation : requested
  const rotateContent = contentOrientation !== mediaOrientation
  const contentWidthMm = rotateContent ? heightMm : widthMm
  const contentHeightMm = rotateContent ? widthMm : heightMm

  return {
    version: LABEL_SIZE_CONTRACT_VERSION,
    physical_width_mm: widthMm,
    physical_height_mm: heightMm,
    created_canvas_width_mm: widthMm,
    created_canvas_height_mm: heightMm,
    content_width_mm: contentWidthMm,
    content_height_mm: contentHeightMm,
    dpi,
    raster_width_dots: mmToPrinterDots(widthMm, dpi),
    raster_height_dots: mmToPrinterDots(heightMm, dpi),
    android_width_mils: mmToAndroidMils(widthMm),
    android_height_mils: mmToAndroidMils(heightMm),
    media_orientation: mediaOrientation,
    content_orientation: contentOrientation,
    rotate_content: rotateContent,
    rotation_degrees: rotateContent ? 90 : 0,
    signature: `${widthMm.toFixed(1)}x${heightMm.toFixed(1)}mm@${Math.round(dpi)}dpi=${mmToPrinterDots(widthMm, dpi)}x${mmToPrinterDots(heightMm, dpi)}dots`,
  }
}

function removePreviousContract(html = '') {
  return String(html || '')
    .replace(new RegExp(`<style\\s+id=["']${STYLE_ID}["'][^>]*>[\\s\\S]*?<\\/style>`, 'gi'), '')
    .replace(new RegExp(`<meta\\s+name=["']${META_NAME}["'][^>]*>`, 'gi'), '')
}

function insertIntoHead(source, value) {
  return source.includes('</head>') ? source.replace('</head>', `${value}</head>`) : `${value}${source}`
}

function contractStyle(contract, padding = {}) {
  const top = numberValue(padding.padding_top_mm, 1.2, 0, 20)
  const right = numberValue(padding.padding_right_mm, 1.7, 0, 20)
  const bottom = numberValue(padding.padding_bottom_mm, 0.75, 0, 20)
  const left = numberValue(padding.padding_left_mm, 1.7, 0, 20)
  const physicalWidth = contract.physical_width_mm
  const physicalHeight = contract.physical_height_mm
  const contentWidth = contract.content_width_mm
  const contentHeight = contract.content_height_mm
  const transform = contract.rotate_content
    ? `transform-origin:0 0!important;transform:translateX(${physicalWidth}mm) rotate(90deg)!important;`
    : 'transform:none!important;'

  return `<meta name="${META_NAME}" content="${contract.signature}">
<style id="${STYLE_ID}">
@page{size:${physicalWidth}mm ${physicalHeight}mm!important;margin:0!important}
html,body{margin:0!important;padding:0!important;width:${physicalWidth}mm!important;min-width:${physicalWidth}mm!important;max-width:${physicalWidth}mm!important;background:#fff!important}
.label{box-sizing:border-box!important;width:${contentWidth}mm!important;min-width:${contentWidth}mm!important;max-width:${contentWidth}mm!important;height:${contentHeight}mm!important;min-height:${contentHeight}mm!important;max-height:${contentHeight}mm!important;margin:0!important;padding:${top}mm ${right}mm ${bottom}mm ${left}mm!important;overflow:hidden!important;${transform}}
</style>`
}

export function applyCreatedLabelSizeContract(html, profile = {}) {
  const source = String(html || '')
  const sourceDimensions = extractLastPageSizeMm(source)
  const contract = resolveLabelSizeContract(profile, sourceDimensions)
  const withoutPrevious = removePreviousContract(source)
  return {
    html: insertIntoHead(withoutPrevious, contractStyle(contract, profile)),
    contract,
    source_dimensions: sourceDimensions,
    source_matched_setting: almostEqual(sourceDimensions.width_mm, contract.physical_width_mm)
      && almostEqual(sourceDimensions.height_mm, contract.physical_height_mm),
  }
}

export function auditLabelSizeChain({ html = '', contract = {}, layout = {}, tsplCommand = '' } = {}) {
  const page = extractLastPageSizeMm(html)
  const expectedWidth = numberValue(contract.physical_width_mm, 40)
  const expectedHeight = numberValue(contract.physical_height_mm, 30)
  const layoutWidth = numberValue(layout.width_mm ?? layout.label_width_mm, expectedWidth)
  const layoutHeight = numberValue(layout.height_mm ?? layout.label_height_mm, expectedHeight)
  const pageMatched = almostEqual(page.width_mm, expectedWidth) && almostEqual(page.height_mm, expectedHeight)
  const layoutMatched = almostEqual(layoutWidth, expectedWidth) && almostEqual(layoutHeight, expectedHeight)
  const tsplMatch = !tsplCommand || new RegExp(`SIZE\\s+${expectedWidth.toFixed(1)}\\s+mm,${expectedHeight.toFixed(1)}\\s+mm`, 'i').test(String(tsplCommand))
  return {
    matched: pageMatched && layoutMatched && tsplMatch,
    page_matched: pageMatched,
    layout_matched: layoutMatched,
    tspl_matched: tsplMatch,
    expected: { width_mm: expectedWidth, height_mm: expectedHeight },
    page,
    layout: { width_mm: layoutWidth, height_mm: layoutHeight },
  }
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

function isPrintableLabel(value = '') {
  const source = String(value || '')
  return source.includes('@page') && source.includes('class="label"')
}

function decorateCreatedLabelWindow(opened) {
  if (!opened?.document) return opened

  const wrapWriter = () => {
    const currentWrite = opened.document.write
    if (typeof currentWrite !== 'function' || currentWrite.__chefopsLabelSizeContractV14) return
    const originalWrite = currentWrite.bind(opened.document)
    const wrappedWrite = (value) => {
      const source = String(value ?? '')
      if (!isPrintableLabel(source)) return originalWrite(source)
      const profile = cachedProfile() || extractLastPageSizeMm(source)
      const transformed = applyCreatedLabelSizeContract(source, profile)
      window.__chefopsLastCreatedLabelSizeContract = transformed.contract
      window.__chefopsLastCreatedLabelSourceMatched = transformed.source_matched_setting
      return originalWrite(transformed.html)
    }
    wrappedWrite.__chefopsLabelSizeContractV14 = true
    opened.document.write = wrappedWrite
  }

  if (typeof opened.document.open === 'function' && !opened.document.open.__chefopsLabelSizeContractV14) {
    const originalOpen = opened.document.open.bind(opened.document)
    const wrappedOpen = (...args) => {
      const result = originalOpen(...args)
      wrapWriter()
      return result
    }
    wrappedOpen.__chefopsLabelSizeContractV14 = true
    opened.document.open = wrappedOpen
  }

  wrapWriter()
  return opened
}

export function installCreatedLabelSizeContractV14() {
  if (installed || typeof window === 'undefined') return
  installed = true
  const underlyingOpen = window.open.bind(window)
  window.open = function chefopsLabelSizeContractOpen(url = '', target = '', features = '') {
    const opened = underlyingOpen(url, target, features)
    return isLabelPopup(url, target, features) ? decorateCreatedLabelWindow(opened) : opened
  }
}
