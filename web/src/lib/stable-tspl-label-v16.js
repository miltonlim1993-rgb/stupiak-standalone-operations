const CRLF = '\r\n'

export const STABLE_TSPL_LABEL_VERSION = '4.6.20-stable-tspl-core-v16-date-fit-v22'

function cleanHtmlText(value = '') {
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

function classBodies(html, className) {
  const escaped = String(className || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const pattern = new RegExp(
    `<([a-z0-9]+)\\b[^>]*class=["'](?:[^"']*\\s)?${escaped}(?:\\s[^"']*)?["'][^>]*>([\\s\\S]*?)<\\/\\1>`,
    'gi',
  )
  return [...String(html || '').matchAll(pattern)].map((match) => match[2] || '')
}

function classBody(html, className) {
  return classBodies(html, className)[0] || ''
}

function classText(html, className) {
  return cleanHtmlText(classBody(html, className))
}

function normalizePrinterPunctuation(value = '') {
  return String(value || '')
    .replace(/[•·]/g, '-')
    .replace(/[–—]/g, '-')
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
}

function printerText(value = '', maximum = 120) {
  return cleanHtmlText(normalizePrinterPunctuation(value))
    .replace(/[^\x20-\x7E]/g, '?')
    .replace(/["\\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maximum)
}

function contextValues(html) {
  const body = classBody(html, 'context')
  return [...body.matchAll(/<span(?:\s+[^>]*)?>([\s\S]*?)<\/span>/gi)]
    .map((match) => cleanHtmlText(match[1]))
    .filter((value) => value && value !== '•' && value !== '-')
}

function timeValues(html) {
  const values = []
  const pattern = /<div\s+class=["'][^"']*\btime-head\b[^"']*["'][^>]*>[\s\S]*?<span>([\s\S]*?)<\/span>\s*(?:<strong>([\s\S]*?)<\/strong>)?\s*<\/div>\s*<div\s+class=["'][^"']*\btime-date\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/gi
  for (const match of String(html || '').matchAll(pattern)) {
    values.push({
      label: cleanHtmlText(match[1]),
      time: cleanHtmlText(match[2]),
      date: cleanHtmlText(match[3]),
    })
  }
  return values
}

function testTimeValues(html) {
  const boxes = classBodies(html, 'box').map(cleanHtmlText)
  return boxes.slice(0, 2).map((value, index) => {
    const label = /^USE\s*BY\b/i.test(value) || index === 1 ? 'USE BY' : 'MADE'
    const withoutLabel = value.replace(/^\s*(?:MADE|USE\s*BY)\s*/i, '')
    const time = withoutLabel.match(/\b\d{1,2}:\d{2}\b/)?.[0] || ''
    const date = withoutLabel.replace(time, '').trim()
    return { label, time, date }
  })
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

function formatMm(value) {
  const number = Number(value)
  return Number.isInteger(number) ? String(number) : number.toFixed(1)
}

const FONT = {
  1: { name: '1', charWidth: 8, lineHeight: 13 },
  2: { name: '2', charWidth: 12, lineHeight: 20 },
  3: { name: '3', charWidth: 16, lineHeight: 24 },
}

function splitText(value, maxChars, maxLines = 2) {
  const text = printerText(value, Math.max(1, maxChars * maxLines * 2))
  if (!text) return []
  const words = text.split(' ')
  const lines = []
  let current = ''
  for (const word of words) {
    const remaining = word
    if (!remaining) continue
    const candidate = current ? `${current} ${remaining}` : remaining
    if (candidate.length <= maxChars) {
      current = candidate
      continue
    }
    if (current) lines.push(current)
    current = remaining.slice(0, maxChars)
    if (lines.length >= maxLines - 1) break
  }
  if (current && lines.length < maxLines) lines.push(current)
  if (!lines.length) lines.push(text.slice(0, maxChars))
  const joined = lines.join(' ')
  if (joined.length < text.length && lines.length) {
    const last = lines.length - 1
    lines[last] = `${lines[last].slice(0, Math.max(1, maxChars - 3)).trimEnd()}...`
  }
  return lines.slice(0, maxLines)
}

function textCommand(x, y, font, value, rotation = 0, xMultiplier = 1, yMultiplier = 1) {
  return `TEXT ${Math.round(x)},${Math.round(y)},"${font}",${rotation},${xMultiplier},${yMultiplier},"${printerText(value)}"`
}

function boxCommand(x1, y1, x2, y2, thickness = 1) {
  return `BOX ${Math.round(x1)},${Math.round(y1)},${Math.round(x2)},${Math.round(y2)},${Math.max(1, Math.round(thickness))}`
}

function barcodeCommand(x, y, value, height) {
  return `BARCODE ${Math.round(x)},${Math.round(y)},"128",${Math.round(height)},0,0,2,2,"${printerText(value, 48)}"`
}

function centeredX(text, widthDots, charWidth, minimum = 8) {
  return Math.max(minimum, Math.round((widthDots - (printerText(text).length * charWidth)) / 2))
}

function fittedDateCommand(boxLeft, boxRight, y, value) {
  const date = printerText(value)
  const charWidth = FONT[1].charWidth
  const safePadding = 2
  const textWidth = date.length * charWidth
  const innerLeft = boxLeft + safePadding
  const innerRight = boxRight - safePadding
  const centered = Math.round((boxLeft + boxRight - textWidth) / 2)
  const x = Math.max(innerLeft, Math.min(centered, innerRight - textWidth))
  return textCommand(x, y, '1', date, 0, 1, 2)
}

function stableError(message, code, details = {}) {
  const error = new Error(message)
  error.code = code
  error.details = details
  return error
}

export function countStableLabelCopies(html) {
  return Math.max(1, Math.min(100, (String(html || '').match(/class=["'][^"']*\blabel\b[^"']*["']/gi) || []).length || 1))
}

export function extractStableLabelJob(html) {
  const source = String(html || '')
  const title = classText(source, 'title')
  if (!title) return null

  const contexts = contextValues(source)
  const foodTimes = timeValues(source)
  const barcode = classText(source, 'barcode')
  const batch = classText(source, 'batch').replace(/^BATCH\s*/i, '')
  const quantity = classText(source, 'quantity')
  const operator = classText(source, 'operator')

  if (source.includes('time-box') && foodTimes.length >= 2) {
    return {
      kind: 'food',
      title,
      action: contexts[0] || 'LABEL',
      storage: contexts[1] || '',
      made: foodTimes[0],
      useBy: foodTimes[1],
      quantity,
      operator,
      batch,
      barcode: barcode || batch,
    }
  }

  if (/\bTEST LABEL\b/i.test(title) || /Stupiak'?s Ops Test Label/i.test(source)) {
    const times = testTimeValues(source)
    const meta = classText(source, 'meta')
    return {
      kind: 'test',
      title,
      action: meta || 'TSPL TEST',
      storage: '',
      made: times[0] || { label: 'MADE', time: '', date: '' },
      useBy: times[1] || { label: 'USE BY', time: '', date: '' },
      quantity: '',
      operator: '',
      batch: batch || classText(source, 'batch') || 'STUPIAK OPS TEST',
      barcode: '',
    }
  }

  return null
}

function chooseTitleFont(title, availableWidth) {
  for (const size of [3, 2, 1]) {
    const font = FONT[size]
    const maxChars = Math.max(8, Math.floor(availableWidth / font.charWidth))
    if (printerText(title).length <= maxChars * 2 || size === 1) return { font, maxChars }
  }
  return { font: FONT[1], maxChars: Math.max(8, Math.floor(availableWidth / FONT[1].charWidth)) }
}

export function buildStableTsplLabelCommand(html, options = {}) {
  if (String(options.commandLanguage || '').toLowerCase() !== 'tspl') {
    throw stableError('Stable Food Label printing requires a TSPL printer profile.', 'stable_tspl_language_required')
  }

  const job = extractStableLabelJob(html)
  if (!job) {
    throw stableError('This label does not contain a supported Food Label or Test Label record.', 'stable_tspl_label_unrecognized')
  }

  const widthMm = numberValue(options.widthMm, 40, 20, 100)
  const heightMm = numberValue(options.heightMm, 30, 15, 100)
  const dpi = numberValue(options.dpi, 203, 72, 600)
  const copies = Math.round(numberValue(options.copies || countStableLabelCopies(html), 1, 1, 100))
  const widthDots = mmToDots(widthMm, dpi)
  const heightDots = mmToDots(heightMm, dpi)
  const xOffset = offsetMmToDots(numberValue(options.xOffsetMm, 0, -20, 20), dpi)
  const yOffset = offsetMmToDots(numberValue(options.yOffsetMm, 0, -20, 20), dpi)
  const left = Math.max(6, 12 + xOffset)
  const right = Math.min(widthDots - 6, widthDots - 12 + xOffset)
  const top = Math.max(4, 7 + yOffset)
  const bottom = Math.min(heightDots - 4, heightDots - 8 + yOffset)
  const availableWidth = Math.max(80, right - left)
  const { font: titleFont, maxChars } = chooseTitleFont(job.title, availableWidth)
  const titleLines = splitText(job.title, maxChars, 2)
  const warnings = []
  if (titleLines.join(' ').replace(/\.\.\.$/, '').length < printerText(job.title).length) warnings.push('title_truncated')

  const lines = []
  lines.push(`SIZE ${formatMm(widthMm)} mm,${formatMm(heightMm)} mm`)
  if (String(options.mediaSensor || 'gap') === 'black_mark') {
    lines.push(`BLINE ${formatMm(numberValue(options.blackMarkMm, 2, 0.1, 20))} mm,${formatMm(numberValue(options.blackMarkOffsetMm, 0, -20, 20))} mm`)
  } else {
    const gap = String(options.mediaSensor || 'gap') === 'continuous' ? 0 : numberValue(options.gapMm, 2, 0, 20)
    lines.push(`GAP ${formatMm(gap)} mm,${formatMm(numberValue(options.gapOffsetMm, 0, -20, 20))} mm`)
  }
  lines.push('DENSITY 8')
  lines.push('SPEED 4')
  lines.push('DIRECTION 1')
  lines.push('REFERENCE 0,0')
  lines.push('CLS')

  let y = top
  for (const titleLine of titleLines) {
    lines.push(textCommand(left, y, titleFont.name, titleLine))
    y += titleFont.lineHeight
  }

  const context = [job.action, job.storage].filter(Boolean).join(' | ')
  if (context) lines.push(textCommand(left, y + 1, '1', splitText(context, Math.max(10, Math.floor(availableWidth / 8)), 1)[0] || context))
  y += context ? 17 : 4

  const timeTop = y
  const timeHeight = 49
  const timeBottom = timeTop + timeHeight
  const gapDots = 7
  const boxWidth = Math.floor((availableWidth - gapDots) / 2)
  const leftBoxRight = left + boxWidth
  const rightBoxLeft = leftBoxRight + gapDots
  lines.push(boxCommand(left, timeTop, leftBoxRight, timeBottom, 1))
  lines.push(boxCommand(rightBoxLeft, timeTop, right, timeBottom, 1))

  const madeHead = [job.made?.label || 'MADE', job.made?.time].filter(Boolean).join(' ')
  const useHead = [job.useBy?.label || 'USE BY', job.useBy?.time].filter(Boolean).join(' ')
  lines.push(textCommand(left + 4, timeTop + 4, '1', madeHead))
  lines.push(fittedDateCommand(left, leftBoxRight, timeTop + 20, job.made?.date || ''))
  lines.push(textCommand(rightBoxLeft + 4, timeTop + 4, '1', useHead))
  lines.push(fittedDateCommand(rightBoxLeft, right, timeTop + 20, job.useBy?.date || ''))

  const operatorLine = [job.operator, job.quantity].filter(Boolean).join(' | ')
  const operatorY = timeBottom + 5
  if (operatorLine) lines.push(textCommand(left, operatorY, '1', splitText(operatorLine, Math.max(10, Math.floor(availableWidth / 8)), 1)[0] || operatorLine))

  const batchText = job.batch ? (job.kind === 'food' ? `BATCH ${job.batch}` : job.batch) : ''
  const batchY = operatorY + (operatorLine ? 15 : 3)
  if (batchText) lines.push(textCommand(centeredX(batchText, widthDots, 8), batchY, '1', batchText))

  let finalY = batchY + 13
  if (job.barcode) {
    const barcodeY = batchY + 14
    const availableBarcodeHeight = bottom - barcodeY - 15
    if (availableBarcodeHeight < 20) {
      throw stableError(
        `Label content exceeds the ${formatMm(widthMm)} × ${formatMm(heightMm)} mm media. Reduce the title or optional fields before printing.`,
        'stable_tspl_layout_overflow',
        { widthMm, heightMm, widthDots, heightDots, barcodeY, availableBarcodeHeight },
      )
    }
    const barcodeHeight = Math.max(20, Math.min(48, availableBarcodeHeight))
    lines.push(barcodeCommand(Math.max(10, left + 7), barcodeY, job.barcode, barcodeHeight))
    lines.push(textCommand(centeredX(job.barcode, widthDots, 8), barcodeY + barcodeHeight + 2, '1', job.barcode))
    finalY = barcodeY + barcodeHeight + 15
  }

  if (finalY > bottom) {
    throw stableError(
      `Label content exceeds the ${formatMm(widthMm)} × ${formatMm(heightMm)} mm media.`,
      'stable_tspl_layout_overflow',
      { widthMm, heightMm, widthDots, heightDots, finalY, bottom },
    )
  }

  lines.push(`PRINT ${copies},1`)

  return {
    command: `${lines.join(CRLF)}${CRLF}`,
    mode: 'tspl-stable-v16-date-fit-v22',
    version: STABLE_TSPL_LABEL_VERSION,
    job,
    widthMm,
    heightMm,
    dpi,
    copies,
    report: {
      fits: true,
      warnings,
      widthDots,
      heightDots,
      finalY,
      bottom,
      date_boxes_fitted: true,
      date_box_padding_dots: 2,
      date_font: '1x2',
    },
  }
}

export function asciiBase64(value = '') {
  const text = String(value || '')
  if (typeof btoa === 'function') return btoa(text)
  return Buffer.from(text, 'ascii').toString('base64')
}
