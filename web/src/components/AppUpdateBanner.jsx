import { useEffect, useRef, useState } from 'react'
import { CheckCircle2, Download, Loader2, RefreshCw, ShieldAlert } from 'lucide-react'
import { opsClient } from '@/api/opsClient'

const CURRENT_RELEASE = '4.5.18'
const DEFAULT_APK_URL = 'https://github.com/miltonlim1993-rgb/stupiak-standalone-operations/releases/download/android-release-latest/stupiaks-ops-task-sop-alarm.apk'
const DEFAULT_RELEASE_API = 'https://api.github.com/repos/miltonlim1993-rgb/stupiak-standalone-operations/releases/tags/android-release-latest'
const CHECK_MS = 30_000
const AUTO_OPEN_COOLDOWN_MS = 60_000

function nativeAndroid() {
  const capacitor = window.Capacitor
  return Boolean(
    (capacitor?.isNativePlatform?.() && capacitor?.getPlatform?.() === 'android')
    || window.location.origin === 'https://localhost'
    || window.location.origin === 'capacitor://localhost'
  )
}

function versionParts(value) {
  return String(value || '').match(/\d+/g)?.map(Number) || [0]
}

function compareVersions(left, right) {
  const a = versionParts(left)
  const b = versionParts(right)
  const length = Math.max(a.length, b.length)
  for (let index = 0; index < length; index += 1) {
    const difference = Number(a[index] || 0) - Number(b[index] || 0)
    if (difference) return difference
  }
  return 0
}

function cacheBustedUrl(value, version) {
  const url = String(value || '').trim()
  if (!url) return ''
  const separator = url.includes('?') ? '&' : '?'
  return `${url}${separator}ops_version=${encodeURIComponent(version)}&t=${Date.now()}`
}

async function installedVersion() {
  const plugins = window.Capacitor?.Plugins || {}
  try {
    const result = await plugins.AppUpdate?.getInstalledVersion?.()
    if (result?.versionName) return String(result.versionName)
  } catch {}
  try {
    const result = await plugins.App?.getInfo?.()
    if (result?.version) return String(result.version)
  } catch {}
  return CURRENT_RELEASE
}

async function remoteReleaseManifest() {
  const response = await fetch(`${opsClient.apiBaseUrl}/app-release.json?_=${Date.now()}`, {
    cache: 'no-store',
    credentials: 'omit',
    headers: { 'Cache-Control': 'no-cache' },
  })
  if (!response.ok) throw new Error(`Release manifest unavailable (${response.status})`)
  return response.json()
}

async function verifiedRelease(manifest, targetVersion) {
  const apiUrl = String(manifest.release_api_url || DEFAULT_RELEASE_API)
  try {
    const response = await fetch(`${apiUrl}${apiUrl.includes('?') ? '&' : '?'}_=${Date.now()}`, {
      cache: 'no-store',
      headers: {
        Accept: 'application/vnd.github+json',
        'Cache-Control': 'no-cache',
      },
    })
    if (!response.ok) return null
    const release = await response.json()
    const title = `${release.name || ''} ${release.tag_name || ''}`
    if (!title.includes(targetVersion)) return null
    const expectedAsset = String(manifest.apk_asset_name || 'stupiaks-ops-task-sop-alarm.apk')
    const asset = (release.assets || []).find((item) => item.name === expectedAsset)
      || (release.assets || []).find((item) => String(item.name || '').endsWith('.apk'))
    if (!asset?.browser_download_url || Number(asset.size || 0) < 1_000_000) return null
    return {
      url: cacheBustedUrl(asset.browser_download_url, targetVersion),
      title: release.name || `Stupiak's Ops ${targetVersion}`,
      assetName: asset.name,
      assetSize: Number(asset.size || 0),
    }
  } catch {
    return null
  }
}

async function openApkDownload(url) {
  if (!url) return
  const plugin = window.Capacitor?.Plugins?.AppUpdate
  if (plugin?.openDownload) {
    await plugin.openDownload({ url })
    return
  }
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.target = '_blank'
  anchor.rel = 'noopener noreferrer'
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
}

function autoOpenRequiredApk(update) {
  if (!update?.releaseReady || !update.apkUrl) return
  const key = `chefops.apk-update.last-opened.${update.targetVersion}`
  const lastOpened = Number(localStorage.getItem(key) || 0)
  if (Date.now() - lastOpened < AUTO_OPEN_COOLDOWN_MS) return
  localStorage.setItem(key, String(Date.now()))
  openApkDownload(update.apkUrl).catch(() => undefined)
}

export default function AppUpdateBanner({ global = false } = {}) {
  if (typeof window !== 'undefined') {
    if (global) window.__chefopsGlobalAppUpdateGate = true
    else if (window.__chefopsGlobalAppUpdateGate) return null
  }

  const android = nativeAndroid()
  const [registration, setRegistration] = useState(null)
  const [apkUpdate, setApkUpdate] = useState(null)
  const [checking, setChecking] = useState(false)
  const [statusText, setStatusText] = useState('')
  const checkingRef = useRef(false)

  useEffect(() => {
    if (android || !('serviceWorker' in navigator)) return undefined
    let cancelled = false
    let reloading = false

    const activateWaitingWorker = (current) => {
      if (!current?.waiting || cancelled) return
      setRegistration(current)
      current.waiting.postMessage({ type: 'SKIP_WAITING' })
    }

    const inspect = async () => {
      const current = await navigator.serviceWorker.getRegistration()
      if (!current || cancelled) return
      activateWaitingWorker(current)
      current.addEventListener('updatefound', () => {
        const worker = current.installing
        worker?.addEventListener('statechange', () => {
          if (worker.state === 'installed' && navigator.serviceWorker.controller) {
            activateWaitingWorker(current)
          }
        })
      }, { once: true })
      current.update().catch(() => undefined)
    }

    const onControllerChange = () => {
      if (reloading) return
      reloading = true
      localStorage.setItem('chefops.pending-shell-version', 'event-autosave-responsive-viewport-v33')
      window.location.reload()
    }
    const onActive = () => {
      if (document.visibilityState === 'visible') inspect()
    }

    navigator.serviceWorker.addEventListener('controllerchange', onControllerChange)
    window.addEventListener('focus', onActive)
    window.addEventListener('online', inspect)
    document.addEventListener('visibilitychange', onActive)
    inspect()
    const timer = window.setInterval(inspect, CHECK_MS)
    return () => {
      cancelled = true
      navigator.serviceWorker.removeEventListener('controllerchange', onControllerChange)
      window.removeEventListener('focus', onActive)
      window.removeEventListener('online', inspect)
      document.removeEventListener('visibilitychange', onActive)
      window.clearInterval(timer)
    }
  }, [android])

  useEffect(() => {
    if (!android) return undefined
    let cancelled = false

    const check = async ({ userRequested = false } = {}) => {
      if (checkingRef.current || !navigator.onLine) return
      checkingRef.current = true
      if (userRequested) setChecking(true)
      try {
        const [installed, manifest] = await Promise.all([
          installedVersion(),
          remoteReleaseManifest(),
        ])
        if (cancelled) return
        const targetVersion = String(manifest.minimum_apk_version || manifest.apk_version || CURRENT_RELEASE).trim()
        const updateRequired = Boolean(manifest.force_update !== false)
          && compareVersions(installed, targetVersion) < 0
        if (!updateRequired) {
          setApkUpdate(null)
          setStatusText(userRequested ? `已是最新版本 ${installed}` : '')
          return
        }

        const release = await verifiedRelease(manifest, targetVersion)
        if (cancelled) return
        const update = {
          installedVersion: installed,
          targetVersion,
          apkUrl: release?.url || '',
          releaseTitle: release?.title || `Stupiak's Ops ${targetVersion}`,
          releaseNotes: manifest.release_notes || 'This version is required to continue using OPS.',
          releaseReady: Boolean(release?.url),
          assetName: release?.assetName || '',
          assetSize: release?.assetSize || 0,
        }
        setApkUpdate(update)
        setStatusText(update.releaseReady
          ? ''
          : `版本 ${targetVersion} 正在完成签名发布。旧版已锁定，系统会每 30 秒自动重试。`)
        autoOpenRequiredApk(update)
      } catch (error) {
        if (userRequested) setStatusText(error.message || '无法检查更新，请确认网络连接。')
      } finally {
        checkingRef.current = false
        setChecking(false)
      }
    }

    const onVisible = () => {
      if (document.visibilityState === 'visible') check()
    }
    const onOnline = () => check()
    check()
    window.addEventListener('focus', onVisible)
    window.addEventListener('online', onOnline)
    document.addEventListener('visibilitychange', onVisible)
    const timer = window.setInterval(check, CHECK_MS)
    return () => {
      cancelled = true
      window.removeEventListener('focus', onVisible)
      window.removeEventListener('online', onOnline)
      document.removeEventListener('visibilitychange', onVisible)
      window.clearInterval(timer)
    }
  }, [android])

  if (android && apkUpdate) {
    return (
      <div className="chefops-viewport-overlay fixed z-[940] flex items-center justify-center bg-black/90 p-4 backdrop-blur-sm">
        <section className="max-h-full w-full max-w-md overflow-y-auto rounded-3xl border border-red-400/50 bg-background p-5 shadow-2xl sm:p-7">
          <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-red-100 text-red-700"><ShieldAlert className="h-7 w-7" /></span>
          <p className="mt-5 text-xs font-bold uppercase tracking-[0.18em] text-red-600">Mandatory Android update</p>
          <h1 className="mt-2 text-2xl font-bold">必须更新 OPS 才能继续</h1>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">系统只接受 GitHub 固定发布页中已签名、版本匹配且大小有效的最新 APK。覆盖安装后重新打开 OPS。</p>
          <div className="mt-5 grid grid-cols-2 gap-2">
            <VersionStat label="Installed" value={apkUpdate.installedVersion} />
            <VersionStat label="Required" value={apkUpdate.targetVersion} />
          </div>
          <div className="mt-4 rounded-2xl bg-muted/60 p-3">
            <p className="text-xs font-semibold">{apkUpdate.releaseTitle}</p>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">{apkUpdate.releaseNotes}</p>
          </div>
          {statusText ? <p className="mt-3 rounded-xl bg-amber-50 px-3 py-2 text-xs text-amber-800">{statusText}</p> : null}
          <button type="button" className="mt-5 flex h-12 w-full items-center justify-center rounded-xl bg-red-600 px-4 text-sm font-bold text-white disabled:cursor-not-allowed disabled:opacity-50" disabled={!apkUpdate.releaseReady} onClick={() => openApkDownload(apkUpdate.apkUrl)}>
            {apkUpdate.releaseReady ? <Download className="mr-2 h-5 w-5" /> : <Loader2 className="mr-2 h-5 w-5 animate-spin" />}
            {apkUpdate.releaseReady ? '下载最新签名 APK 并覆盖安装' : '正在等待最新签名 APK'}
          </button>
          <button type="button" className="mt-2 flex h-11 w-full items-center justify-center rounded-xl border px-4 text-sm font-semibold" disabled={checking} onClick={() => window.location.reload()}>
            {checking ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <CheckCircle2 className="mr-2 h-4 w-4" />}安装完成后重新检查
          </button>
          <p className="mt-3 text-center text-[11px] leading-5 text-muted-foreground">旧版保持锁定，不能跳过；OPS 会每 30 秒、回到前台及恢复网络时自动重查。</p>
        </section>
      </div>
    )
  }

  if (android) {
    return statusText ? <div className="chefops-top-notice fixed z-[920] mx-auto max-w-md rounded-xl bg-emerald-50 px-3 py-2 text-center text-xs text-emerald-800 shadow">{statusText}</div> : null
  }

  if (!registration) return null
  return (
    <div className="chefops-viewport-overlay fixed z-[940] flex items-center justify-center bg-black/80 p-4">
      <div className="max-h-full w-full max-w-md overflow-y-auto rounded-3xl bg-white p-6 shadow-2xl">
        <RefreshCw className="h-8 w-8 animate-spin text-amber-700" />
        <h2 className="mt-4 text-xl font-bold">正在强制更新 OPS</h2>
        <p className="mt-2 text-sm leading-6 text-slate-600">网站／PWA 已发现新 shell，正在清除旧缓存、接管页面并自动重新载入。</p>
      </div>
    </div>
  )
}

function VersionStat({ label, value }) {
  return <div className="rounded-xl bg-muted p-3"><p className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</p><p className="mt-1 text-sm font-bold">{value || '—'}</p></div>
}
