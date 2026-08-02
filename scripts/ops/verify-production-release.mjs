import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const root = process.cwd()
const origin = String(process.env.OPS_PRODUCTION_ORIGIN || 'https://stupiaks-ops.sporkburger19.workers.dev').replace(/\/$/, '')
const outputDir = path.resolve(process.env.OPS_VERIFY_OUTPUT_DIR || path.join(root, 'audit', `production-verify-${Date.now()}`))
const apkOutput = path.resolve(process.env.OPS_APK_OUTPUT || path.join(outputDir, 'stupiaks-ops-task-sop-alarm.apk'))
mkdirSync(outputDir, { recursive: true })
mkdirSync(path.dirname(apkOutput), { recursive: true })

function local(relativePath) {
  const absolute = path.join(root, relativePath)
  if (!existsSync(absolute)) throw new Error(`Missing local file: ${relativePath}`)
  return readFileSync(absolute, 'utf8')
}

function valueFrom(source, expression, label) {
  const match = source.match(expression)
  if (!match) throw new Error(`Unable to resolve ${label}`)
  return match[1]
}

async function fetchChecked(url, options = {}) {
  const response = await fetch(url, {
    redirect: 'follow',
    cache: 'no-store',
    ...options,
    headers: {
      'Cache-Control': 'no-cache',
      ...(options.headers || {}),
    },
  })
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`)
  return response
}

async function retry(label, operation, attempts = 30, delayMs = 5000) {
  let lastError
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation(attempt)
    } catch (error) {
      lastError = error
      if (attempt < attempts) {
        console.log(`${label} not ready (${attempt}/${attempts}): ${error.message}`)
        await new Promise((resolve) => setTimeout(resolve, delayMs))
      }
    }
  }
  throw lastError
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

const sourceManifest = JSON.parse(local('web/public/app-release.json'))
const entrySource = local('worker/src/entry.js')
const mainSource = local('web/src/main.jsx')
const expectedRevision = valueFrom(entrySource, /const WORKER_REVISION = ['"]([^'"]+)['"]/, 'Worker revision')
const serviceWorkerPath = valueFrom(mainSource, /navigator\.serviceWorker\.register\(['"]([^'"]+)['"]/, 'service worker path')
const expectedApkVersion = String(sourceManifest.minimum_apk_version || sourceManifest.apk_version || '').trim()
const expectedPwaVersion = String(sourceManifest.minimum_pwa_version || sourceManifest.pwa_version || '').trim()
const expectedAssetName = String(sourceManifest.apk_asset_name || 'stupiaks-ops-task-sop-alarm.apk').trim()
const releaseApiUrl = String(sourceManifest.release_api_url || '').trim()

if (!expectedApkVersion || !expectedPwaVersion || !releaseApiUrl) {
  throw new Error('Local app-release.json is missing required APK/PWA/release fields')
}

const production = await retry('Production release', async () => {
  const [healthResponse, manifestResponse, workerResponse, releaseResponse] = await Promise.all([
    fetchChecked(`${origin}/api/health?_=${Date.now()}`),
    fetchChecked(`${origin}/app-release.json?_=${Date.now()}`),
    fetchChecked(`${origin}${serviceWorkerPath}?_=${Date.now()}`),
    fetchChecked(`${releaseApiUrl}${releaseApiUrl.includes('?') ? '&' : '?'}_=${Date.now()}`, {
      headers: { Accept: 'application/vnd.github+json' },
    }),
  ])

  const health = await healthResponse.json()
  const manifest = await manifestResponse.json()
  const serviceWorker = await workerResponse.text()
  const release = await releaseResponse.json()
  const revision = healthResponse.headers.get('x-chefops-worker-revision') || ''

  if (revision !== expectedRevision) throw new Error(`Worker revision ${revision || '(missing)'} != ${expectedRevision}`)
  if (health?.ok !== true) throw new Error('Production health response is not ok')
  if (String(manifest.minimum_apk_version || manifest.apk_version || '') !== expectedApkVersion) {
    throw new Error('Production mandatory APK version does not match source')
  }
  if (manifest.force_update !== true) throw new Error('Production force_update is not true')
  if (String(manifest.minimum_pwa_version || manifest.pwa_version || '') !== expectedPwaVersion) {
    throw new Error('Production mandatory PWA version does not match source')
  }
  if (manifest.pwa_force_update !== true) throw new Error('Production pwa_force_update is not true')
  if (!serviceWorker.includes(expectedPwaVersion)) throw new Error('Production service worker is missing the expected PWA version')
  if (!serviceWorker.includes('caches.delete')) throw new Error('Production service worker does not clear old caches')

  const releaseIdentity = `${release.name || ''} ${release.tag_name || ''}`
  if (!releaseIdentity.includes(expectedApkVersion)) throw new Error('GitHub release title/tag does not contain the mandatory APK version')
  const apkAsset = (release.assets || []).find((asset) => asset.name === expectedAssetName)
  const sumsAsset = (release.assets || []).find((asset) => asset.name === 'SHA256SUMS.txt')
  if (!apkAsset?.browser_download_url) throw new Error(`GitHub release is missing ${expectedAssetName}`)
  if (Number(apkAsset.size || 0) < 1_000_000) throw new Error('GitHub APK asset is unexpectedly small')
  if (!sumsAsset?.browser_download_url) throw new Error('GitHub release is missing SHA256SUMS.txt')

  return { health, manifest, serviceWorker, release, revision, apkAsset, sumsAsset }
})

writeFileSync(path.join(outputDir, 'health.json'), `${JSON.stringify(production.health, null, 2)}\n`)
writeFileSync(path.join(outputDir, 'app-release.json'), `${JSON.stringify(production.manifest, null, 2)}\n`)
writeFileSync(path.join(outputDir, path.basename(serviceWorkerPath)), production.serviceWorker)
writeFileSync(path.join(outputDir, 'github-release.json'), `${JSON.stringify(production.release, null, 2)}\n`)

const [apkResponse, sumsResponse, fixedResponse] = await Promise.all([
  fetchChecked(`${production.apkAsset.browser_download_url}?verified_at=${Date.now()}`),
  fetchChecked(`${production.sumsAsset.browser_download_url}?verified_at=${Date.now()}`),
  fetchChecked(`${sourceManifest.apk_url}${String(sourceManifest.apk_url).includes('?') ? '&' : '?'}verified_at=${Date.now()}`),
])

const apkBuffer = Buffer.from(await apkResponse.arrayBuffer())
const fixedBuffer = Buffer.from(await fixedResponse.arrayBuffer())
const sumsText = await sumsResponse.text()
const releaseSha = sha256(apkBuffer)
const fixedSha = sha256(fixedBuffer)
const sumsLine = sumsText.split(/\r?\n/).find((line) => line.trim().endsWith(expectedAssetName)) || ''
const publishedSha = sumsLine.trim().split(/\s+/)[0] || ''

if (!publishedSha) throw new Error(`SHA256SUMS.txt does not contain ${expectedAssetName}`)
if (releaseSha !== publishedSha) throw new Error('Downloaded release APK does not match SHA256SUMS.txt')
if (fixedSha !== releaseSha) throw new Error('Fixed public APK URL does not serve the current signed APK')

writeFileSync(apkOutput, apkBuffer)
writeFileSync(path.join(outputDir, 'SHA256SUMS.txt'), sumsText)
writeFileSync(path.join(outputDir, 'verification.json'), `${JSON.stringify({
  verified_at: new Date().toISOString(),
  production_origin: origin,
  worker_revision: expectedRevision,
  apk_version: expectedApkVersion,
  pwa_version: expectedPwaVersion,
  apk_asset_name: expectedAssetName,
  apk_size: apkBuffer.length,
  apk_sha256: releaseSha,
  fixed_apk_sha256: fixedSha,
  fixed_apk_match: true,
  apk_output: apkOutput,
}, null, 2)}\n`)

console.log('PRODUCTION_RELEASE_VERIFIED=true')
console.log(`WORKER_REVISION=${expectedRevision}`)
console.log(`APK_REQUIRED_VERSION=${expectedApkVersion}`)
console.log(`PWA_REQUIRED_VERSION=${expectedPwaVersion}`)
console.log(`LATEST_APK=${apkOutput}`)
console.log(`LATEST_APK_SHA256=${releaseSha}`)
console.log('FIXED_APK_MATCH=true')
console.log(`VERIFY_OUTPUT_DIR=${outputDir}`)
