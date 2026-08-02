const CHEFOPS_BUNDLED_SOP_MEDIA = {
  '1AEjqI2ObYFy1BMZxnNpM1f6NyQ5vwGIO': '/sop-media/opening-preparation.webp',
  '1QHBKs2c1dWU8Ccoc7p2Jrz6_7Uqmwu0b': '/sop-media/opening-area.webp',
  '1q9Baqt0f1KBpKPeeNf5WTidytnpBc5Dw': '/sop-media/non-busy-cleaning.webp',
  '1oI6JymrFpRhjP1t1nYBJG16sbLCJJgZ7': '/sop-media/closing-kitchen.webp',
  '1_jxnxW-3qx9Mztv1xj_F37AtmpbxpvGN': '/sop-media/closing-front.webp',
  '1jKT007b8OkgYgCpDGIWvVMGOSIdUlLHx': '/sop-media/toilet-closing.webp',
  '1vr6_TVho-49w_bUPEAdrdBYiYPudgvuE': '/sop-media/garbage-bin-wash.webp',
  '1Ong60hAn7jDsBvVexpk4jK3imbac_7zA': '/sop-media/freezer-deep-clean.webp',
}

function chefOpsDriveFileId(value = '') {
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

function chefOpsIsDriveMedia(url) {
  return url.hostname === 'drive.google.com'
    || url.hostname === 'docs.google.com'
    || url.hostname === 'lh3.googleusercontent.com'
    || url.hostname.endsWith('.googleusercontent.com')
}

async function chefOpsBundledOrProxy(request, fileId) {
  const bundledPath = CHEFOPS_BUNDLED_SOP_MEDIA[fileId]
  if (bundledPath) {
    const bundled = await fetch(new Request(new URL(bundledPath, self.location.origin), {
      method: 'GET',
      credentials: 'same-origin',
      cache: 'force-cache',
    })).catch(() => null)
    if (bundled?.ok && String(bundled.headers.get('content-type') || '').startsWith('image/')) {
      return bundled
    }
  }

  if (new URL(request.url).origin === self.location.origin) {
    return fetch(request)
  }

  return fetch(`/api/files/${encodeURIComponent(fileId)}`, {
    credentials: 'include',
    cache: 'no-store',
    headers: { 'X-ChefOps-Media-Proxy': 'service-worker-v12' },
  })
}

self.addEventListener('fetch', (event) => {
  const request = event.request
  if (request.method !== 'GET') return

  const url = new URL(request.url)
  const fileId = chefOpsDriveFileId(request.url)
  const isSameOriginFile = url.origin === self.location.origin && url.pathname.startsWith('/api/files/')
  if (!fileId || (!isSameOriginFile && !chefOpsIsDriveMedia(url))) return

  event.stopImmediatePropagation()
  event.respondWith(chefOpsBundledOrProxy(request, fileId))
})
