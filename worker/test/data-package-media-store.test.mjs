import assert from 'node:assert/strict'
import test from 'node:test'

import {
  getPublishedMedia,
  normalizePublishedMedia,
  publishedMediaManifest,
  savePublishedMedia,
} from '../src/data-package-media-store.js'

function fakeEnv() {
  const values = new Map()
  return {
    APP_DATA_PACKS: {
      async get(key, type) {
        if (!values.has(key)) return null
        const value = values.get(key)
        return type === 'json' ? JSON.parse(value) : value
      },
      async put(key, value) {
        values.set(key, String(value))
      },
    },
  }
}

const HASH = 'a'.repeat(64)

test('normalizes Drive media into an immutable hash URL', () => {
  const media = normalizePublishedMedia({
    hash: HASH,
    bytes: 2048,
    mime_type: 'video/mp4',
    file_name: 'training.mp4',
    published_drive_file_id: 'published-drive-file-1',
    source_key: 'drive:source-file-1',
  })

  assert.equal(media.id, HASH)
  assert.equal(media.source_provider, 'published_google_drive')
  assert.equal(media.source_id, 'published-drive-file-1')
  assert.equal(media.path, `/api/app/v4/data-package/media/${HASH}?hash=${HASH}`)
})

test('stores and retrieves published media metadata by SHA-256', async () => {
  const env = fakeEnv()
  const [saved] = await savePublishedMedia(env, [{
    hash: HASH,
    bytes: 512,
    mime_type: 'image/jpeg',
    file_name: `${HASH}.jpg`,
    published_drive_file_id: 'published-drive-file-2',
  }])

  const loaded = await getPublishedMedia(env, HASH)
  assert.equal(loaded.hash, saved.hash)
  assert.equal(loaded.bytes, 512)
  assert.equal(loaded.source_id, 'published-drive-file-2')

  const manifest = publishedMediaManifest([saved])
  assert.equal(manifest.files[HASH].path, saved.path)
})

test('rejects incomplete media metadata before release publication', () => {
  assert.throws(() => normalizePublishedMedia({
    hash: 'bad-hash',
    bytes: 100,
    published_drive_file_id: 'file-3',
  }), /full SHA-256/)

  assert.throws(() => normalizePublishedMedia({
    hash: HASH,
    bytes: 0,
    published_drive_file_id: 'file-3',
  }), /invalid file size/)
})
