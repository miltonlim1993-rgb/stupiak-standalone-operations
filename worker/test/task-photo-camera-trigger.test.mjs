import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const taskPath = fileURLToPath(
  new URL('../../web/src/pages/TasksV3.jsx', import.meta.url),
)

test('each checklist photo button opens its matching camera input', () => {
  const source = readFileSync(taskPath, 'utf8')

  assert.match(
    source,
    /onOpenCamera=\{\(\) => inputs\.current\[type\]\?\.click\(\)\}/,
  )

  assert.match(
    source,
    /function PhotoGroup\(\{[\s\S]*?onOpenCamera,[\s\S]*?\}\)/,
  )

  assert.match(source, /onClick=\{onOpenCamera\}/)
  assert.match(source, /capture="environment"/)
  assert.match(source, /accept="image\/\*"/)
  assert.doesNotMatch(source, /function inputsClick/)
})
