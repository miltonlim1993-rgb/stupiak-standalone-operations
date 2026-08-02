const BUNDLED_SOP_MEDIA = {
  '1AEjqI2ObYFy1BMZxnNpM1f6NyQ5vwGIO': '/sop-media/opening-preparation.webp',
  '1QHBKs2c1dWU8Ccoc7p2Jrz6_7Uqmwu0b': '/sop-media/opening-area.webp',
  '1q9Baqt0f1KBpKPeeNf5WTidytnpBc5Dw': '/sop-media/non-busy-cleaning.webp',
  '1oI6JymrFpRhjP1t1nYBJG16sbLCJJgZ7': '/sop-media/closing-kitchen.webp',
  '1_jxnxW-3qx9Mztv1xj_F37AtmpbxpvGN': '/sop-media/closing-front.webp',
  '1jKT007b8OkgYgCpDGIWvVMGOSIdUlLHx': '/sop-media/toilet-closing.webp',
  '1vr6_TVho-49w_bUPEAdrdBYiYPudgvuE': '/sop-media/garbage-bin-wash.webp',
  '1Ong60hAn7jDsBvVexpk4jK3imbac_7zA': '/sop-media/freezer-deep-clean.webp',
}

function driveFileId(value = '') {
  const text = String(value || '')
  const patterns = [
    /\/api\/files\/([A-Za-z0-9_-]{10,})/,
    /\/file\/d\/([A-Za-z0-9_-]{10,})/,
    /[?&]id=([A-Za-z0-9_-]{10,})/,
    /\/thumbnail\?id=([A-Za-z0-9_-]{10,})/,
    /\/uc\?(?:[^#]*&)?id=([A-Za-z0-9_-]{10,})/,
  ]
  for (const pattern of patterns) {
    const match = text.match(pattern)
    if (match?.[1]) return match[1]
  }
  return ''
}

function bundledSource(value) {
  const fileId = driveFileId(value)
  return fileId ? BUNDLED_SOP_MEDIA[fileId] || '' : ''
}

function repairImage(image) {
  if (!(image instanceof HTMLImageElement)) return

  const current = String(image.getAttribute('src') || image.src || '')
  const bundled = bundledSource(current)
  if (bundled && !current.includes(bundled)) {
    image.dataset.chefopsOriginalSrc = current
    image.dataset.chefopsMediaSource = 'cloudflare-bundled-sop'
    image.src = `${bundled}?ui=v13`
    image.loading = 'eager'
    image.decoding = 'async'
  }

  const alt = String(image.alt || '').toLowerCase()
  if (alt.includes('task evidence')) {
    image.style.objectFit = 'contain'
    image.style.background = 'hsl(var(--muted))'
    image.style.padding = '0.25rem'
  }
}

function repairRoot(root) {
  if (!root) return
  if (root instanceof HTMLImageElement) repairImage(root)
  root.querySelectorAll?.('img').forEach(repairImage)
}

export function installMediaUiRepair() {
  if (window.__chefopsMediaUiRepairInstalled) return
  window.__chefopsMediaUiRepairInstalled = true

  const start = () => {
    repairRoot(document.documentElement)
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.type === 'attributes') repairImage(mutation.target)
        mutation.addedNodes.forEach((node) => {
          if (node instanceof Element) repairRoot(node)
        })
      }
    })
    observer.observe(document.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['src'],
    })
    window.addEventListener('pageshow', () => repairRoot(document.documentElement))
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') repairRoot(document.documentElement)
    })
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true })
  else start()
}
