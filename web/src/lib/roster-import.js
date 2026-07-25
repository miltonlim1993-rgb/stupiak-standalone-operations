const PDFJS_URL = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@5.4.149/build/pdf.mjs'
const PDF_WORKER_URL = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@5.4.149/build/pdf.worker.min.mjs'

const WEEKDAYS = new Set(['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'])
const ROLE_WORDS = new Set(['STAFF', 'LEADER', 'SUPERVISOR', 'MANAGER'])
const SLOT_BOUNDARIES = ['09:30', '10:00', '11:00', '12:00', '13:00', '14:00', '15:00', '16:00', '17:00', '18:00', '19:00', '20:00', '21:00', '22:00', '23:00', '00:00']

function cleanText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim()
}

function parseRosterDate(value) {
  const compact = cleanText(value).replace(/\s/g, '')
  let match = compact.match(/(\d{1,2})\/(\d{1,2})\/(20\d{2})/)
  if (!match) match = compact.match(/(\d{1,2})\/(\d{2})(20\d{2})/)
  if (!match) return ''
  const day = Number(match[1])
  const month = Number(match[2])
  const year = Number(match[3])
  if (day < 1 || day > 31 || month < 1 || month > 12) return ''
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

function minutes(value) {
  const [hour, minute] = String(value || '').split(':').map(Number)
  return (Number(hour) || 0) * 60 + (Number(minute) || 0)
}

function hoursBetween(start, end) {
  const from = minutes(start)
  let to = minutes(end)
  if (to <= from) to += 24 * 60
  return Math.round(((to - from) / 60) * 100) / 100
}

function groupByLine(items, tolerance = 1.35) {
  const sorted = [...items].sort((a, b) => b.y - a.y || a.x - b.x)
  const lines = []
  for (const item of sorted) {
    let line = lines.find((entry) => Math.abs(entry.y - item.y) <= tolerance)
    if (!line) {
      line = { y: item.y, items: [] }
      lines.push(line)
    }
    line.items.push(item)
    line.y = line.items.reduce((sum, entry) => sum + entry.y, 0) / line.items.length
  }
  lines.forEach((line) => line.items.sort((a, b) => a.x - b.x))
  return lines.sort((a, b) => b.y - a.y)
}

function dayHeader(line) {
  const weekday = line.items.find((item) => WEEKDAYS.has(cleanText(item.text).toUpperCase()))
  if (!weekday) return null
  const date = parseRosterDate(line.items.map((item) => item.text).join(' '))
  return date ? { weekday: cleanText(weekday.text).toUpperCase(), date, y: line.y } : null
}

function dutyCode(value) {
  const text = cleanText(value).toUpperCase().replace(/[^A-Z]/g, '')
  if (!text) return ''
  if (text === 'SPECIAL' || text === 'DUTY' || text === 'SPECIALDUTY' || text === 'SD') return 'SD'
  if (text === 'OPEN') return 'OPEN'
  if (text === 'CA') return 'CA'
  if (text === 'C') return 'C'
  if (text === 'P') return 'P'
  if (text === 'G') return 'G'
  if (text === 'DF' || text === 'DEEPFRYER') return 'DF'
  if (text === 'E' || text === 'EVENT') return 'E'
  return cleanText(value).toUpperCase()
}

function slotRangeForItem(item, pageWidth) {
  const gridStart = pageWidth * 0.19
  const gridEnd = pageWidth * 0.992
  const slotWidth = (gridEnd - gridStart) / 15
  const x0 = item.x
  const x1 = item.x + Math.max(item.width || 0, 0.8)
  const slots = []
  for (let index = 0; index < 15; index += 1) {
    const center = gridStart + slotWidth * (index + 0.5)
    if (center >= x0 - 0.45 && center <= x1 + 0.45) slots.push(index)
  }
  if (!slots.length) {
    const center = (x0 + x1) / 2
    const nearest = Math.max(0, Math.min(14, Math.round((center - gridStart) / slotWidth - 0.5)))
    slots.push(nearest)
  }
  return slots
}

function mergeDutyTokens(tokens) {
  const result = []
  for (let index = 0; index < tokens.length; index += 1) {
    const current = tokens[index]
    const next = tokens[index + 1]
    if (dutyCode(current.text) === 'SPECIAL DUTY' && next && dutyCode(next.text) === 'SPECIAL DUTY') {
      result.push({ ...current, text: 'SPECIAL DUTY', width: (next.x + next.width) - current.x })
      index += 1
    } else {
      result.push(current)
    }
  }
  return result
}

function rowFromLine(line, pageWidth, date, sourceFileName) {
  const roleItem = line.items.find((item) => ROLE_WORDS.has(cleanText(item.text).toUpperCase()))
  if (!roleItem) return null
  const name = cleanText(line.items.filter((item) => item.x < roleItem.x - 0.2).map((item) => item.text).join(' '))
  if (!name || /EMPLOYEE|POSITION/i.test(name)) return null
  const dutyTokens = mergeDutyTokens(line.items.filter((item) => item.x > roleItem.x + Math.max(roleItem.width, 1) + 0.5))
  const slots = new Map()
  for (const item of dutyTokens) {
    const code = dutyCode(item.text)
    if (!code) continue
    for (const slot of slotRangeForItem(item, pageWidth)) slots.set(slot, code)
  }
  const occupied = [...slots.keys()].sort((a, b) => a - b)
  if (!occupied.length) return null
  const first = occupied[0]
  const last = occupied[occupied.length - 1]
  const groups = []
  let groupStart = first
  let previous = first
  let code = slots.get(first)
  for (const slot of occupied.slice(1)) {
    const nextCode = slots.get(slot)
    if (slot !== previous + 1 || nextCode !== code) {
      groups.push({ start: groupStart, end: previous, code })
      groupStart = slot
      code = nextCode
    }
    previous = slot
  }
  groups.push({ start: groupStart, end: previous, code })
  const dutySummary = groups.map((group) => `${SLOT_BOUNDARIES[group.start]}-${SLOT_BOUNDARIES[group.end + 1]} ${group.code}`).join('; ')
  const clockIn = SLOT_BOUNDARIES[first]
  const clockOut = SLOT_BOUNDARIES[last + 1]
  return {
    staff_name: name,
    staff_role: cleanText(roleItem.text).toLowerCase(),
    date,
    clock_in: clockIn,
    clock_out: clockOut,
    hours_worked: hoursBetween(clockIn, clockOut),
    notes: `Planned duties: ${dutySummary}. Scheduled shift imported from ${sourceFileName || 'weekly roster PDF'}.`,
    duty_summary: dutySummary,
  }
}

function dateDiffDays(a, b) {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000)
}

export async function parseDutyRosterPdf(file, onProgress) {
  if (!file) throw new Error('Choose a weekly duty roster PDF.')
  if (!(file.type === 'application/pdf' || String(file.name || '').toLowerCase().endsWith('.pdf'))) {
    throw new Error('Duty roster import currently accepts PDF files only.')
  }
  onProgress?.({ progress: 0.05, message: 'Opening roster PDF' })
  const pdfjs = await import(/* @vite-ignore */ PDFJS_URL)
  pdfjs.GlobalWorkerOptions.workerSrc = PDF_WORKER_URL
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise
  const rows = []
  const warnings = []
  try {
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      onProgress?.({ progress: pageNumber / (pdf.numPages + 1), message: `Reading page ${pageNumber} of ${pdf.numPages}` })
      const page = await pdf.getPage(pageNumber)
      const viewport = page.getViewport({ scale: 1 })
      const content = await page.getTextContent()
      const items = (content.items || []).filter((item) => cleanText(item.str)).map((item) => ({
        text: cleanText(item.str),
        x: Number(item.transform?.[4] || 0),
        y: Number(item.transform?.[5] || 0),
        width: Number(item.width || 0),
      }))
      if (!items.length) throw new Error('This roster PDF has no searchable text. Export it from the roster system instead of using a screenshot PDF.')
      const lines = groupByLine(items)
      const headers = lines.map(dayHeader).filter(Boolean)
      for (let index = 0; index < headers.length; index += 1) {
        const header = headers[index]
        const nextHeader = headers[index + 1]
        const sectionLines = lines.filter((line) => line.y < header.y - 0.7 && (!nextHeader || line.y > nextHeader.y + 0.7))
        for (const line of sectionLines) {
          const row = rowFromLine(line, viewport.width, header.date, file.name)
          if (row) rows.push(row)
        }
      }
    }
  } finally {
    await pdf.destroy()
  }
  if (!rows.length) throw new Error('No employee shifts could be read from this roster layout.')
  const dates = [...new Set(rows.map((row) => row.date))].sort()
  for (let index = 1; index < dates.length; index += 1) {
    if (dateDiffDays(dates[index - 1], dates[index]) !== 1) {
      warnings.push(`Roster dates are not continuous between ${dates[index - 1]} and ${dates[index]}. Review the preview before importing.`)
    }
  }
  if (dates.length !== 7) warnings.push(`This PDF contains ${dates.length} roster date${dates.length === 1 ? '' : 's'}, not exactly 7.`)
  const duplicateKeys = new Set()
  const uniqueRows = []
  for (const row of rows) {
    const key = `${row.date}|${row.staff_name.toLowerCase()}|${row.clock_in}|${row.clock_out}`
    if (duplicateKeys.has(key)) continue
    duplicateKeys.add(key)
    uniqueRows.push(row)
  }
  uniqueRows.sort((a, b) => a.date.localeCompare(b.date) || minutes(a.clock_in) - minutes(b.clock_in) || a.staff_name.localeCompare(b.staff_name))
  onProgress?.({ progress: 1, message: 'Roster ready for review' })
  return { rows: uniqueRows, dates, warnings, page_count: pdf.numPages }
}
