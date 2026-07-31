import fs from 'node:fs'

const workerPath = 'worker/src/index.js'
let worker = fs.readFileSync(workerPath, 'utf8')
const before = "return taskPhotos.filter((row) => String(row.photo_type || '') === `checklist:${groupId}` && !row.deleted_at).length"
const after = "return taskPhotos.filter((row) => String(row.photo_type || '') === `checklist:${groupId}` && !row.deleted_at && String(row.status || 'active').toLowerCase() !== 'deleted').length"
if (!worker.includes(before)) throw new Error('Missing operationalPhotoCount patch target')
worker = worker.replace(before, after)
fs.writeFileSync(workerPath, worker)

const swPath = 'web/public/sw.js'
let sw = fs.readFileSync(swPath, 'utf8')
sw = sw.replace('// Production release refresh: 4.5.3 / PWA v20', '// Production release refresh: 4.5.7 / PWA v21')
fs.writeFileSync(swPath, sw)

fs.rmSync('scripts/apply-opening-checklist-feedback.mjs')
