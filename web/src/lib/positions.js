export const DEFAULT_POSITION_META = [
  { code: 'C', name: 'Cashier', short_name: 'Cashier', pattern: 'coins', color: '#D97706', display_order: 10 },
  { code: 'CA', name: 'Cashier Assistant', short_name: 'Cashier Asst.', pattern: 'counter', color: '#0284C7', display_order: 20 },
  { code: 'DF', name: 'Deep Fryer', short_name: 'Deep Fryer', pattern: 'bubbles', color: '#EA580C', display_order: 30 },
  { code: 'G', name: 'Grill', short_name: 'Grill', pattern: 'grill', color: '#DC2626', display_order: 40 },
  { code: 'E', name: 'Event', short_name: 'Event', pattern: 'burst', color: '#7C3AED', display_order: 50 },
  { code: 'SD', name: 'Special Duty', short_name: 'Special Duty', pattern: 'diagonal', color: '#4F46E5', display_order: 60 },
  { code: 'P', name: 'Packaging', short_name: 'Packaging', pattern: 'boxes', color: '#0F766E', display_order: 70 },
]

const SYNONYMS = {
  CASHIER: 'C', C: 'C',
  CASHIERASSISTANT: 'CA', CA: 'CA',
  DEEPFRYER: 'DF', DEEPFRYERL: 'DF', FRYER: 'DF', DF: 'DF',
  GRILL: 'G', G: 'G',
  EVENT: 'E', E: 'E',
  SPECIALDUTY: 'SD', SD: 'SD',
  PACKAGING: 'P', PACKAGE: 'P', P: 'P',
  OPEN: 'OPEN', OPENING: 'OPEN',
}

export function normalizePositionCode(value) {
  const key = String(value || '').trim().toUpperCase().replace(/[^A-Z0-9]+/g, '')
  return SYNONYMS[key] || String(value || '').trim().toUpperCase()
}

export function positionMap(rows = []) {
  const merged = [...DEFAULT_POSITION_META, ...(rows || [])]
  return new Map(merged.filter((row) => row && row.code).map((row) => {
    const code = normalizePositionCode(row.code)
    return [code, { ...row, code, name: row.name || code, short_name: row.short_name || row.name || code }]
  }))
}

export function positionMeta(code, rows = []) {
  const normalized = normalizePositionCode(code)
  if (normalized === 'OPEN') return { code: 'OPEN', name: 'Opening Duty', short_name: 'Opening', pattern: 'open', color: '#CA8A04' }
  return positionMap(rows).get(normalized) || { code: normalized || '—', name: normalized || 'Scheduled', short_name: normalized || 'Scheduled', pattern: 'plain', color: '#64748B' }
}

export function parseDutySegments(notes = '') {
  const text = String(notes || '')
  const match = text.match(/planned duties:\s*(.*?)(?:\.\s*Scheduled|$)/i)
  if (!match?.[1]) return []
  return match[1].split(';').map((chunk) => {
    const part = chunk.trim()
    const duty = part.match(/^(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})\s+(.+)$/)
    if (!duty) return null
    return { start: duty[1].padStart(5, '0'), end: duty[2].padStart(5, '0'), code: normalizePositionCode(duty[3]) }
  }).filter(Boolean)
}

function localDateTime(dateText, timeText, rollover = false) {
  if (!dateText || !timeText) return null
  const [year, month, day] = String(dateText).slice(0, 10).split('-').map(Number)
  const [hour, minute] = String(timeText).split(':').map(Number)
  if (![year, month, day, hour, minute].every(Number.isFinite)) return null
  const value = new Date(year, month - 1, day + (rollover ? 1 : 0), hour, minute, 0, 0)
  return Number.isNaN(value.getTime()) ? null : value
}

export function attendanceInterval(row) {
  const start = localDateTime(row?.date, row?.clock_in)
  let end = localDateTime(row?.date, row?.clock_out)
  if (start && end && end <= start) end = localDateTime(row?.date, row?.clock_out, true)
  return { start, end }
}

export function positionForMoment(row, moment = new Date()) {
  const segments = parseDutySegments(row?.notes)
  if (!segments.length) return normalizePositionCode(row?.position_code || row?.position || row?.staff_role || '')
  for (const segment of segments) {
    const start = localDateTime(row?.date, segment.start)
    let end = localDateTime(row?.date, segment.end)
    if (start && end && end <= start) end = localDateTime(row?.date, segment.end, true)
    if (start && end && moment >= start && moment < end) return segment.code
  }
  const next = segments.map((segment) => ({ ...segment, time: localDateTime(row?.date, segment.start) })).filter((segment) => segment.time && segment.time >= moment).sort((a, b) => a.time - b.time)[0]
  return next?.code || segments[segments.length - 1]?.code || ''
}

export function upcomingTeam(rows = [], { now = new Date(), hours = 8 } = {}) {
  const until = new Date(now.getTime() + hours * 60 * 60 * 1000)
  return (rows || []).map((row) => {
    const { start, end } = attendanceInterval(row)
    if (!start || !end || end <= now || start > until) return null
    const active = start <= now && end > now
    return { ...row, _start: start, _end: end, _active: active, _position: positionForMoment(row, active ? now : start) }
  }).filter(Boolean).sort((a, b) => Number(b._active) - Number(a._active) || a._start - b._start || String(a.staff_name || '').localeCompare(String(b.staff_name || '')))
}

export function teamTimeLabel(row, now = new Date()) {
  if (row?._active) return `Now · until ${row.clock_out || '—'}`
  return `Starts ${row?.clock_in || '—'}`
}
