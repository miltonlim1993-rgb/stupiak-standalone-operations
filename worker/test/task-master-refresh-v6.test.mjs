import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const root = new URL('../../', import.meta.url)

async function source(path) {
  return readFile(new URL(path, root), 'utf8')
}

test('first Task load per outlet forces the latest Master Sheet task pack', async () => {
  const refreshSource = await source('web/src/lib/task-template-refresh-v6.js')
  const mainSource = await source('web/src/main.jsx')

  assert.match(refreshSource, /const REFRESHED_OUTLETS = new Set\(\)/)
  assert.match(refreshSource, /firstLoadForOutlet/)
  assert.match(refreshSource, /refresh:\s*Boolean\(refresh \|\| firstLoadForOutlet\)/)
  assert.match(refreshSource, /REFRESHED_OUTLETS\.add\(outletKey\)/)
  assert.match(mainSource, /installTaskTemplateRefreshV6\(\)/)
  assert.ok(
    mainSource.indexOf('installTaskTemplateRefreshV6()') < mainSource.indexOf('installTaskBilingualShell()'),
    'Master Sheet task refresh must be installed before the bilingual display shell',
  )
})

test('dynamic Task status and time text is bilingual', async () => {
  const bilingualSource = await source('web/src/lib/task-bilingual-shell.js')

  assert.match(bilingualSource, /已完成 \$\{completed\[1\]\}/)
  assert.match(bilingualSource, /Available after/)
  assert.match(bilingualSource, /服务器时间控制 \/ Server-time controlled/)
  assert.match(bilingualSource, /日常营业 \/ Daily Operations/)
  assert.match(bilingualSource, /晚班 \/ Night Shift/)
})
