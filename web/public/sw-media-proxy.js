function chefOpsDriveFileId(value = '') {
  const text = String(value || '')
  const patterns = [
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

self.addEventListener('fetch', (event) => {
  const request = event.request
  if (request.method !== 'GET') return

  const url = new URL(request.url)
  if (!chefOpsIsDriveMedia(url)) return

  const fileId = chefOpsDriveFileId(request.url)
  if (!fileId) return

  event.respondWith(fetch(`/api/files/${encodeURIComponent(fileId)}`, {
    credentials: 'include',
    cache: 'no-store',
    headers: { 'X-ChefOps-Media-Proxy': 'service-worker' },
  }))
})
