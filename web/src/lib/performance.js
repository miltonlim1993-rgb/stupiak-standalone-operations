function text(value) {
  return String(value || '').trim()
}

function lower(value) {
  return text(value).toLowerCase()
}

function positiveNumber(value, fallback = 0) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : fallback
}

function normalizePerson(value) {
  return lower(value).replace(/[^a-z0-9]+/g, '')
}

export function taskTemplateMap(templates = []) {
  return new Map((templates || []).map((row) => [text(row.id), row]))
}

export function taskScoreConfig(task, templateLookup = new Map()) {
  const template = templateLookup.get(text(task?.template_id)) || {}
  return {
    points: positiveNumber(task?.marks, positiveNumber(template.marks, 1)),
    penalty: positiveNumber(task?.penalty, positiveNumber(template.penalty, 1)),
  }
}

export function taskIsDone(task) {
  return lower(task?.status) === 'done'
}

export function taskIsMissed(task, asOfDate) {
  const dueDate = text(task?.due_date)
  if (!dueDate || taskIsDone(task)) return false
  return dueDate < text(asOfDate)
}

function userMaps(users = []) {
  const byId = new Map()
  const byEmail = new Map()
  const byName = new Map()
  for (const user of users || []) {
    if (user.id) byId.set(text(user.id), user)
    if (user.email) byEmail.set(lower(user.email), user)
    if (user.full_name) byName.set(normalizePerson(user.full_name), user)
  }
  return { byId, byEmail, byName }
}

function userIdentity(task, users) {
  const { byId, byEmail, byName } = users
  const completedEmail = lower(task?.completed_by_email)
  const assignedId = text(task?.assigned_to_user_id)
  const assignedName = normalizePerson(task?.assigned_to_name)
  const completedName = normalizePerson(task?.completed_by_name)
  const matched = (completedEmail && byEmail.get(completedEmail))
    || (assignedId && byId.get(assignedId))
    || (completedName && byName.get(completedName))
    || (assignedName && byName.get(assignedName))
  if (matched) return {
    key: text(matched.id || matched.email || matched.full_name),
    name: matched.full_name || matched.email || 'Staff',
    email: matched.email || '',
  }
  const name = task?.completed_by_name || task?.assigned_to_name || task?.completed_by_email || 'Unassigned / outlet'
  return {
    key: lower(task?.completed_by_email) || normalizePerson(name) || 'unassigned',
    name,
    email: task?.completed_by_email || '',
  }
}

function outletMap(outlets = []) {
  return new Map((outlets || []).map((row) => [text(row.id), row.name || row.code || row.id]))
}

function summaryRecord(key, name) {
  return {
    key,
    name,
    scheduled: 0,
    completed: 0,
    missed: 0,
    open: 0,
    points: 0,
    penalties: 0,
    net_score: 0,
    completion_rate: 0,
  }
}

function finalize(record) {
  const due = record.completed + record.missed
  record.net_score = Number((record.points - record.penalties).toFixed(2))
  record.completion_rate = due ? Math.round((record.completed / due) * 100) : 0
  return record
}

export function buildTaskPerformance({ tasks = [], templates = [], users = [], outlets = [], asOfDate = '' } = {}) {
  const templateLookup = taskTemplateMap(templates)
  const people = userMaps(users)
  const outletNames = outletMap(outlets)
  const byOutlet = new Map()
  const byPerson = new Map()
  const byDate = new Map()

  for (const task of tasks || []) {
    const outletId = text(task.outlet_id) || 'unassigned'
    const outlet = byOutlet.get(outletId) || summaryRecord(outletId, outletNames.get(outletId) || outletId)
    const personInfo = userIdentity(task, people)
    const person = byPerson.get(personInfo.key) || { ...summaryRecord(personInfo.key, personInfo.name), email: personInfo.email }
    const date = text(task.due_date) || 'undated'
    const daily = byDate.get(date) || { date, scheduled: 0, completed: 0, missed: 0, points: 0, penalties: 0, net_score: 0, completion_rate: 0 }
    const score = taskScoreConfig(task, templateLookup)
    const done = taskIsDone(task)
    const missed = taskIsMissed(task, asOfDate)

    for (const record of [outlet, person, daily]) record.scheduled += 1
    if (done) {
      for (const record of [outlet, person, daily]) {
        record.completed += 1
        record.points += score.points
      }
    } else if (missed) {
      for (const record of [outlet, person, daily]) {
        record.missed += 1
        record.penalties += score.penalty
      }
    } else {
      outlet.open += 1
      person.open += 1
      daily.open = Number(daily.open || 0) + 1
    }

    byOutlet.set(outletId, outlet)
    byPerson.set(personInfo.key, person)
    byDate.set(date, daily)
  }

  const outletRows = [...byOutlet.values()].map(finalize).sort((a, b) => b.net_score - a.net_score || b.completion_rate - a.completion_rate)
  const personRows = [...byPerson.values()].map(finalize).sort((a, b) => b.net_score - a.net_score || b.completion_rate - a.completion_rate)
  const dailyRows = [...byDate.values()].filter((row) => row.date !== 'undated').sort((a, b) => a.date.localeCompare(b.date)).map(finalize)
  const total = finalize(outletRows.reduce((sum, row) => ({
    ...sum,
    scheduled: sum.scheduled + row.scheduled,
    completed: sum.completed + row.completed,
    missed: sum.missed + row.missed,
    open: sum.open + row.open,
    points: sum.points + row.points,
    penalties: sum.penalties + row.penalties,
  }), summaryRecord('all', 'All outlets')))

  return { total, outlets: outletRows, people: personRows, daily: dailyRows }
}

export function minutesBetween(start, end) {
  const startMs = Date.parse(start || '')
  const endMs = Date.parse(end || '')
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) return ''
  return Math.max(0, Math.round((endMs - startMs) / 60000))
}
