const TESSERACT_URL = 'https://cdn.jsdelivr.net/npm/tesseract.js@6.0.1/+esm'
const PDFJS_URL = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@5.4.149/build/pdf.mjs'
const PDF_WORKER_URL = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@5.4.149/build/pdf.worker.min.mjs'
const TESSERACT_WORKER_URL = 'https://cdn.jsdelivr.net/npm/tesseract.js@6.0.1/dist/worker.min.js'
const TESSERACT_CORE_URL = 'https://cdn.jsdelivr.net/npm/tesseract.js-core@6.0.0'
const TESSDATA_URL = 'https://tessdata.projectnaptha.com/4.0.0'

function emit(onProgress, stage, progress, message, extra = {}) { onProgress?.({ stage, progress, message, ...extra }) }
function readable(text) { return (String(text || '').match(/[A-Za-z0-9]/g) || []).length }

async function prepareImage(source) {
  const bitmap = source instanceof ImageBitmap ? source : await createImageBitmap(source)
  const maxSide = 2600
  const scale = Math.min(2, maxSide / Math.max(bitmap.width, bitmap.height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(bitmap.width * scale))
  canvas.height = Math.max(1, Math.round(bitmap.height * scale))
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) throw new Error('Canvas is unavailable in this browser.')
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  const image = ctx.getImageData(0, 0, canvas.width, canvas.height)
  for (let i = 0; i < image.data.length; i += 4) {
    const gray = image.data[i] * .299 + image.data[i + 1] * .587 + image.data[i + 2] * .114
    const value = Math.max(0, Math.min(255, (gray - 128) * 1.42 + 128))
    image.data[i] = value; image.data[i + 1] = value; image.data[i + 2] = value
  }
  ctx.putImageData(image, 0, 0)
  bitmap.close?.()
  return canvas
}

async function tesseractWorker(onProgress) {
  const imported = await import(/* @vite-ignore */ TESSERACT_URL)
  const api = imported?.createWorker
    ? imported
    : imported?.default?.createWorker
      ? imported.default
      : imported?.default && typeof imported.default === 'object'
        ? imported.default
        : null
  const createWorker = api?.createWorker || (typeof imported?.default === 'function' ? imported.default : null)
  if (typeof createWorker !== 'function') {
    throw new Error('The browser OCR engine loaded, but its createWorker API was not exported. Refresh the app and try again.')
  }
  const worker = await createWorker('eng', 1, {
    workerPath: TESSERACT_WORKER_URL,
    corePath: TESSERACT_CORE_URL,
    langPath: TESSDATA_URL,
    logger: (event) => {
      if (typeof event.progress === 'number') emit(onProgress, 'recognizing', event.progress, event.status || 'Recognizing receipt')
    },
  })
  await worker.setParameters({ preserve_interword_spaces: '1' })
  return worker
}

async function imageOcr(file, onProgress) {
  emit(onProgress, 'reading', .03, 'Preparing receipt image')
  const canvas = await prepareImage(file)
  const worker = await tesseractWorker(onProgress)
  try {
    const result = await worker.recognize(canvas)
    return { text: result.data.text.trim(), confidence: Number(result.data.confidence || 0), engine: 'tesseract', pagesProcessed: 1 }
  } finally { await worker.terminate() }
}

async function pdfOcr(file, onProgress) {
  const pdfjs = await import(/* @vite-ignore */ PDFJS_URL)
  pdfjs.GlobalWorkerOptions.workerSrc = PDF_WORKER_URL
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise
  const embedded = []
  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    emit(onProgress, 'extracting-text', pageNumber / pdf.numPages, `Reading PDF page ${pageNumber} of ${pdf.numPages}`)
    const page = await pdf.getPage(pageNumber)
    const content = await page.getTextContent()
    embedded.push(content.items.map((item) => item.str || '').join(' '))
  }
  const embeddedText = embedded.join('\n').trim()
  if (readable(embeddedText) >= 80) { await pdf.destroy(); return { text: embeddedText, confidence: 99, engine: 'pdf-text', pagesProcessed: pdf.numPages } }
  const pages = Math.min(pdf.numPages, 4)
  const worker = await tesseractWorker(onProgress)
  const texts = []; const confidences = []
  try {
    for (let pageNumber = 1; pageNumber <= pages; pageNumber += 1) {
      emit(onProgress, 'rendering', (pageNumber - 1) / pages, `Rendering PDF page ${pageNumber} of ${pages}`)
      const page = await pdf.getPage(pageNumber)
      const viewport = page.getViewport({ scale: 2.25 })
      const canvas = document.createElement('canvas')
      canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height)
      const ctx = canvas.getContext('2d')
      await page.render({ canvasContext: ctx, viewport }).promise
      const prepared = await prepareImage(canvas)
      const result = await worker.recognize(prepared)
      texts.push(result.data.text.trim()); confidences.push(Number(result.data.confidence || 0))
    }
  } finally { await worker.terminate(); await pdf.destroy() }
  return { text: texts.join('\n\n'), confidence: confidences.length ? confidences.reduce((a, b) => a + b, 0) / confidences.length : 0, engine: 'pdf-tesseract', pagesProcessed: pages }
}

export async function recognizeReceipt(file, onProgress) {
  if (!file) throw new Error('Choose a receipt image or PDF.')
  const isPdf = file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')
  const result = isPdf ? await pdfOcr(file, onProgress) : await imageOcr(file, onProgress)
  emit(onProgress, 'complete', 1, 'Receipt OCR complete')
  return { ...result, parsed: parseReceiptText(result.text, result.confidence) }
}

function normalizeText(input) {
  return String(input || '')
    .replace(/\r/g, '\n')
    .replace(/[\t ]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/\b(?:T0TAL|TQTAL|TOTAI)\b/gi, 'TOTAL')
    .replace(/\bAM(?:0|O)UNT\b/gi, 'AMOUNT')
    .replace(/\b(?:RECE1PT|RECEIPT1)\b/gi, 'RECEIPT')
    .replace(/\b(?:1NVO1CE|1NVOICE|INVO1CE|INV0ICE)\b/gi, 'INVOICE')
    .replace(/\bSUPPL(?:1|I)ER\b/gi, 'SUPPLIER')
    .replace(/([A-Za-z])\s*[:|]\s*(?=\S)/g, '$1: ')
    .trim()
}

function clean(value) {
  return String(value || '')
    .replace(/[|]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[\s:;,.-]+|[\s:;,.-]+$/g, '')
    .trim()
}

function cleanMoney(value) {
  return clean(value)
    .replace(/\s+/g, '')
    .replace(/,(?=\d{2}\b)/g, '.')
    .replace(/[^0-9.,-]/g, '')
}

function parseMoney(value) {
  const normalized = cleanMoney(value).replace(/,/g, '')
  if (!/^\d+(?:\.\d{1,2})?$/.test(normalized)) return ''
  const amount = Number(normalized)
  return Number.isFinite(amount) && amount >= 0 && amount < 1_000_000_000 ? amount : ''
}

function isoDate(value) {
  const text = clean(value)
  let match = text.match(/\b(20\d{2})[-/.](\d{1,2})[-/.](\d{1,2})\b/)
  if (match) return `${match[1]}-${String(Number(match[2])).padStart(2, '0')}-${String(Number(match[3])).padStart(2, '0')}`
  match = text.match(/\b(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})\b/)
  if (match) {
    const year = Number(match[3]) < 100 ? 2000 + Number(match[3]) : Number(match[3])
    const day = Number(match[1]); const month = Number(match[2])
    if (day >= 1 && day <= 31 && month >= 1 && month <= 12) return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
  }
  match = text.match(/\b(\d{1,2})\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+(\d{2,4})\b/i)
  if (match) {
    const months = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 }
    const year = Number(match[3]) < 100 ? 2000 + Number(match[3]) : Number(match[3])
    return `${year}-${String(months[match[2].toLowerCase()]).padStart(2, '0')}-${String(Number(match[1])).padStart(2, '0')}`
  }
  return ''
}

function plausibleIdentifier(value) {
  const normalized = clean(value).toUpperCase()
  return normalized.length >= 3 && normalized.length <= 40 && /\d/.test(normalized) && /^[A-Z0-9][A-Z0-9/_().-]*$/.test(normalized)
}

function findReceiptNumber(text, lines) {
  const patterns = [
    /(?:official\s*)?receipt\s*(?:no\.?|number|#|ref(?:erence)?)?\s*[:#-]?\s*([A-Z0-9][A-Z0-9/_().-]{2,39})/i,
    /(?:transaction|reference|ref)\s*(?:no\.?|number|#)?\s*[:#-]?\s*([A-Z0-9][A-Z0-9/_().-]{2,39})/i,
    /(?:invoice|inv)\s*(?:no\.?|number|#)?\s*[:#-]?\s*([A-Z0-9][A-Z0-9/_().-]{2,39})/i,
  ]
  for (const pattern of patterns) {
    const candidate = clean(text.match(pattern)?.[1]).toUpperCase()
    if (plausibleIdentifier(candidate)) return candidate
  }
  for (const line of lines.slice(0, 35)) {
    if (!/\b(?:receipt|transaction|reference|invoice|ref|no\.)\b/i.test(line)) continue
    const tokens = line.match(/[A-Z0-9][A-Z0-9/_().-]{2,39}/gi) || []
    const candidate = tokens.find(plausibleIdentifier)
    if (candidate) return candidate.toUpperCase()
  }
  return ''
}

function findDate(text, lines) {
  for (let index = 0; index < Math.min(lines.length, 50); index += 1) {
    if (!/\b(?:receipt date|transaction date|invoice date|date)\b/i.test(lines[index])) continue
    const result = isoDate(`${lines[index]} ${lines[index + 1] || ''}`)
    if (result) return result
  }
  return isoDate(lines.slice(0, 50).join('\n')) || isoDate(text)
}

function amountsIn(value) {
  return (String(value || '').match(/(?:RM|MYR|[$])?\s*\d{1,3}(?:[ ,]\d{3})*(?:[.,]\d{2})|(?:RM|MYR|[$])?\s*\d+[.,]\d{2}/gi) || [])
    .map(parseMoney)
    .filter((amount) => amount !== '')
}

function findTotal(lines) {
  const priorities = [
    /\b(?:grand\s*total|total\s*paid|amount\s*paid|net\s*total|balance\s*paid)\b/i,
    /\btotal\b/i,
  ]
  for (const keyword of priorities) {
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      if (!keyword.test(lines[index]) || /\b(?:subtotal|sub total|tax total|rounding)\b/i.test(lines[index])) continue
      const candidates = amountsIn(`${lines[index]} ${lines[index + 1] || ''}`)
      if (candidates.length) return candidates[candidates.length - 1]
    }
  }
  const currencyCandidates = amountsIn(lines.slice(-25).filter((line) => /\b(?:RM|MYR)\b/i.test(line)).join(' '))
  return currencyCandidates.length ? Math.max(...currencyCandidates) : ''
}

function stripCompanyLine(value) {
  return clean(value)
    .replace(/^(?:supplier|vendor|company|merchant|store|from)\s*(?:name)?\s*[:#-]?\s*/i, '')
    .replace(/\s+(?:lot|address|tel|telephone|phone|fax|email)\b.*$/i, '')
    .replace(/\s*\((?:\d{5,}[A-Z0-9-]*)\)\s*$/i, '')
}

function plausibleSupplier(value) {
  const normalized = stripCompanyLine(value)
  const letters = (normalized.match(/[A-Za-z]/g) || []).length
  return normalized.length >= 4 && normalized.length <= 100 && letters >= 4 && !/^(?:receipt|invoice|tax invoice|cashier|customer|date|time|total|thank you)$/i.test(normalized)
}

function findSupplier(lines) {
  for (let index = 0; index < Math.min(lines.length, 30); index += 1) {
    if (!/\b(?:supplier|vendor|merchant|company|from)\b/i.test(lines[index])) continue
    const inline = stripCompanyLine(lines[index])
    if (plausibleSupplier(inline)) return inline
    for (let offset = 1; offset <= 3; offset += 1) {
      const next = stripCompanyLine(lines[index + offset] || '')
      if (plausibleSupplier(next)) return next
    }
  }
  const rejected = /receipt|invoice|tax|cashier|date|time|tel|phone|address|sst|gst|thank|welcome|order|table|customer|stupiak/i
  const candidates = lines.slice(0, 22)
    .map(stripCompanyLine)
    .filter((line) => plausibleSupplier(line) && !rejected.test(line))
    .sort((left, right) => {
      const strong = (value) => /\b(?:sdn\.?\s*bhd\.?|berhad|enterprise|trading|company|co\.?|ltd\.?|restaurant|cafe|foods?|mart|store)\b/i.test(value) ? 1 : 0
      return strong(right) - strong(left) || right.length - left.length
    })
  return candidates[0] || ''
}

function paymentMethod(text) {
  if (/visa|mastercard|credit\s*card|debit\s*card|\bcard\b/i.test(text)) return 'card'
  if (/duit\s*now|duitnow|qr\s*payment/i.test(text)) return 'duitnow'
  if (/touch\s*[’'`]?n\s*go|\btng\b/i.test(text)) return 'touch_n_go'
  if (/grabpay/i.test(text)) return 'grabpay'
  if (/foodpanda/i.test(text)) return 'foodpanda'
  if (/grabfood/i.test(text)) return 'grabfood'
  if (/bank\s*transfer|fpx|online\s*transfer/i.test(text)) return 'bank_transfer'
  if (/voucher|coupon/i.test(text)) return 'voucher'
  if (/\bcash\b|cash\s*tendered|change\s*due/i.test(text)) return 'cash'
  return ''
}

function currencyFromText(text) {
  const malaysia = Number(/\bMYR\b/i.test(text)) * 8 + Number(/\bRM\s*\d/i.test(text)) * 8 + Number(/\bRINGGIT\b/i.test(text)) * 7 + Number(/\bSDN\.?\s*BHD\.?\b/i.test(text)) * 4 + Number(/\+?60[\s-]?\d/i.test(text)) * 3
  const scores = [
    ['MYR', malaysia],
    ['SGD', Number(/\bSGD\b|S\$\s*\d/i.test(text)) * 8 + Number(/\bSINGAPORE\b/i.test(text)) * 4],
    ['USD', Number(/\bUSD\b|US\$\s*\d/i.test(text)) * 8],
    ['EUR', Number(/\bEUR\b|€\s*\d/i.test(text)) * 8],
    ['GBP', Number(/\bGBP\b|£\s*\d/i.test(text)) * 8],
  ].sort((a, b) => b[1] - a[1])
  return scores[0][1] > 0 ? scores[0][0] : ''
}

function detectDocumentType(text) {
  if (/official\s*receipt|\breceipt\b/i.test(text)) return 'Receipt'
  if (/tax\s*invoice|commercial\s*invoice|\binvoice\b/i.test(text)) return 'Invoice'
  if (/delivery\s*order|\bd\.?o\.?\s*(?:no|number|#)/i.test(text)) return 'Delivery Order'
  return 'Business Document'
}

export function parseReceiptText(input, confidence = 0) {
  const text = normalizeText(input)
  const lines = text.split('\n').map(clean).filter(Boolean)
  const source = findSupplier(lines)
  const receipt_date = findDate(text, lines)
  const receipt_number = findReceiptNumber(text, lines)
  const amount = findTotal(lines)
  const payment_method = paymentMethod(text)
  const currency = currencyFromText(text)
  const document_type = detectDocumentType(text)
  const warnings = []
  if (document_type !== 'Receipt') warnings.push(`Document looks like ${document_type}; confirm it should be stored as a receipt.`)
  if (!source) warnings.push('Supplier was not detected.')
  if (!receipt_date) warnings.push('Receipt date was not detected.')
  if (!receipt_number) warnings.push('Receipt number was not detected.')
  if (amount === '') warnings.push('Total amount was not detected.')
  if (!payment_method) warnings.push('Payment method was not detected.')
  if (!currency) warnings.push('Currency was not detected.')
  if (confidence < 70) warnings.push('OCR confidence is low. Review every field against the image.')
  return { source, receipt_date, receipt_number, amount, payment_method, currency, document_type, warnings, normalized_text: text }
}
