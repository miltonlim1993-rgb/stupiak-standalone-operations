import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

import { handleNoDeletePolicyV27, NO_DELETE_POLICY_VERSION } from '../src/no-delete-policy-v27.js'

const read = (path) => fs.readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8')

test('Worker rejects every hard-delete request', async () => {
  const response = handleNoDeletePolicyV27(new Request('https://example.test/api/entities/TaskPhoto/photo-1', {
    method: 'DELETE',
  }))
  assert.equal(response.status, 405)
  assert.equal(response.headers.get('allow'), 'GET, POST, PATCH, OPTIONS')
  const body = await response.json()
  assert.equal(body.code, 'hard_delete_disabled')
  assert.equal(body.policy, NO_DELETE_POLICY_VERSION)
})

test('Worker leaves non-delete requests unchanged', () => {
  assert.equal(handleNoDeletePolicyV27(new Request('https://example.test/api/entities/TaskPhoto', {
    method: 'PATCH',
  })), null)
})

test('entry intercepts DELETE before labels, tasks and the legacy app', () => {
  const source = read('worker/src/entry-v3.js')
  const deleteIndex = source.indexOf('handleNoDeletePolicyV27')
  const labelIndex = source.indexOf("url.pathname.startsWith('/api/labels/')")
  const appIndex = source.indexOf('app.fetch(request, env, context)')
  assert.ok(deleteIndex >= 0)
  assert.ok(labelIndex > deleteIndex)
  assert.ok(appIndex > deleteIndex)
  assert.ok(source.includes("Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS'"))
})

test('Web and generated Android shell remove trash and exact delete controls', () => {
  const source = read('web/src/lib/no-delete-ui-v27.js')
  const main = read('web/src/main.jsx')
  assert.ok(source.includes('lucide-trash-2'))
  assert.ok(source.includes('delete photo'))
  assert.ok(source.includes('删除照片'))
  assert.ok(source.includes('MutationObserver'))
  assert.ok(main.includes('installNoDeleteUiV27()'))
  assert.ok(main.includes("noDeletePolicy: 'hard-delete-disabled-v27'"))
})
