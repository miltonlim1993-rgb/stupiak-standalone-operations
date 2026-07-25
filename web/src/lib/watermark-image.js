function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const image = new Image()
    image.onload = () => { URL.revokeObjectURL(url); resolve(image) }
    image.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Unable to read the captured photo')) }
    image.src = url
  })
}

function formatCapturedAt(value) {
  const date = value instanceof Date ? value : new Date(value)
  return new Intl.DateTimeFormat('en-MY', {
    timeZone: 'Asia/Kuala_Lumpur',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  }).format(date).replace(',', ' ·') + ' MYT'
}

function canvasBlob(canvas, type = 'image/jpeg', quality = 0.88) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('Unable to prepare the captured photo')), type, quality)
  })
}

export async function watermarkTaskPhoto(file, { capturedAt = new Date() } = {}) {
  if (!String(file?.type || '').startsWith('image/')) throw new Error('Task evidence must be a photo captured on site')
  const image = await loadImage(file)
  const maxDimension = 2048
  const scale = Math.min(1, maxDimension / Math.max(image.naturalWidth || image.width, image.naturalHeight || image.height))
  const width = Math.max(1, Math.round((image.naturalWidth || image.width) * scale))
  const height = Math.max(1, Math.round((image.naturalHeight || image.height) * scale))
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d', { alpha: false })
  if (!ctx) throw new Error('This device cannot prepare the captured photo')
  ctx.drawImage(image, 0, 0, width, height)

  const watermarkText = formatCapturedAt(capturedAt)
  const padding = Math.max(14, Math.round(width * 0.018))
  const fontSize = Math.max(22, Math.round(width * 0.028))
  const smallSize = Math.max(15, Math.round(fontSize * 0.68))
  const barHeight = fontSize + smallSize + padding * 2.2
  const top = height - barHeight
  ctx.fillStyle = 'rgba(0, 0, 0, 0.68)'
  ctx.fillRect(0, top, width, barHeight)
  ctx.textBaseline = 'top'
  ctx.font = `600 ${fontSize}px system-ui, -apple-system, sans-serif`
  ctx.fillStyle = '#ffffff'
  ctx.fillText(watermarkText, padding, top + padding)
  ctx.font = `500 ${smallSize}px system-ui, -apple-system, sans-serif`
  ctx.fillStyle = 'rgba(255,255,255,0.82)'
  ctx.fillText('On-site task evidence', padding, top + padding + fontSize + Math.round(padding * 0.35))

  const blob = await canvasBlob(canvas)
  const base = String(file.name || 'task-photo').replace(/\.[^.]+$/, '')
  const stamped = new File([blob], `${base}-watermarked.jpg`, {
    type: 'image/jpeg',
    lastModified: capturedAt.getTime(),
  })
  return { file: stamped, capturedAt: capturedAt.toISOString(), watermarkText }
}
