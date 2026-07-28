const CRLF = '\r\n'

function cleanText(value = '') {
  return String(value ?? '')
    .replace(/<br\s*\/?\s*>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim()
}

function classBody(html, className) {
  const pattern = /<([a-z0-9]+)\b[^>]*class=["']([^"']*)["'][^>]*>([\s\S]*?)<\/\1>/gi
  for (const match of String(html || '').matchAll(pattern)) {
    const classes = String(match[2] || '').split(/\s+/).filter(Boolean)
    if (classes.includes(className)) return match[3] || ''
  }
  return ''
}

function classText(html, className) {
  return cleanText(classBody(html, className))
}

function contextValues(html) {
  const body = /<div\s+class=["'][^"']*\bcontext\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/i.exec(String(html || ''))?.[1] || ''
  return [...body.matchAll(/<span(?:\s+[^>]*)?>([\s\S]*?)<\/span>/gi)]
    .map((match) => cleanText(match[1]))
    .filter((value) => value && value !== '•')
}

function timeValues(html) {
  const result = []
  const pattern = /<div\s+class=["'][^"']*\btime-head\b[^"']*["'][^>]*>[\s\S]*?<span>([\s\S]*?)<\/span>\s*(?:<strong>([\s\S]*?)<\/strong>)?\s*<\/div>\s*<div\s+class=["'][^"']*\btime-date\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/gi
  for (const match of String(html || '').matchAll(pattern)) {
    result.push({
      label: cleanText(match[1]),
      time: cleanText(match[2]),
      date: cleanText(match[3]),
    })
  }
  return result
}

function normalizePrinterPunctuation(value = '') {
  return String(value || '')
    .replace(/[•·]/g, '-')
    .replace(/[–—]/g, '-')
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
}

function tsplText(value = '', maximum = 96) {
  return cleanText(normalizePrinterPunctuation(value))
    .replace(/[^\x20-\x7E]/g, '?')
    .replace(/["\\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maximum)
}

function isPrinterAscii(value = '') {
  return !/[^\x20-\x7E]/.test(normalizePrinterPunctuation(value))
}

function numberValue(value, fallback, minimum, maximum) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.max(minimum, Math.min(maximum, number))
}

function mmToDots(mm, dpi) {
  return Math.max(1, Math.round((Number(mm) / 25.4) * Number(dpi)))
}

function offsetMmToDots(mm, dpi) {
  return Math.round((Number(mm) / 25.4) * Number(dpi))
}

function splitTitle(value, maxChars, maxLines = 2) {
  const text = tsplText(value, maxChars * maxLines)
  if (!text) return []
  if (text.length <= maxChars) return [text]

  const words = text.split(' ')
  const lines = []
  let current = ''
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word
    if (candidate.length <= maxChars) {
      current = candidate
      continue
    }
    if (current) lines.push(current)
    current = word.slice(0, maxChars)
    if (lines.length >= maxLines - 1) break
  }
  if (current && lines.length < maxLines) lines.push(current)
  if (!lines.length) {
    for (let index = 0; index < maxLines; index += 1) {
      const part = text.slice(index * maxChars, (index + 1) * maxChars)
      if (part) lines.push(part)
    }
  }
  return lines.slice(0, maxLines)
}

function textCommand(x, y, font, value, rotation = 0, xMultiplier = 1, yMultiplier = 1) {
  return `TEXT ${Math.round(x)},${Math.round(y)},"${font}",${rotation},${xMultiplier},${yMultiplier},"${tsplText(value)}"`
}

function boxCommand(x1, y1, x2, y2, thickness = 1) {
  return `BOX ${Math.round(x1)},${Math.round(y1)},${Math.round(x2)},${Math.round(y2)},${Math.max(1, Math.round(thickness))}`
}

function barcodeCommand(x, y, value, height) {
  return `BARCODE ${Math.round(x)},${Math.round(y)},"128",${Math.round(height)},0,0,2,2,"${tsplText(value, 48)}"`
}

function centeredX(text, widthDots, charWidth, minimum = 8) {
  return Math.max(minimum, Math.round((widthDots - (String(text || '').length * charWidth)) / 2))
}

export function extractFoodLabelForTspl(html) {
  const source = String(html || '')
  if (!source.includes('barcode-wrap') || !source.includes('time-box')) return null

  const contexts = contextValues(source)
  const times = timeValues(source)
  const title = classText(source, 'title')
  const action = contexts[0] || 'LABEL'
  const storage = contexts[1] || ''
  const operator = classText(source, 'operator')
  const quantity = classText(source, 'quantity')
  const batch = classText(source, 'batch').replace(/^BATCH\s*/i, '')
  const barcode = classText(source, 'barcode') || batch

  if (!title || !barcode || times.length < 2) return null

  const printerFontValues = [title, action, storage, batch, barcode, ...times.flatMap((item) => [item.label, item.time, item.date])]
  if (!printerFontValues.every(isPrinterAscii)) return null

  return {
    title,
    action,
    storage,
    made: times[0],
    useBy: times[1],
    quantity,
    operator,
    batch,
    barcode,
  }
}

export function buildTsplFoodLabelCommand(html, options = {}) {
  const label = extractFoodLabelForTspl(html)
  if (!label) return null
  if (String(options.commandLanguage || '').toLowerCase() !== 'tspl') return null

  const widthMm = numberValue(options.widthMm, 40, 20, 100)
  const heightMm = numberValue(options.heightMm, 30, 15, 100)
  const dpi = numberValue(options.dpi, 203, 72, 600)
  const copies = Math.round(numberValue(options.copies, 1, 1, 100))
  const widthDots = mmToDots(widthMm, dpi)
  const heightDots = mmToDots(heightMm, dpi)
  const xOffset = offsetMmToDots(numberValue(options.xOffsetMm, 0, -20, 20), dpi)
  const yOffset = offsetMmToDots(numberValue(options.yOffsetMm, 0, -20, 20), dpi)
  const left = Math.max(6, 12 + xOffset)
  const right = Math.min(widthDots - 6, widthDots - 12 + xOffset)
  const top = Math.max(4, 7 + yOffset)
  const availableWidth = Math.max(120, right - left)

  let font = '3'
  let charWidth = 16
  let lineHeight = 24
  let maxChars = Math.max(12, Math.floor(availableWidth / charWidth))
  if (label.title.length > maxChars * 2) {
    font = '2'
    charWidth = 12
    lineHeight = 20
    maxChars = Math.max(18, Math.floor(availableWidth / charWidth))
  }
  if (label.title.length > maxChars * 2) {
    font = '1'
    charWidth = 8
    lineHeight = 13
    maxChars = Math.max(24, Math.floor(availableWidth / charWidth))
  }

  const titleLines = splitTitle(label.title, maxChars, 2)
  const lines = []
  lines.push(`SIZE ${widthMm.toFixed(1)} mm,${heightMm.toFixed(1)} mm`)
  if (String(options.mediaSensor || 'gap') === 'black_mark') {
    lines.push(`BLINE ${numberValue(options.blackMarkMm, 2, 0.1, 20).toFixed(1)} mm,${numberValue(options.blackMarkOffsetMm, 0, -20, 20).toFixed(1)} mm`)
  } else {
    const gap = String(options.mediaSensor || 'gap') === 'continuous' ? 0 : numberValue(options.gapMm, 2, 0, 20)
    lines.push(`GAP ${gap.toFixed(1)} mm,${numberValue(options.gapOffsetMm, 0, -20, 20).toFixed(1)} mm`)
  }
  // Match the proven old SP Label Printing defaults for this printer.
  lines.push('DENSITY 8')
  lines.push('SPEED 4')
  lines.push('DIRECTION 1')
  lines.push('REFERENCE 0,0')
  lines.push('CLS')

  let y = top
  for (const titleLine of titleLines) {
    lines.push(textCommand(left, y, font, titleLine))
    y += lineHeight
  }

  const context = [label.action, label.storage].filter(Boolean).join(' | ')
  lines.push(textCommand(left, y + 1, '1', context))
  y += 17

  const timeTop = y
  const timeBottom = Math.min(heightDots - 92, timeTop + 49)
  const gapDots = 7
  const boxWidth = Math.floor((availableWidth - gapDots) / 2)
  const leftBoxRight = left + boxWidth
  const rightBoxLeft = leftBoxRight + gapDots
  lines.push(boxCommand(left, timeTop, leftBoxRight, timeBottom, 1))
  lines.push(boxCommand(rightBoxLeft, timeTop, right, timeBottom, 1))

  const madeHead = [label.made.label || 'MADE', label.made.time].filter(Boolean).join(' ')
  const useHead = [label.useBy.label || 'USE BY', label.useBy.time].filter(Boolean).join(' ')
  lines.push(textCommand(left + 4, timeTop + 4, '1', madeHead))
  lines.push(textCommand(left + 4, timeTop + 22, '2', label.made.date))
  lines.push(textCommand(rightBoxLeft + 4, timeTop + 4, '1', useHead))
  lines.push(textCommand(rightBoxLeft + 4, timeTop + 22, '2', label.useBy.date))

  const operatorLine = [label.operator, label.quantity].filter(Boolean).join(' | ')
  const operatorY = timeBottom + 5
  if (operatorLine) lines.push(textCommand(left, operatorY, '1', operatorLine))

  const batchText = label.batch ? `BATCH ${label.batch}` : ''
  const batchY = operatorY + 15
  if (batchText) lines.push(textCommand(centeredX(batchText, widthDots, 8), batchY, '1', batchText))

  const barcodeY = batchY + 14
  const barcodeHeight = Math.max(28, Math.min(48, heightDots - barcodeY - 18))
  lines.push(barcodeCommand(Math.max(10, left + 7), barcodeY, label.barcode, barcodeHeight))
  lines.push(textCommand(centeredX(label.barcode, widthDots, 8), barcodeY + barcodeHeight + 2, '1', label.barcode))
  lines.push(`PRINT 1,${copies}`)

  return {
    command: `${lines.join(CRLF)}${CRLF}`,
    mode: 'tspl-native-food-label',
    label,
    widthMm,
    heightMm,
    copies,
  }
}

export function asciiBase64(value = '') {
  const text = String(value || '')
  if (typeof btoa === 'function') return btoa(text)
  return Buffer.from(text, 'ascii').toString('base64')
}
