import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

const read = (path) => fs.readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8')

test('routes Tasks, Training and SOP chapters to the restored responsive interfaces', () => {
  const app = read('web/src/App.jsx')
  assert.ok(app.includes("import('@/pages/OperationalTasksV2')"))
  assert.ok(app.includes("import('@/pages/TrainingHubV29')"))
  assert.ok(app.includes("import('@/pages/GuidedSopLearning')"))
  assert.ok(app.includes('<Route path="/tasks" element={<Tasks />} />'))
  assert.ok(app.includes('<Route path="/training" element={<TrainingHub />} />'))
  assert.ok(app.includes('<Route path="/training/manage" element={<TrainingManage />} />'))
  assert.ok(app.includes('<Route path="/sop/:sopId" element={<GuidedSop />} />'))
})

test('Task API wrapper passes routing context and the legacy app', () => {
  const entry = read('worker/src/entry-v3.js')
  assert.ok(entry.includes('handleTaskWorkflowV5(request, env, url, context, app)'))
})

test('restored Task UI is the simple daily workflow with SOP links', () => {
  const source = read('web/src/pages/OperationalTasksV2.jsx')
  assert.ok(source.includes('今日任务'))
  assert.ok(source.includes('operationalBootstrap'))
  assert.ok(source.includes('openSop'))
})

test('Training landing uses the compact Ops-aligned responsive hub', () => {
  const source = read('web/src/pages/TrainingHubV29.jsx')
  assert.ok(source.includes('data-training-hub="ops-compact-v29"'))
  assert.ok(source.includes('bg-slate-50'))
  assert.ok(source.includes('border-slate-200'))
  assert.ok(source.includes('md:grid-cols-2 xl:grid-cols-3'))
  assert.ok(source.includes('完整的品牌化逐步学习界面'))
  assert.ok(source.includes("navigate('/training/manage')"))
  assert.ok(!source.includes('bg-[#f4efe3]'))
  assert.ok(!source.includes('border-2 border-black'))
  assert.ok(!source.includes('shadow-[4px_4px_0_#111]'))
})

test('restored SOP reader uses the agreed Stupiak poster standard responsively', () => {
  const source = read('web/src/pages/GuidedSopLearning.jsx')
  assert.ok(source.includes('data-sop-standard="stupiaks-poster-v1"'))
  assert.ok(source.includes('#f7b500'))
  assert.ok(source.includes('md:grid-cols-[220px_minmax(0,1fr)]'))
  assert.ok(source.includes('fixed inset-x-0 bottom-0'))
})

test('Task, Training and SOP routes are forced fresh by the production shell', () => {
  const sw = read('web/public/sw.js')
  const entry = read('worker/src/entry-v3.js')
  assert.ok(sw.includes("'/training'"))
  assert.ok(sw.includes("url.pathname.startsWith('/sop/')"))
  assert.ok(entry.includes("'/training'"))
  assert.ok(entry.includes("url.pathname.startsWith('/sop/')"))
})
