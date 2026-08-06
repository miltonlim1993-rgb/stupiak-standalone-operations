import { resolveLabelSizeContract } from './label-size-contract-v14.js'

let installed = false
let scheduled = false
let lastSignature = ''

function onSettingsPage() {
  return window.location.pathname === '/labels/settings'
}

function fieldInput(labelText) {
  const wanted = String(labelText || '').trim().toLowerCase()
  const labels = [...document.querySelectorAll('label')]
  const label = labels.find((item) => String(item.textContent || '').trim().toLowerCase() === wanted)
  const host = label?.parentElement
  return host?.querySelector('input, select') || null
}

function orientationInput() {
  return [...document.querySelectorAll('select')].find((select) => {
    const values = new Set([...select.options].map((option) => option.value))
    return values.has('auto') && values.has('portrait') && values.has('landscape')
  }) || null
}

function currentFormProfile() {
  return {
    label_width_mm: fieldInput('Media width (mm)')?.value || 40,
    label_height_mm: fieldInput('Feed length (mm)')?.value || 30,
    dpi: fieldInput('DPI')?.value || 203,
    orientation: orientationInput()?.value || 'auto',
  }
}

function statusHost() {
  const orientation = orientationInput()
  if (orientation?.parentElement) return orientation.parentElement
  return document.querySelector('[data-printer-workspace]')
}

function row(labelCn, labelEn, value, good = false) {
  return `<div style="display:flex;justify-content:space-between;gap:12px;align-items:flex-start"><span style="color:hsl(var(--muted-foreground));min-width:0">${labelCn}<br><span style="font-size:10px">${labelEn}</span></span><strong style="text-align:right;${good ? 'color:#059669' : ''}">${value}</strong></div>`
}

function render() {
  scheduled = false
  if (!onSettingsPage()) return
  const host = statusHost()
  if (!host) return

  const contract = resolveLabelSizeContract(currentFormProfile())
  const signature = `${contract.signature}|${contract.content_orientation}|${contract.rotate_content}`
  let card = document.getElementById('chefops-label-size-contract-v14')
  if (!card) {
    card = document.createElement('div')
    card.id = 'chefops-label-size-contract-v14'
    card.setAttribute('data-label-size-contract', 'v14')
    card.className = 'mt-3 rounded-2xl border border-emerald-200 bg-emerald-50/70 p-3 text-xs leading-5 text-emerald-950 dark:border-emerald-900 dark:bg-emerald-950/30 dark:text-emerald-100'
    host.appendChild(card)
  }
  if (lastSignature === signature && card.dataset.signature === signature) return
  lastSignature = signature
  card.dataset.signature = signature

  const physical = `${contract.physical_width_mm.toFixed(1)} × ${contract.physical_height_mm.toFixed(1)} mm`
  const content = `${contract.content_width_mm.toFixed(1)} × ${contract.content_height_mm.toFixed(1)} mm${contract.rotate_content ? ' · rotate 90°' : ''}`
  const raster = `${contract.raster_width_dots} × ${contract.raster_height_dots} dots @ ${Math.round(contract.dpi)} dpi`
  card.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:9px">
      <strong style="font-size:12px">创建标签与实体纸张尺寸 / Created Label Size Contract</strong>
      <span style="border-radius:999px;background:#d1fae5;color:#047857;padding:2px 8px;font-weight:800">已匹配 / Matched</span>
    </div>
    <div style="display:grid;gap:7px">
      ${row('设置中的实体纸张', 'Physical media in settings', physical, true)}
      ${row('创建后的标签画布', 'Created label canvas', physical, true)}
      ${row('内容排版平面', 'Content layout plane', content)}
      ${row('Android / Raster 画布', 'Android / Raster canvas', raster, true)}
      ${row('TSPL / ZPL / CPCL 尺寸', 'Native command media size', physical, true)}
      ${row('Android System Print 纸张', 'Android System Print media', `${contract.android_width_mils} × ${contract.android_height_mils} mils`, true)}
    </div>
    <p style="margin:9px 0 0;color:inherit;opacity:.82">Media width 是打印头横向宽度，Feed length 是每张标签沿进纸方向的长度。Portrait / Landscape 只改变内容排版，不会交换实体纸张尺寸。</p>`
}

function scheduleRender() {
  if (scheduled) return
  scheduled = true
  window.requestAnimationFrame(render)
}

export function installLabelSizeContractStatusV14() {
  if (installed || typeof window === 'undefined') return
  installed = true

  const start = () => {
    scheduleRender()
    document.addEventListener('input', scheduleRender, true)
    document.addEventListener('change', scheduleRender, true)
    const observer = new MutationObserver(scheduleRender)
    observer.observe(document.body, { childList: true, subtree: true })
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true })
  else start()

  window.addEventListener('popstate', scheduleRender)
  window.addEventListener('hashchange', scheduleRender)
}
