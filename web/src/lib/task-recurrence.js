import { opsClient } from '@/api/opsClient'

const DAY_CODES = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA']

let installed = false
let originalOperationalBootstrap = null

function csv(value = '') {
  return String(value || '')
    .split(',')
    .map((item) => item.trim().toUpperCase())
    .filter(Boolean)
}

function recurrenceParts(value = '') {
  return Object.fromEntries(
    String(value || '')
      .split(';')
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const index = part.indexOf('=')
        return index < 0
          ? ['FREQ', part.toUpperCase()]
          : [part.slice(0, index).toUpperCase(), part.slice(index + 1).toUpperCase()]
      }),
  )
}

function validDate(dateText) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateText || ''))) return null
  const date = new Date(`${dateText}T00:00:00Z`)
  return Number.isNaN(date.getTime()) ? null : date
}

function weekdayMatches(parts, date) {
  const dayCode = DAY_CODES[date.getUTCDay()]
  const allowed = csv(parts.BYDAY).map((entry) => entry.replace(/^[+-]?\d+/, ''))
  return !allowed.length || allowed.includes(dayCode)
}

function monthlyPositionMatches(parts, date) {
  const positions = csv(parts.BYSETPOS)
    .map(Number)
    .filter((value) => Number.isInteger(value) && value !== 0)
  if (!positions.length) {
    const ordinalPositions = csv(parts.BYDAY)
      .map((entry) => Number(entry.match(/^([+-]?\d+)/)?.[1]))
      .filter((value) => Number.isInteger(value) && value !== 0)
    positions.push(...ordinalPositions)
  }
  if (!positions.length) return true

  const day = date.getUTCDate()
  const positivePosition = Math.floor((day - 1) / 7) + 1
  const daysInMonth = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate()
  const negativePosition = -(Math.floor((daysInMonth - day) / 7) + 1)
  return positions.includes(positivePosition) || positions.includes(negativePosition)
}

function configRecurrenceMatches(task, date) {
  const recurrence = task?.config?.recurrence || {}
  const frequency = String(recurrence.frequency || '').toUpperCase()
  if (!frequency) return true
  if (recurrence.effective_from && String(task?.due_date || '') < String(recurrence.effective_from)) return false
  if (frequency === 'DAILY') return true

  const weekday = String(recurrence.weekday || '').toUpperCase()
  if (weekday && weekday !== DAY_CODES[date.getUTCDay()]) return false

  if (frequency === 'MONTHLY_NTH_WEEKDAY') {
    const expected = Number(recurrence.week_of_month)
    return Number.isInteger(expected) && expected !== 0
      ? monthlyPositionMatches({ BYSETPOS: String(expected) }, date)
      : true
  }
  if (frequency === 'MONTHLY_LAST_WEEKDAY') {
    return monthlyPositionMatches({ BYSETPOS: '-1' }, date)
  }
  if (frequency === 'MONTHLY') {
    const days = Array.isArray(recurrence.bymonthday) ? recurrence.bymonthday.map(Number) : []
    return !days.length || days.includes(date.getUTCDate())
  }
  return true
}

export function taskOccursOnDate(task = {}, dateText = '') {
  const date = validDate(dateText)
  if (!date) return false

  const parts = recurrenceParts(task.recurrence_rule)
  const frequency = parts.FREQ || ''
  if (!frequency) return configRecurrenceMatches(task, date)
  if (frequency === 'DAILY') return configRecurrenceMatches(task, date)
  if (frequency === 'WEEKLY') {
    return weekdayMatches(parts, date) && configRecurrenceMatches(task, date)
  }
  if (frequency === 'MONTHLY') {
    const monthDays = csv(parts.BYMONTHDAY).map(Number).filter(Number.isFinite)
    if (monthDays.length && !monthDays.includes(date.getUTCDate())) return false
    if (!weekdayMatches(parts, date)) return false
    if (!monthlyPositionMatches(parts, date)) return false
    if (!monthDays.length && !parts.BYDAY && !parts.BYSETPOS && date.getUTCDate() !== 1) return false
    return configRecurrenceMatches(task, date)
  }
  return configRecurrenceMatches(task, date)
}

export function filterOperationalTaskData(data = {}, dateText = '') {
  const tasks = (data.tasks || []).filter((task) => taskOccursOnDate(task, dateText))
  const taskIds = new Set(tasks.map((task) => String(task.id || '')))
  const templateIds = new Set(tasks.map((task) => String(task.template_id || '')).filter(Boolean))
  return {
    ...data,
    tasks,
    task_photos: (data.task_photos || []).filter((photo) => taskIds.has(String(photo.task_id || ''))),
    template_photos: (data.template_photos || []).filter((photo) => templateIds.has(String(photo.template_id || ''))),
    recurrence_filter: {
      mode: 'MONTHLY_BYDAY_BYSETPOS',
      date: dateText,
      visible_task_count: tasks.length,
    },
  }
}

export function configureTaskRecurrenceFilter() {
  if (installed) return
  originalOperationalBootstrap = opsClient.tasks.operationalBootstrap.bind(opsClient.tasks)
  opsClient.tasks.operationalBootstrap = async (args = {}) => {
    const data = await originalOperationalBootstrap(args)
    return filterOperationalTaskData(data, String(args.date || ''))
  }
  installed = true
}
