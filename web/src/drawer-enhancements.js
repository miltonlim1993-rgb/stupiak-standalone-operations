/*
 * Stupiak's Ops drawer enhancements v3.0.0
 * UI-only runtime enhancement for Urgent Issue and Inventory create drawers.
 * Does not change global Sheet readers, schemas, ports, or dependencies.
 */

const API_BASE_URL = (
  window.__OPS_API_BASE_URL__
  || (window.location.hostname === 'localhost' ? 'http://localhost:8787' : window.location.origin)
).replace(/\/$/, '')

const ISSUE_MARKER = '[[ISSUE_PHOTOS_V1]]'
const MAX_ISSUE_PHOTOS = 4
const MAX_FILE_BYTES = 8 * 1024 * 1024

const state = {
  issueDialog: null,
  issueFiles: [],
  installed: false,
  nativeFetch: window.fetch.bind(window),
}

function svgIcon(name, size = 18) {
  const common = `width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"`
  const paths = {
    camera: '<path d="M14.5 4 16 7h3a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2h3l1.5-3z"/><circle cx="12" cy="13" r="3.2"/>',
    image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8.5" cy="9" r="1.5"/><path d="m21 15-5-5L5 20"/>',
    trash: '<path d="M3 6h18M8 6V4h8v2m-9 0 1 14h8l1-14M10 10v6m4-6v6"/>',
    alert: '<path d="M12 3 2.8 19h18.4L12 3Z"/><path d="M12 9v4m0 3h.01"/>',
    box: '<path d="m21 8-9-5-9 5 9 5 9-5Z"/><path d="m3 8 9 5 9-5M3 8v8l9 5 9-5V8M12 13v8"/>',
    upload: '<path d="M12 16V4m0 0-4 4m4-4 4 4"/><path d="M4 15v4h16v-4"/>',
    check: '<path d="m5 12 4 4L19 6"/>',
  }
  return `<svg ${common}>${paths[name] || paths.image}</svg>`
}

function installStyles() {
  if (document.getElementById('ops-drawer-enhancement-styles')) return
  const style = document.createElement('style')
  style.id = 'ops-drawer-enhancement-styles'
  style.textContent = `
    .ops-enhanced-drawer {
      width: min(460px, calc(100vw - 28px)) !important;
      max-height: min(88dvh, 760px) !important;
      overflow: auto !important;
      border-radius: 26px !important;
      border: 1px solid rgba(17,24,39,.10) !important;
      box-shadow: 0 28px 90px rgba(0,0,0,.28) !important;
      background: #fff !important;
      scrollbar-width: thin;
      scrollbar-color: rgba(17,24,39,.22) transparent;
    }
    .ops-enhanced-drawer::-webkit-scrollbar { width: 7px; }
    .ops-enhanced-drawer::-webkit-scrollbar-thumb { background: rgba(17,24,39,.18); border-radius: 99px; }
    .ops-enhanced-drawer input,
    .ops-enhanced-drawer textarea,
    .ops-enhanced-drawer select {
      min-height: 44px !important;
      border-radius: 13px !important;
      border: 1px solid #d9dde5 !important;
      background: #fbfbfc !important;
      transition: border-color .16s ease, box-shadow .16s ease, background .16s ease !important;
    }
    .ops-enhanced-drawer textarea { min-height: 96px !important; resize: vertical !important; }
    .ops-enhanced-drawer input:focus,
    .ops-enhanced-drawer textarea:focus,
    .ops-enhanced-drawer select:focus {
      outline: none !important;
      border-color: #f2aa00 !important;
      background: #fff !important;
      box-shadow: 0 0 0 4px rgba(242,170,0,.14) !important;
    }
    .ops-enhanced-drawer label {
      color: #171717 !important;
      font-weight: 700 !important;
      letter-spacing: -.01em;
    }
    .ops-enhanced-drawer button[type="submit"],
    .ops-enhanced-drawer .ops-primary-action {
      min-height: 48px !important;
      border-radius: 14px !important;
      box-shadow: 0 8px 20px rgba(242,170,0,.22) !important;
      font-weight: 800 !important;
    }
    .ops-drawer-kicker {
      display: flex;
      gap: 10px;
      align-items: flex-start;
      padding: 12px 14px;
      margin: 8px 0 16px;
      border-radius: 16px;
      background: linear-gradient(135deg, rgba(242,170,0,.14), rgba(242,170,0,.04));
      border: 1px solid rgba(242,170,0,.22);
      color: #5f4300;
      font-size: 12px;
      line-height: 1.45;
    }
    .ops-drawer-kicker svg { flex: 0 0 auto; margin-top: 1px; color: #d59300; }
    .ops-photo-panel {
      margin: 2px 0 16px;
      padding: 14px;
      border-radius: 18px;
      border: 1px dashed #cfd4dc;
      background: linear-gradient(180deg, #fcfcfd, #f7f8fa);
    }
    .ops-photo-heading {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      margin-bottom: 10px;
    }
    .ops-photo-title {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 13px;
      font-weight: 850;
      color: #171717;
    }
    .ops-photo-count {
      padding: 4px 8px;
      border-radius: 999px;
      background: #eceff3;
      color: #5a6472;
      font-size: 11px;
      font-weight: 800;
    }
    .ops-photo-help { margin: 0 0 12px; color: #6c7480; font-size: 12px; line-height: 1.45; }
    .ops-photo-actions { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
    .ops-photo-action {
      min-height: 42px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 7px;
      border: 1px solid #d8dde5;
      border-radius: 12px;
      background: #fff;
      color: #242830;
      font-size: 12px;
      font-weight: 800;
      cursor: pointer;
    }
    .ops-photo-action:hover { border-color: #f2aa00; background: #fffbef; }
    .ops-photo-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; margin-top: 10px; }
    .ops-photo-item { position: relative; aspect-ratio: 1; border-radius: 12px; overflow: hidden; border: 1px solid #dfe3e8; background: #eef0f3; }
    .ops-photo-item img { width: 100%; height: 100%; object-fit: cover; display: block; }
    .ops-photo-remove {
      position: absolute;
      top: 5px;
      right: 5px;
      width: 25px;
      height: 25px;
      padding: 0;
      display: grid;
      place-items: center;
      border: 0;
      border-radius: 999px;
      background: rgba(20,20,20,.75);
      color: #fff;
      cursor: pointer;
    }
    .ops-photo-status { display: none; align-items: center; gap: 8px; margin-top: 10px; color: #5f4300; font-size: 12px; font-weight: 750; }
    .ops-photo-status.is-visible { display: flex; }
    .ops-photo-spinner { width: 14px; height: 14px; border: 2px solid rgba(242,170,0,.28); border-top-color: #d59300; border-radius: 50%; animation: ops-spin .8s linear infinite; }
    @keyframes ops-spin { to { transform: rotate(360deg); } }
    .ops-field-help { display: block; margin-top: 5px; color: #7a828d; font-size: 11px; line-height: 1.35; font-weight: 500; }
    .ops-inventory-drawer .ops-inventory-grid { display: grid !important; grid-template-columns: 1fr 1fr !important; gap: 12px !important; }
    .ops-inventory-drawer .ops-span-full { grid-column: 1 / -1 !important; }
    @media (max-width: 520px) {
      .ops-enhanced-drawer { width: calc(100vw - 18px) !important; max-height: 91dvh !important; border-radius: 24px !important; }
      .ops-photo-grid { grid-template-columns: repeat(3, 1fr); }
      .ops-inventory-drawer .ops-inventory-grid { grid-template-columns: 1fr !important; }
      .ops-inventory-drawer .ops-span-full { grid-column: auto !important; }
    }
  `
  document.head.appendChild(style)
}

function isVisible(el) {
  if (!(el instanceof HTMLElement)) return false
  const style = window.getComputedStyle(el)
  const rect = el.getBoundingClientRect()
  return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 180 && rect.height > 80
}

function headingCandidates() {
  return Array.from(document.querySelectorAll('h1,h2,h3,h4,strong,[role="heading"]')).filter(isVisible)
}

function findFormContainer(heading) {
  let node = heading
  for (let i = 0; i < 9 && node; i += 1, node = node.parentElement) {
    if (!(node instanceof HTMLElement)) continue
    const fields = node.querySelectorAll('input,textarea,select')
    const buttons = node.querySelectorAll('button')
    const rect = node.getBoundingClientRect()
    if (fields.length >= 2 && buttons.length >= 1 && rect.width >= 280 && rect.width <= 760) return node
  }
  return null
}

function findSubmitButton(container, terms) {
  return Array.from(container.querySelectorAll('button')).find((button) => {
    const text = String(button.textContent || '').trim().toLowerCase()
    return terms.some((term) => text.includes(term))
  }) || null
}

function addKicker(container, heading, type) {
  if (container.querySelector('.ops-drawer-kicker')) return
  const kicker = document.createElement('div')
  kicker.className = 'ops-drawer-kicker'
  if (type === 'issue') {
    kicker.innerHTML = `${svgIcon('alert', 17)}<div><strong>Report the problem clearly.</strong><br>Add the affected area, what happened, urgency, and photo evidence when it helps the manager act faster.</div>`
  } else {
    kicker.innerHTML = `${svgIcon('box', 17)}<div><strong>Create one clean inventory item.</strong><br>Use a clear item name, correct counting unit, and a practical minimum level for stock alerts.</div>`
  }
  heading.insertAdjacentElement('afterend', kicker)
}

function fileKey(file) {
  return `${file.name}:${file.size}:${file.lastModified}`
}

function createPhotoPanel(container, submitButton) {
  let panel = container.querySelector('.ops-photo-panel')
  if (panel) return panel

  panel = document.createElement('section')
  panel.className = 'ops-photo-panel'
  panel.innerHTML = `
    <div class="ops-photo-heading">
      <div class="ops-photo-title">${svgIcon('camera')}<span>Photo evidence</span></div>
      <span class="ops-photo-count">0/${MAX_ISSUE_PHOTOS}</span>
    </div>
    <p class="ops-photo-help">Take a current photo of the affected equipment, stock, hygiene area, or damage. Up to ${MAX_ISSUE_PHOTOS} photos.</p>
    <div class="ops-photo-actions">
      <button class="ops-photo-action ops-take-photo" type="button">${svgIcon('camera', 16)} Take photo</button>
      <button class="ops-photo-action ops-choose-photo" type="button">${svgIcon('image', 16)} Choose photos</button>
    </div>
    <input class="ops-camera-input" type="file" accept="image/*" capture="environment" hidden>
    <input class="ops-gallery-input" type="file" accept="image/*" multiple hidden>
    <div class="ops-photo-grid"></div>
    <div class="ops-photo-status"><span class="ops-photo-spinner"></span><span>Uploading photo evidence…</span></div>
  `

  submitButton.insertAdjacentElement('beforebegin', panel)
  const cameraInput = panel.querySelector('.ops-camera-input')
  const galleryInput = panel.querySelector('.ops-gallery-input')
  panel.querySelector('.ops-take-photo').addEventListener('click', () => cameraInput.click())
  panel.querySelector('.ops-choose-photo').addEventListener('click', () => galleryInput.click())
  cameraInput.addEventListener('change', () => addIssueFiles(Array.from(cameraInput.files || []), panel))
  galleryInput.addEventListener('change', () => addIssueFiles(Array.from(galleryInput.files || []), panel))
  renderPhotoPanel(panel)
  return panel
}

function addIssueFiles(files, panel) {
  const existing = new Set(state.issueFiles.map((entry) => entry.key))
  for (const file of files) {
    if (state.issueFiles.length >= MAX_ISSUE_PHOTOS) break
    if (!file.type.startsWith('image/')) continue
    if (file.size > MAX_FILE_BYTES) {
      window.alert(`${file.name} is larger than 8 MB.`)
      continue
    }
    const key = fileKey(file)
    if (existing.has(key)) continue
    state.issueFiles.push({ key, file, previewUrl: URL.createObjectURL(file) })
    existing.add(key)
  }
  renderPhotoPanel(panel)
}

function removeIssueFile(key, panel) {
  const entry = state.issueFiles.find((item) => item.key === key)
  if (entry?.previewUrl) URL.revokeObjectURL(entry.previewUrl)
  state.issueFiles = state.issueFiles.filter((item) => item.key !== key)
  renderPhotoPanel(panel)
}

function renderPhotoPanel(panel) {
  const count = panel.querySelector('.ops-photo-count')
  const grid = panel.querySelector('.ops-photo-grid')
  if (count) count.textContent = `${state.issueFiles.length}/${MAX_ISSUE_PHOTOS}`
  if (!grid) return
  grid.replaceChildren()
  state.issueFiles.forEach((entry) => {
    const item = document.createElement('div')
    item.className = 'ops-photo-item'
    const img = document.createElement('img')
    img.src = entry.previewUrl
    img.alt = entry.file.name
    const remove = document.createElement('button')
    remove.className = 'ops-photo-remove'
    remove.type = 'button'
    remove.setAttribute('aria-label', `Remove ${entry.file.name}`)
    remove.innerHTML = svgIcon('trash', 13)
    remove.addEventListener('click', () => removeIssueFile(entry.key, panel))
    item.append(img, remove)
    grid.appendChild(item)
  })
}

function setPhotoUploading(dialog, uploading, message = 'Uploading photo evidence…') {
  const status = dialog?.querySelector('.ops-photo-status')
  const submit = dialog ? findSubmitButton(dialog, ['report issue']) : null
  if (status) {
    status.classList.toggle('is-visible', uploading)
    const text = status.querySelector('span:last-child')
    if (text) text.textContent = message
  }
  if (submit) {
    submit.disabled = uploading
    submit.style.opacity = uploading ? '.7' : ''
  }
}

async function uploadIssuePhotos() {
  if (!state.issueFiles.length) return []
  if (!state.issueDialog) throw new Error('Issue drawer is no longer open')
  setPhotoUploading(state.issueDialog, true)
  try {
    const results = []
    for (let i = 0; i < state.issueFiles.length; i += 1) {
      const entry = state.issueFiles[i]
      setPhotoUploading(state.issueDialog, true, `Uploading photo ${i + 1} of ${state.issueFiles.length}…`)
      const form = new FormData()
      form.append('file', entry.file)
      form.append('folderType', 'UrgentIssues')
      form.append('outletName', 'RR-KCH')
      const response = await state.nativeFetch(`${API_BASE_URL}/api/files/upload`, {
        method: 'POST',
        credentials: 'include',
        body: form,
      })
      const contentType = response.headers.get('content-type') || ''
      const data = contentType.includes('application/json') ? await response.json() : { error: await response.text() }
      if (!response.ok) throw new Error(data?.error || data?.message || `Photo upload failed (${response.status})`)
      results.push({
        drive_file_id: data.drive_file_id || '',
        file_name: data.file_name || entry.file.name,
        file_url: data.file_url || '',
      })
    }
    return results
  } finally {
    setPhotoUploading(state.issueDialog, false)
  }
}

function appendIssuePhotoPayload(existing, photos) {
  if (!photos.length) return existing || ''
  const payload = JSON.stringify({ version: 1, photos })
  const base = String(existing || '').replace(new RegExp(`\\n?${ISSUE_MARKER}.*$`, 's'), '').trim()
  return `${base}${base ? '\n\n' : ''}${ISSUE_MARKER}${payload}`
}

function clearIssuePhotos() {
  state.issueFiles.forEach((entry) => entry.previewUrl && URL.revokeObjectURL(entry.previewUrl))
  state.issueFiles = []
  const panel = state.issueDialog?.querySelector('.ops-photo-panel')
  if (panel) renderPhotoPanel(panel)
}

function installFetchInterceptor() {
  if (window.__OPS_ISSUE_PHOTO_FETCH_INSTALLED__) return
  window.__OPS_ISSUE_PHOTO_FETCH_INSTALLED__ = true
  window.fetch = async function opsDrawerFetch(input, init = {}) {
    const url = typeof input === 'string' ? input : String(input?.url || '')
    const method = String(init?.method || (input instanceof Request ? input.method : 'GET')).toUpperCase()
    const isIssueCreate = method === 'POST' && /\/api\/entities\/UrgentIssue(?:\?|$)/.test(url)
    if (!isIssueCreate || state.issueFiles.length === 0) return state.nativeFetch(input, init)

    try {
      const photos = await uploadIssuePhotos()
      const nextInit = { ...init }
      let body = {}
      if (typeof init.body === 'string' && init.body) body = JSON.parse(init.body)
      body.followup_notes = appendIssuePhotoPayload(body.followup_notes, photos)
      nextInit.body = JSON.stringify(body)
      const response = await state.nativeFetch(input, nextInit)
      if (response.ok) clearIssuePhotos()
      return response
    } catch (error) {
      setPhotoUploading(state.issueDialog, false)
      window.alert(error?.message || 'Unable to upload issue photos.')
      throw error
    }
  }
}

function enhanceIssueDrawer(heading, container) {
  if (container.dataset.opsIssueEnhanced === 'true') return
  container.dataset.opsIssueEnhanced = 'true'
  container.classList.add('ops-enhanced-drawer', 'ops-issue-drawer')
  state.issueDialog = container
  addKicker(container, heading, 'issue')
  const submit = findSubmitButton(container, ['report issue'])
  if (submit) {
    submit.classList.add('ops-primary-action')
    createPhotoPanel(container, submit)
  }
}

function labelText(label) {
  return String(label?.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase()
}

function addHelp(label, text) {
  if (!label || label.querySelector('.ops-field-help')) return
  const help = document.createElement('span')
  help.className = 'ops-field-help'
  help.textContent = text
  label.appendChild(help)
}

function enhanceInventoryDrawer(heading, container) {
  if (container.dataset.opsInventoryEnhanced === 'true') return
  container.dataset.opsInventoryEnhanced = 'true'
  container.classList.add('ops-enhanced-drawer', 'ops-inventory-drawer')
  addKicker(container, heading, 'inventory')

  const labels = Array.from(container.querySelectorAll('label')).filter((label) => label.querySelector('input,select,textarea'))
  if (labels.length >= 3) {
    const parentCounts = new Map()
    labels.forEach((label) => {
      const parent = label.parentElement
      if (parent) parentCounts.set(parent, (parentCounts.get(parent) || 0) + 1)
    })
    const grid = Array.from(parentCounts.entries()).sort((a, b) => b[1] - a[1])[0]?.[0]
    if (grid) grid.classList.add('ops-inventory-grid')
  }

  labels.forEach((label) => {
    const text = labelText(label)
    if (/item name|name/.test(text) && !/category/.test(text)) {
      label.classList.add('ops-span-full')
      addHelp(label, 'Use the name staff see during stock count, for example “Cooking Oil 5L”.')
    } else if (/description|notes/.test(text)) {
      label.classList.add('ops-span-full')
    } else if (/unit|uom/.test(text)) {
      addHelp(label, 'Choose the unit staff actually count: pack, bottle, carton, piece, kg, or litre.')
    } else if (/minimum|reorder|par level/.test(text)) {
      addHelp(label, 'The item is flagged when counted stock reaches this level or lower.')
    } else if (/category|group/.test(text)) {
      addHelp(label, 'Used for filtering and inventory reports.')
    }
  })

  const submit = findSubmitButton(container, ['add item', 'create item', 'save item', 'add inventory', 'create inventory'])
  if (submit) submit.classList.add('ops-primary-action')
}

function scanDrawers() {
  for (const heading of headingCandidates()) {
    const text = String(heading.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase()
    const container = findFormContainer(heading)
    if (!container) continue
    if (text.includes('report urgent issue')) {
      enhanceIssueDrawer(heading, container)
      continue
    }
    const inventoryTitle = text.includes('inventory') || text.includes('stock item')
    const stockRoute = /\/(stock|inventory)(?:\/|$)/.test(window.location.pathname)
    if ((inventoryTitle || stockRoute) && /add|create|new/.test(text)) enhanceInventoryDrawer(heading, container)
  }

  if (state.issueDialog && !document.body.contains(state.issueDialog)) {
    state.issueDialog = null
    clearIssuePhotos()
  }
}

function install() {
  if (state.installed) return
  state.installed = true
  installStyles()
  installFetchInterceptor()
  scanDrawers()
  const observer = new MutationObserver(() => window.requestAnimationFrame(scanDrawers))
  observer.observe(document.documentElement, { childList: true, subtree: true })
  window.addEventListener('hashchange', () => window.requestAnimationFrame(scanDrawers))
  window.addEventListener('popstate', () => window.requestAnimationFrame(scanDrawers))
}

install()
