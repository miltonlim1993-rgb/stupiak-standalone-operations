import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

import { createSession } from '../worker/src/auth.js'
import { listRecords } from '../worker/src/sheets.js'

function clean(value = '') {
  return String(value || '').trim()
}

function parseArgs(argv) {
  const result = {
    outlet: '',
    workerUrl: 'http://127.0.0.1:8792',
    sourceReport: '',
    report: '',
  }

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (value === '--outlet') result.outlet = clean(argv[++index])
    else if (value === '--worker-url') result.workerUrl = clean(argv[++index])
    else if (value === '--source-report') result.sourceReport = clean(argv[++index])
    else if (value === '--report') result.report = clean(argv[++index])
    else if (value === '--help' || value === '-h') result.help = true
    else throw new Error(`Unknown argument: ${value}`)
  }

  return result
}

function usage() {
  console.log(`
Stupiak's Ops locked Data Package v2 Release Candidate verifier

Usage:
  node scripts/verify-data-package-release-candidate-locked.mjs \\
    --outlet RR-KCH \\
    --worker-url http://127.0.0.1:8792 \\
    --source-report ~/.stupiaks-ops-data-packages/reports/RR-KCH-prepare-media-....json

The prepared source version, release version, module fingerprints, media fingerprints
and total bytes must remain identical throughout verification.
`)
}

function parseEnvText(text) {
  const values = {}
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const separator = line.indexOf('=')
    if (separator < 1) continue
    const key = line.slice(0, separator).trim()
    let value = line.slice(separator + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    values[key] = value.replaceAll('\\n', '\n')
  }
  return values
}

async function loadLocalEnv() {
  const candidates = [
    path.join(process.cwd(), '.dev.vars'),
    path.join(process.cwd(), '.env.local'),
    path.join(process.cwd(), 'worker', '.dev.vars'),
  ]
  const loaded = {}
  for (const file of candidates) {
    try { Object.assign(loaded, parseEnvText(await fs.readFile(file, 'utf8'))) } catch {}
  }
  return { ...loaded, ...process.env }
}

function required(value, name) {
  const result = clean(value)
  if (!result) throw new Error(`${name} is required`)
  return result
}

function defaultReportPath(outlet) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').replace('Z', '')
  return path.join(os.homedir(), '.stupiaks-ops-data-packages', 'reports', `${outlet}-release-candidate-${timestamp}.json`)
}

async function writeReport(filePath, report) {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) throw new Error(`${label}: expected ${expected}, received ${actual}`)
}

function assignedOutletIds(user = {}) {
  const values = [user.outlet_id]
  const raw = clean(user.outlet_ids)
  if (raw) {
    if (raw.startsWith('[')) {
      try {
        const parsed = JSON.parse(raw)
        if (Array.isArray(parsed)) values.push(...parsed)
      } catch {
        values.push(...raw.split(','))
      }
    } else {
      values.push(...raw.split(','))
    }
  }
  return [...new Set(values.map(clean).filter(Boolean))]
}

async function selectVerificationUser(env, outletId) {
  const users = await listRecords(env, 'User', { limit: 5000 })
  const active = users.filter((user) => clean(user.status).toLowerCase() === 'active' && clean(user.google_sub))
  const privileged = active.find((user) => ['owner', 'manager'].includes(clean(user.role).toLowerCase()))
  const assigned = active.find((user) => assignedOutletIds(user).includes(outletId))
  const selected = privileged || assigned
  if (!selected) throw new Error(`No active Google-linked user is available for ${outletId}`)
  return selected
}

async function jsonRequest(url, options = {}) {
  const response = await fetch(url, options)
  const data = await response.json().catch(() => ({}))
  if (!response.ok) {
    const error = new Error(data.error || data.message || `Request failed (${response.status})`)
    error.status = response.status
    error.code = data.code || ''
    error.details = data.details
    throw error
  }
  return { response, data }
}

async function publisherRequest(workerUrl, secret, action, body) {
  return (await jsonRequest(`${workerUrl.replace(/\/$/, '')}/api/internal/data-package-v2/${action}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-ChefOps-Pack-Secret': secret,
    },
    body: JSON.stringify(body),
  })).data
}

function authenticatedHeaders(token, extra = {}) {
  return { Authorization: `Bearer ${token}`, ...extra }
}

function objectUrl(workerUrl, objectPath, outletId) {
  const url = new URL(objectPath, `${workerUrl.replace(/\/$/, '')}/`)
  url.searchParams.set('outlet_id', outletId)
  return url.toString()
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

function moduleFingerprint(info = {}) {
  return {
    hash: clean(info.hash).toLowerCase(),
    bytes: Number(info.bytes || 0),
    records: Number(info.records || 0),
  }
}

function mediaFingerprint(info = {}) {
  return {
    hash: clean(info.hash || info.id).toLowerCase(),
    bytes: Number(info.bytes || 0),
    mime_type: clean(info.mime_type || info.content_type),
  }
}

function verifyPreparedCandidate(sourceReport, preview) {
  const expectedManifest = sourceReport.draft_manifest || {}
  const actualManifest = preview.draft_manifest || {}

  assertEqual(clean(preview.source_pack_version), clean(sourceReport.source_pack_version), 'Prepared source_pack_version')
  assertEqual(clean(actualManifest.version), clean(sourceReport.draft_version), 'Prepared draft_version')
  assertEqual(clean(expectedManifest.version), clean(sourceReport.draft_version), 'Prepare report manifest version')
  assertEqual(Number(actualManifest.total_bytes || 0), Number(sourceReport.total_package_bytes || 0), 'Prepared total bytes')

  const expectedModules = expectedManifest.modules || {}
  const actualModules = actualManifest.modules || {}
  const moduleNames = [...new Set([...Object.keys(expectedModules), ...Object.keys(actualModules)])].sort()
  assertEqual(moduleNames.length, 5, 'Prepared module count')

  for (const name of moduleNames) {
    if (!expectedModules[name] || !actualModules[name]) throw new Error(`Prepared module set changed: ${name}`)
    assertEqual(
      JSON.stringify(moduleFingerprint(actualModules[name])),
      JSON.stringify(moduleFingerprint(expectedModules[name])),
      `Prepared module ${name}`,
    )
  }

  const expectedMedia = expectedManifest.media?.files || {}
  const actualMedia = actualManifest.media?.files || {}
  const mediaNames = [...new Set([...Object.keys(expectedMedia), ...Object.keys(actualMedia)])].sort()
  assertEqual(mediaNames.length, Number(sourceReport.media_count || 0), 'Prepared media count')

  for (const name of mediaNames) {
    if (!expectedMedia[name] || !actualMedia[name]) throw new Error(`Prepared media set changed: ${name}`)
    assertEqual(
      JSON.stringify(mediaFingerprint(actualMedia[name])),
      JSON.stringify(mediaFingerprint(expectedMedia[name])),
      `Prepared media ${name}`,
    )
  }

  if (Number(preview.comparison?.unresolved_media_count || 0) !== 0) {
    throw new Error(`${preview.comparison.unresolved_media_count} media files remain unresolved`)
  }

  return { expectedManifest, moduleNames, mediaNames }
}

async function verifyObject({ workerUrl, outletId, token, kind, name, info }) {
  const response = await fetch(objectUrl(workerUrl, info.path, outletId), {
    headers: authenticatedHeaders(token),
    cache: 'no-store',
  })
  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new Error(`${kind} ${name} download failed (${response.status}): ${body.slice(0, 300)}`)
  }

  const buffer = Buffer.from(await response.arrayBuffer())
  const actualHash = sha256(buffer)
  const expectedHash = clean(info.hash).toLowerCase()
  const expectedBytes = Number(info.bytes || 0)
  assertEqual(actualHash, expectedHash, `${kind} ${name} SHA-256`)
  if (expectedBytes > 0) assertEqual(buffer.byteLength, expectedBytes, `${kind} ${name} bytes`)
  if (kind === 'module') {
    try { JSON.parse(buffer.toString('utf8')) } catch { throw new Error(`Module ${name} is not valid JSON`) }
  }

  return {
    kind,
    name,
    hash: actualHash,
    bytes: buffer.byteLength,
    content_type: response.headers.get('content-type') || '',
    etag: response.headers.get('etag') || '',
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) return usage()

  const outletId = required(args.outlet, '--outlet')
  const workerUrl = required(args.workerUrl, '--worker-url').replace(/\/$/, '')
  const sourceReportPath = path.resolve(required(args.sourceReport, '--source-report'))
  const outputPath = args.report ? path.resolve(args.report) : defaultReportPath(outletId)
  const env = await loadLocalEnv()
  const publisherSecret = required(env.APP_PACK_WEBHOOK_SECRET, 'APP_PACK_WEBHOOK_SECRET')
  required(env.SESSION_SECRET, 'SESSION_SECRET')

  const sourceReport = JSON.parse(await fs.readFile(sourceReportPath, 'utf8'))
  assertEqual(clean(sourceReport.outlet_id), outletId, 'Prepare Media outlet')
  assertEqual(clean(sourceReport.mode), 'prepare-media', 'Prepare Media mode')
  if (sourceReport.release_changed !== false) throw new Error('Prepare Media report must have release_changed=false')
  if (!Array.isArray(sourceReport.media_files) || !sourceReport.media_files.length) {
    throw new Error('Prepare Media report contains no packaged media')
  }
  if (sourceReport.media_files.some((file) => !clean(file.published_drive_file_id) || file.dry_run)) {
    throw new Error('Prepare Media report contains dry-run or incomplete media entries')
  }

  const mediaFiles = sourceReport.media_files
  console.log(`\nPreparing locked local release candidate for ${outletId} ...`)
  console.log(`Expected source: ${clean(sourceReport.source_pack_version)}`)
  console.log(`Expected release: ${clean(sourceReport.draft_version)}`)
  console.log(`Prepared media entries: ${mediaFiles.length}`)

  const preview = await publisherRequest(workerUrl, publisherSecret, 'preview', {
    outlet_id: outletId,
    actor: 'locked-local-release-candidate-verifier',
    media_files: mediaFiles,
  })

  verifyPreparedCandidate(sourceReport, preview)
  console.log('Candidate consistency: source, release, modules, media and bytes match Prepare Media')

  const published = await publisherRequest(workerUrl, publisherSecret, 'publish', {
    outlet_id: outletId,
    actor: 'locked-local-release-candidate-verifier',
    expected_source_version: sourceReport.source_pack_version,
    expected_version: sourceReport.draft_version,
    media_files: mediaFiles,
  })

  const expectedManifest = published.manifest
  assertEqual(clean(published.source_pack_version), clean(sourceReport.source_pack_version), 'Published source_pack_version')
  assertEqual(clean(expectedManifest?.version), clean(sourceReport.draft_version), 'Published release version')
  console.log(`Local release: ${expectedManifest.version}`)
  console.log('Creating temporary authenticated app session ...')

  const verificationUser = await selectVerificationUser(env, outletId)
  const token = await createSession(verificationUser, env)
  const manifestUrl = `${workerUrl}/api/app/v4/data-package/manifest?outlet_id=${encodeURIComponent(outletId)}`

  const unauthenticated = await fetch(manifestUrl, { cache: 'no-store' })
  assertEqual(unauthenticated.status, 401, 'Unauthenticated manifest status')

  const manifestResponse = await fetch(manifestUrl, {
    headers: authenticatedHeaders(token),
    cache: 'no-store',
  })
  if (!manifestResponse.ok) {
    const body = await manifestResponse.text().catch(() => '')
    throw new Error(`Authenticated manifest download failed (${manifestResponse.status}): ${body.slice(0, 300)}`)
  }
  const manifest = await manifestResponse.json()
  assertEqual(manifest.version, sourceReport.draft_version, 'Manifest version')
  if (Number(manifest.format_version || manifest.schema_version || 0) < 2) {
    throw new Error('Manifest format_version is below 2')
  }

  const etagResponse = await fetch(manifestUrl, {
    headers: authenticatedHeaders(token, { 'If-None-Match': `"${manifest.version}"` }),
    cache: 'no-store',
  })
  assertEqual(etagResponse.status, 304, 'Manifest ETag status')

  const verifiedObjects = []
  const modules = Object.entries(manifest.modules || {})
  const media = Object.entries(manifest.media?.files || {})

  console.log(`Verifying ${modules.length} modules ...`)
  for (let index = 0; index < modules.length; index += 1) {
    const [name, info] = modules[index]
    process.stdout.write(`[M ${index + 1}/${modules.length}] ${name} ... `)
    const verified = await verifyObject({ workerUrl, outletId, token, kind: 'module', name, info })
    verifiedObjects.push(verified)
    console.log(`${verified.hash.slice(0, 12)} (${verified.bytes} bytes)`)
  }

  console.log(`Verifying ${media.length} media files ...`)
  for (let index = 0; index < media.length; index += 1) {
    const [name, info] = media[index]
    process.stdout.write(`[A ${index + 1}/${media.length}] ${name.slice(0, 12)} ... `)
    const verified = await verifyObject({ workerUrl, outletId, token, kind: 'media', name, info })
    verifiedObjects.push(verified)
    console.log(`${verified.hash.slice(0, 12)} (${verified.bytes} bytes)`)
  }

  const moduleBytes = verifiedObjects.filter((item) => item.kind === 'module').reduce((sum, item) => sum + item.bytes, 0)
  const mediaBytes = verifiedObjects.filter((item) => item.kind === 'media').reduce((sum, item) => sum + item.bytes, 0)
  const totalBytes = moduleBytes + mediaBytes
  assertEqual(totalBytes, Number(sourceReport.total_package_bytes || 0), 'Verified prepared total bytes')
  assertEqual(totalBytes, Number(manifest.total_bytes || 0), 'Manifest total_bytes')

  const report = {
    schema: 'stupiaks-ops-data-package-release-candidate-report-v1',
    passed: true,
    candidate_consistency_passed: true,
    generated_at: new Date().toISOString(),
    outlet_id: outletId,
    release_version: manifest.version,
    source_pack_version: published.source_pack_version || '',
    source_prepare_media_report: sourceReportPath,
    verification_user_role: clean(verificationUser.role),
    checks: {
      prepared_candidate_locked: true,
      unauthenticated_manifest_blocked: true,
      authenticated_manifest_loaded: true,
      etag_304: true,
      outlet_scoped_downloads: true,
      module_count: modules.length,
      media_count: media.length,
      module_bytes: moduleBytes,
      media_bytes: mediaBytes,
      total_bytes: totalBytes,
    },
    objects: verifiedObjects,
  }

  await writeReport(outputPath, report)
  console.log('\n✅ Locked Local Data Package v2 Release Candidate passed')
  console.log(`Release: ${manifest.version}`)
  console.log(`Modules: ${modules.length}`)
  console.log(`Media: ${media.length}`)
  console.log(`Verified bytes: ${totalBytes}`)
  console.log('Production Worker, production KV and Cloudflare latest were not changed.')
  console.log(`Report: ${outputPath}`)
}

main().catch((error) => {
  console.error(`\n❌ ${error.message}`)
  if (error.code) console.error(`Code: ${error.code}`)
  if (error.details) console.error(JSON.stringify(error.details, null, 2))
  process.exitCode = 1
})
