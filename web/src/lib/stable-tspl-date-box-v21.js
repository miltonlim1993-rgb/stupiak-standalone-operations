const CRLF = '\r\n'

export const STABLE_TSPL_DATE_BOX_VERSION = '4.6.19-stable-tspl-date-box-v21'

function printerText(value = '') {
  return String(value ?? '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[^\x20-\x7E]/g, '?')
    .replace(/["\\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 40)
}

function parseBox(line = '') {
  const match = String(line).match(/^BOX\s+(-?\d+),(-?\d+),(-?\d+),(-?\d+),(\d+)$/)
  if (!match) return null
  return {
    x1: Number(match[1]),
    y1: Number(match[2]),
    x2: Number(match[3]),
    y2: Number(match[4]),
  }
}

function fittedDateCommand(box, value) {
  const date = printerText(value)
  const charWidth = 8
  const safePadding = 2
  const textWidth = date.length * charWidth
  const innerLeft = box.x1 + safePadding
  const innerRight = box.x2 - safePadding
  const centered = Math.round((box.x1 + box.x2 - textWidth) / 2)
  const x = Math.max(innerLeft, Math.min(centered, innerRight - textWidth))
  const y = box.y1 + 20
  return `TEXT ${x},${y},"1",0,1,2,"${date}"`
}

export function fitStableTsplDateBoxes(result = {}) {
  const command = String(result.command || '')
  const job = result.job || {}
  const dates = [job.made?.date, job.useBy?.date].map(printerText)
  if (!command || dates.some((value) => !value)) return result

  const lines = command.split(CRLF)
  const boxes = lines.map(parseBox).filter(Boolean).slice(0, 2)
  if (boxes.length !== 2) return result

  const used = new Set()
  const fitted = []
  dates.forEach((date, boxIndex) => {
    const index = lines.findIndex((line, lineIndex) => (
      !used.has(lineIndex)
      && line.includes(',"2",0,1,1,"')
      && line.endsWith(`,"${date}"`)
    ))
    if (index < 0) return
    used.add(index)
    lines[index] = fittedDateCommand(boxes[boxIndex], date)
    fitted.push({ box: boxIndex === 0 ? 'made' : 'use_by', date, command: lines[index] })
  })

  if (fitted.length !== 2) return result
  return {
    ...result,
    command: `${lines.filter((line, index) => line || index < lines.length - 1).join(CRLF)}${CRLF}`,
    mode: 'tspl-stable-v16-date-fit-v21',
    version: STABLE_TSPL_DATE_BOX_VERSION,
    report: {
      ...(result.report || {}),
      date_boxes_fitted: true,
      date_box_padding_dots: 2,
      date_font: '1x2',
      fitted_dates: fitted,
    },
  }
}
