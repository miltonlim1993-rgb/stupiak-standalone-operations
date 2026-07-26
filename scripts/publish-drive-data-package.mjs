import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { pipeline } from 'node:stream/promises'

const DEFAULT_WORKER_URL = 'https://stupiaks-ops.sporkburger19.workers.dev'

function parseArgs(argv) {
  const result = { outlet: '', dryRun: false, workerUrl: '', actor: 'drive-package-publisher', report: '' }
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (value === '--outlet') result.outlet = String(argv[++index] || '').trim()
    else if (value === '--worker-url') result.workerUrl = String(argv[++index] || '').trim()
    else if (value === '--actor') result.actor = String(argv[++index] || '').trim()
    else if (value === '--report') result.report = String(argv[++index] || '').trim()
    else if (value === '--dry-run') result.dryRun = true
    else if (value === '--help' || value === '-h') result.help = true
    else throw new Error(`Unknown argument: ${value}`)
  }
  return result
}

function usage() {
  console.log(`
Stupiak's Ops Drive Data Package Publisher

Usage:
  npm run package:publish-drive -- --outlet RR-KCH

Options:
  --outlet <id>       Required outlet ID/code
  --worker-url <url>  Worker URL (defaults to production)
  --actor <name>      Publish audit name
  --report <path>     Optional JSON report output path
  --dry-run           Read-only scan and hash; no folders, uploads or release changes

Required environment values:
  GOOGLE_DATA_CLIENT_ID
  GOOGLE_DATA_CLIENT_SECRET
  GOOGLE_DATA_REFRESH_TOKEN
  GOOGLE_PUBLISHED_PACKAGE_FOLDER_ID
  APP_PACK_WEBHOOK_SECRET
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

function required(env, name) {
  const value = String(env[name] || '').trim()
  if (!value) throw new Error(`${name} is required. Add it to .dev.vars or your shell environment.`)
  return value
}

function reportPath(args) {
  if (args.report) return path.resolve(args.report)
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').replace('Z', '')
  const mode = args.dryRun ? 'dry-run' : 'publish'
  return path.join(os.homedir(), '.stupiaks-ops-data-packages', 'reports', `${args.outlet}-${mode}-${timestamp}.json`)
}

async function writeReport(filePath, report) {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  return filePath
}

async function googleAccessToken(env) {
  const body = new URLSearchParams({
    client_id: required(env, 'GOOGLE_DATA_CLIENT_ID'),
    client_secret: required(env, 'GOOGLE_DATA_CLIENT_SECRET'),
    refresh_token: required(env, 'GOOGLE_DATA_REFRESH_TOKEN'),
    grant_type: 'refresh_token',
  })
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok || !data.access_token) throw new Error(data.error_description || data.error || 'Unable to refresh Google access token')
  return data.access_token
}

async function googleRequest(token, url, options = {}) {
  const headers = new Headers(options.headers || {})
  headers.set('Authorization', `Bearer ${token}`)
  const response = await fetch(url, { ...options, headers })
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`Google Drive ${response.status}: ${text.slice(0, 800)}`)
  }
  return response
}

function escapeQuery(value) {
  return String(value || '').replaceAll('\\', '\\\\').replaceAll("'", "\\'")
}

async function findFolder(token, parentId, name) {
  const url = new URL('https://www.googleapis.com/drive/v3/files')
  url.searchParams.set('q', [
    `mimeType='application/vnd.google-apps.folder'`,
    `name='${escapeQuery(name)}'`,
    `'${escapeQuery(parentId)}' in parents`,
    'trashed=false',
  ].join(' and '))
  url.searchParams.set('fields', 'files(id,name)')
  url.searchParams.set('pageSize', '10')
  url.searchParams.set('supportsAllDrives', 'true')
  url.searchParams.set('includeItemsFromAllDrives', 'true')
  const data = await (await googleRequest(token, url)).json()
  return data.files?.[0] || null
}

async function createFolder(token, parentId, name) {
  const url = new URL('https://www.googleapis.com/drive/v3/files')
  url.searchParams.set('fields', 'id,name')
  url.searchParams.set('supportsAllDrives', 'true')
  return (await googleRequest(token, url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name,
      mimeType: 'application/vnd.google-apps.folder',
      parents: [parentId],
    }),
  })).json()
}

async function ensureFolder(token, parentId, name) {
  return (await findFolder(token, parentId, name)) || createFolder(token, parentId, name)
}

async function sourceMetadata(token, fileId) {
  const url = new URL(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}`)
  url.searchParams.set('fields', 'id,name,mimeType,size,md5Checksum,modifiedTime')
  url.searchParams.set('supportsAllDrives', 'true')
  return (await googleRequest(token, url)).json()
}

async function downloadDriveSource(token, fileId, outputPath) {
  const url = new URL(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}`)
  url.searchParams.set('alt', 'media')
  url.searchParams.set('supportsAllDrives', 'true')
  const response = await googleRequest(token, url)
  if (!response.body) throw new Error(`Google Drive file ${fileId} returned no body`)
  await pipeline(response.body, createWriteStream(outputPath))
  return response.headers.get('content-type') || ''
}

async function downloadExternalSource(url, outputPath) {
  const response = await fetch(url, { redirect: 'follow' })
  if (!response.ok || !response.body) throw new Error(`External media ${response.status}: ${url}`)
  await pipeline(response.body, createWriteStream(outputPath))
  return response.headers.get('content-type') || ''
}

async function fileSha256(filePath) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(filePath)) hash.update(chunk)
  return hash.digest('hex')
}

function extensionFor(fileName = '', mimeType = '') {
  const existing = path.extname(fileName).toLowerCase().replace(/[^.a-z0-9]/g, '')
  if (existing && existing.length <= 8) return existing
  const type = String(mimeType || '').toLowerCase()
  if (type.includes('jpeg')) return '.jpg'
  if (type.includes('png')) return '.png'
  if (type.includes('webp')) return '.webp'
  if (type.includes('gif')) return '.gif'
  if (type.includes('mp4')) return '.mp4'
  if (type.includes('webm')) return '.webm'
  if (type.includes('quicktime')) return '.mov'
  if (type.includes('pdf')) return '.pdf'
  return '.bin'
}

async function findPublishedFile(token, folderId, fileName) {
  if (!folderId) return null
  const url = new URL('https://www.googleapis.com/drive/v3/files')
  url.searchParams.set('q', [
    `name='${escapeQuery(fileName)}'`,
    `'${escapeQuery(folderId)}' in parents`,
    'trashed=false',
  ].join(' and '))
  url.searchParams.set('fields', 'files(id,name,mimeType,size,md5Checksum,modifiedTime)')
  url.searchParams.set('pageSize', '10')
  url.searchParams.set('supportsAllDrives', 'true')
  url.searchParams.set('includeItemsFromAllDrives', 'true')
  const data = await (await googleRequest(token, url)).json()
  return data.files?.[0] || null
}

async function uploadPublishedFile(token, folderId, filePath, fileName, mimeType, hash, sourceKey) {
  const fileInfo = await fs.stat(filePath)
  const url = new URL('https://www.googleapis.com/upload/drive/v3/files')
  url.searchParams.set('uploadType', 'resumable')
  url.searchParams.set('fields', 'id,name,mimeType,size,md5Checksum,modifiedTime')
  url.searchParams.set('supportsAllDrives', 'true')
  const initiate = await googleRequest(token, url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=UTF-8',
      'X-Upload-Content-Type': mimeType || 'application/octet-stream',
      'X-Upload-Content-Length': String(fileInfo.size),
    },
    body: JSON.stringify({
      name: fileName,
      parents: [folderId],
      appProperties: {
        chefops_data_package: 'v2',
        sha256: hash,
        source_key: String(sourceKey || '').slice(0, 120),
      },
    }),
  })
  const location = initiate.headers.get('location')
  if (!location) throw new Error('Google Drive did not return a resumable upload URL')
  const uploaded = await googleRequest(token, location, {
    method: 'PUT',
    headers: {
      'Content-Type': mimeType || 'application/octet-stream',
      'Content-Length': String(fileInfo.size),
    },
    body: createReadStream(filePath),
    duplex: 'half',
  })
  return uploaded.json()
}

async function publisherRequest(workerUrl, secret, action, body) {
  const response = await fetch(`${workerUrl.replace(/\/$/, '')}/api/internal/data-package-v2/${action}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-ChefOps-Pack-Secret': secret,
    },
    body: JSON.stringify(body),
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) {
    const error = new Error(data.error || data.message || `Publisher API failed (${response.status})`)
    error.code = data.code
    error.details = data.details
    throw error
  }
  return data
}

async function packageReference({ token, mediaFolderId, reference, tempDir, dryRun }) {
  const sourceName = reference.file_name || reference.source_id || 'media'
  const tempPath = path.join(tempDir, `${crypto.randomUUID()}.download`)
  let metadata = null
  let mimeType = ''

  if (reference.source_provider === 'google_drive' && reference.source_id) {
    metadata = await sourceMetadata(token, reference.source_id)
    mimeType = await downloadDriveSource(token, reference.source_id, tempPath)
  } else if (reference.source_url) {
    mimeType = await downloadExternalSource(reference.source_url, tempPath)
  } else {
    throw new Error(`Media source is missing for ${reference.source_key}`)
  }

  try {
    const fileInfo = await fs.stat(tempPath)
    const hash = await fileSha256(tempPath)
    const effectiveMime = metadata?.mimeType || mimeType || 'application/octet-stream'
    const effectiveName = metadata?.name || sourceName
    const publishedName = `${hash}${extensionFor(effectiveName, effectiveMime)}`
    let published = await findPublishedFile(token, mediaFolderId, publishedName)
    let reused = Boolean(published)

    if (!published && !dryRun) {
      if (!mediaFolderId) throw new Error('Published media folder is unavailable')
      published = await uploadPublishedFile(
        token,
        mediaFolderId,
        tempPath,
        publishedName,
        effectiveMime,
        hash,
        reference.source_key,
      )
      reused = false
    }

    if (!published && dryRun) {
      published = { id: `dry-run:${hash}`, name: publishedName, size: String(fileInfo.size), mimeType: effectiveMime }
    }

    return {
      source_key: reference.source_key,
      source_etag: metadata?.md5Checksum || metadata?.modifiedTime || '',
      hash,
      bytes: Number(fileInfo.size),
      mime_type: effectiveMime,
      file_name: publishedName,
      kind: reference.asset_type || 'file',
      published_drive_file_id: published.id,
      uploaded_at: new Date().toISOString(),
      reused,
      dry_run: dryRun,
    }
  } finally {
    await fs.rm(tempPath, { force: true })
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    usage()
    return
  }
  if (!args.outlet) throw new Error('--outlet is required')

  const env = await loadLocalEnv()
  const workerUrl = args.workerUrl || env.CHEFOPS_WORKER_URL || env.PRODUCTION_WEB_URL || DEFAULT_WORKER_URL
  const secret = required(env, 'APP_PACK_WEBHOOK_SECRET')
  const publishedRoot = required(env, 'GOOGLE_PUBLISHED_PACKAGE_FOLDER_ID')
  const token = await googleAccessToken(env)
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'stupiaks-data-package-'))
  const outputPath = reportPath(args)

  try {
    console.log(`\nScanning ${args.outlet} source through ${workerUrl} ...`)
    const initial = await publisherRequest(workerUrl, secret, 'preview', {
      outlet_id: args.outlet,
      actor: args.actor,
    })
    const references = initial.comparison?.unresolved_media || []
    console.log(`Source version: ${initial.source_pack_version || 'unknown'}`)
    console.log(`Modules waiting: ${(initial.comparison?.changed_modules || []).join(', ') || 'none'}`)
    console.log(`Media files: ${references.length}`)

    const outletFolder = args.dryRun
      ? await findFolder(token, publishedRoot, args.outlet)
      : await ensureFolder(token, publishedRoot, args.outlet)
    const mediaFolder = outletFolder
      ? (args.dryRun ? await findFolder(token, outletFolder.id, 'media') : await ensureFolder(token, outletFolder.id, 'media'))
      : null
    const mediaFiles = []

    for (let index = 0; index < references.length; index += 1) {
      const reference = references[index]
      process.stdout.write(`[${index + 1}/${references.length}] ${reference.file_name || reference.source_key} ... `)
      const packaged = await packageReference({
        token,
        mediaFolderId: mediaFolder?.id || '',
        reference,
        tempDir,
        dryRun: args.dryRun,
      })
      mediaFiles.push(packaged)
      console.log(`${packaged.reused ? 'reused' : args.dryRun ? 'dry-run' : 'uploaded'} ${packaged.hash.slice(0, 12)} (${packaged.bytes} bytes)`)
    }

    const finalPreview = await publisherRequest(workerUrl, secret, 'preview', {
      outlet_id: args.outlet,
      actor: args.actor,
      media_files: mediaFiles,
    })
    if (finalPreview.comparison?.unresolved_media_count) {
      throw new Error(`${finalPreview.comparison.unresolved_media_count} media files remain unresolved after packaging`)
    }

    const report = {
      schema: 'stupiaks-ops-data-package-publisher-report-v1',
      mode: args.dryRun ? 'dry-run' : 'publish',
      generated_at: new Date().toISOString(),
      outlet_id: args.outlet,
      worker_url: workerUrl,
      source_pack_version: initial.source_pack_version || '',
      current_version: initial.current_manifest?.version || '',
      draft_version: finalPreview.draft_manifest?.version || '',
      changed_modules: finalPreview.comparison?.changed_modules || [],
      module_changes: finalPreview.comparison?.module_changes || [],
      media_count: mediaFiles.length,
      media_bytes: mediaFiles.reduce((sum, item) => sum + Number(item.bytes || 0), 0),
      reused_media_count: mediaFiles.filter((item) => item.reused).length,
      new_media_count: mediaFiles.filter((item) => !item.reused).length,
      total_package_bytes: Number(finalPreview.draft_manifest?.total_bytes || 0),
      published_root_folder_id: publishedRoot,
      outlet_folder_found: Boolean(outletFolder?.id),
      media_folder_found: Boolean(mediaFolder?.id),
      media_files: mediaFiles,
      draft_manifest: finalPreview.draft_manifest || null,
    }
    await writeReport(outputPath, report)

    console.log(`Draft version: ${finalPreview.draft_manifest?.version}`)
    console.log(`Total package: ${finalPreview.draft_manifest?.total_bytes || 0} bytes`)
    console.log(`Report: ${outputPath}`)

    if (args.dryRun) {
      console.log('\nDry run complete. No Drive folder, file or release was changed.')
      return
    }

    const published = await publisherRequest(workerUrl, secret, 'publish', {
      outlet_id: args.outlet,
      actor: args.actor,
      expected_source_version: initial.source_pack_version,
      expected_version: finalPreview.draft_manifest?.version,
      media_files: mediaFiles,
    })

    report.published_at = new Date().toISOString()
    report.published_version = published.manifest?.version || ''
    report.published_manifest = published.manifest || null
    await writeReport(outputPath, report)

    console.log('\n✅ Data Package v2 published')
    console.log(`Outlet: ${args.outlet}`)
    console.log(`Release: ${published.manifest?.version}`)
    console.log(`Modules: ${Object.keys(published.manifest?.modules || {}).length}`)
    console.log(`Media: ${Object.keys(published.manifest?.media?.files || {}).length}`)
    console.log(`Bytes: ${published.manifest?.total_bytes || 0}`)
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(`\n❌ ${error.message}`)
  if (error.code) console.error(`Code: ${error.code}`)
  if (error.details) console.error(JSON.stringify(error.details, null, 2))
  process.exitCode = 1
})
