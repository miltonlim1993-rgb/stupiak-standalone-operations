export const NO_DELETE_UI_VERSION = 'hard-delete-disabled-v27'

const EXACT_DELETE_LABELS = new Set([
  'delete',
  'delete item',
  'delete record',
  'delete photo',
  'delete file',
  'remove',
  'remove item',
  'remove record',
  'remove photo',
  'remove file',
  'trash',
  'permanently delete',
  '删除',
  '删除记录',
  '删除照片',
  '删除文件',
  '移除',
  '移除照片',
  '永久删除',
])

const DELETE_STYLE_ID = 'chefops-no-delete-controls-v27'

function normalized(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim().toLowerCase()
}

function installImmediateDeleteStyle() {
  if (document.getElementById(DELETE_STYLE_ID)) return
  const style = document.createElement('style')
  style.id = DELETE_STYLE_ID
  style.textContent = `
    button:has(svg.lucide-trash),
    button:has(svg.lucide-trash-2),
    a:has(svg.lucide-trash),
    a:has(svg.lucide-trash-2),
    [role="button"]:has(svg.lucide-trash),
    [role="button"]:has(svg.lucide-trash-2),
    [data-action="delete"],
    [data-action="trash"],
    [data-command="delete"],
    [data-command="trash"] {
      display: none !important;
      pointer-events: none !important;
    }
  `
  document.head.appendChild(style)
}

function isDeleteIcon(control) {
  return Boolean(control?.querySelector?.(
    'svg.lucide-trash, svg.lucide-trash-2, svg[data-lucide="trash"], svg[data-lucide="trash-2"]',
  ))
}

function isDeleteControl(control) {
  if (!(control instanceof Element)) return false
  if (control.matches('[data-chefops-keep-delete-control="true"]')) return false

  const action = normalized(control.getAttribute('data-action') || control.getAttribute('data-command'))
  const label = normalized([
    control.getAttribute('aria-label'),
    control.getAttribute('title'),
    control.getAttribute('name'),
    control.textContent,
  ].filter(Boolean).join(' '))

  return action === 'delete'
    || action === 'remove'
    || action === 'trash'
    || EXACT_DELETE_LABELS.has(label)
    || isDeleteIcon(control)
}

function removeDeleteControls(root = document) {
  const controls = root instanceof Element && root.matches('button, a, [role="button"]')
    ? [root]
    : [...(root.querySelectorAll?.('button, a, [role="button"]') || [])]

  for (const control of controls) {
    if (!isDeleteControl(control)) continue
    control.setAttribute('aria-hidden', 'true')
    control.remove()
  }
}

export function installNoDeleteUiV27() {
  document.documentElement.dataset.chefopsDeletePolicy = NO_DELETE_UI_VERSION
  window.__chefopsNoDeletePolicy = {
    version: NO_DELETE_UI_VERSION,
    hardDeleteEnabled: false,
  }

  installImmediateDeleteStyle()

  const scan = (root = document) => window.requestAnimationFrame(() => removeDeleteControls(root))
  scan()

  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node instanceof Element) scan(node)
      }
    }
  })
  observer.observe(document.documentElement, { childList: true, subtree: true })

  document.addEventListener('click', (event) => {
    const control = event.target instanceof Element
      ? event.target.closest('button, a, [role="button"]')
      : null
    if (!control || !isDeleteControl(control)) return
    event.preventDefault()
    event.stopImmediatePropagation()
  }, true)

  return () => observer.disconnect()
}
