import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const taskPath = fileURLToPath(
  new URL('../../web/src/pages/TasksV3.jsx', import.meta.url),
)

const dashboardPath = fileURLToPath(
  new URL('../../web/src/pages/DashboardV3.jsx', import.meta.url),
)

test('Task language selector changes content without translating the system shell', () => {
  const source = readFileSync(taskPath, 'utf8')

  assert.match(source, /chefops\.task\.content-language\.v1/)
  assert.match(source, />Tasks<\/h1>/)
  assert.match(source, /Content: 中\+EN/)
  assert.match(
    source,
    /cn=\{title\.cn\} en=\{title\.en\} mode=\{language\}/,
  )
  assert.match(
    source,
    /cn=\{item\.instruction_cn\}[\s\S]*?mode=\{language\}/,
  )

  assert.doesNotMatch(source, /这个班次没有任务/)
  assert.doesNotMatch(
    source,
    /cn="开始任务" en="Start Task" mode=\{language\}/,
  )
  assert.doesNotMatch(
    source,
    /cn="保存进度" en="Save Progress" mode=\{language\}/,
  )
})

test('Dashboard task summary uses one fixed system language', () => {
  const source = readFileSync(dashboardPath, 'utf8')

  assert.match(source, /Morning Shift/)
  assert.match(source, /Evening Shift/)
  assert.match(source, /Issues \/ Overdue/)
  assert.doesNotMatch(source, /[\u3400-\u9fff]/)
})
