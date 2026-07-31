import { useEffect, useRef, useState } from 'react'
import { CheckCircle2, Download, Loader2, RefreshCw, ShieldAlert } from 'lucide-react'
import { opsClient } from '@/api/opsClient'

const CURRENT_RELEASE = '4.5.3'
const DEFAULT_APK_URL = 'https://github.com/miltonlim1993-rgb/stupiak-standalone-operations/releases/download/android-release-latest/stupiaks-ops-task-sop-alarm.apk'
const DEFAULT_RELEASE_API = 'https://api.github.com/repos/miltonlim1993-rgb/stupiak-standalone-operations/releases/tags/android-release-latest'
const CHECK_MS = 10 * 60_000

function nativeAndroid() {
  const capacitor = window.Capacitor
  return Boolean(
    (capacitor?.isNativePlatform?.() && capacitor?.getPlatform?.() === 'android')
    || window.location.origin === 'https://localhost'
    || window.location.origin === 'capacitor://localhost'
  )
}

function parts(value) {
  return String(value || '')
    .match(/\d+/g)?.map((item) => Number(item)) || [0]
}

function compareVersions(left, right) {
  const a = parts(left)
  const b = parts(right)
  const length = Math.max(a.length, b.length)
  for (let index = 0; index < length; index += 1) {
    const difference = Number(a[index] || 0) - Number(b[index] || 0)
    if (difference) return difference
  }
  return 0
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
  const response = await fetch(`${opsClient.apiBaseUrl}/app-release.json`, {
    cache: 'no-store',
    credentials: 'omit',
  })
  if (!response.ok) throw new Error(`Release manifest unavailable (${response.status})`)
  return response.json()
}

async function verifiedRelease(manifest, targetVersion) {
  const apiUrl = String(manifest.release_api_url || DEFAULT_RELEASE_API)
  try {
    const response = await fetch(`${apiUrl}${apiUrl.includes('?') ? '&' : '?'}_=${Date.now()}`, {
      cache: 'no-store',
      headers: { Accept: 'application/vnd.github+json' },
    })
    if (!response.ok) return null
    const release = await response.json()
    const title = `${release.name || ''} ${release.tag_name || ''}`
    if (!title.includes(targetVersion)) return null
    const asset = (release.assets || []).find((item) => item.name === 'stupiaks-ops-task-sop-alarm.apk')
      || (release.assets || []).find((item) => String(item.name || '').endsWith('.apk'))
    return {
      url: asset?.browser_download_url || manifest.apk_url || DEFAULT_APK_URL,
      title: release.name || `Stupiak's Ops ${targetVersion}`,
    }
  } catch {
    return null
  }
}

async function openApkDownload(url) {
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

export default function AppUpdateBanner() {
  const android = nativeAndroid()
  const [registration, setRegistration] = useState(null)
  const [apkUpdate, setApkUpdate] = useState(null)
  const [checking, setChecking] = useState(false)
  const [statusText, setStatusText] = useState('')
  const checkingRef = useRef(false)

  useEffect(() => {
    if (android || !('serviceWorker' in navigator)) return undefined
    let active = true
    const inspect = async () => {
      const current = await navigator.serviceWorker.getRegistration()
      if (!current || !active) return
      if (current.waiting) setRegistration(current)
      const onUpdate = () => {
        const worker = current.installing
        if (!worker) return
        worker.addEventListener('statechange', () => {
          if (worker.state === 'installed' && navigator.serviceWorker.controller) setRegistration(current)
        })
      }
      current.addEventListener('updatefound', onUpdate)
    }
    inspect()
    return () => { active = false }
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
        const targetVersion = String(
          manifest.minimum_apk_version
          || manifest.apk_version
          || CURRENT_RELEASE,
        ).trim()
        const updateRequired = Boolean(manifest.force_update !== false) && compareVersions(installed, targetVersion) < 0
        if (!updateRequired) {
          setApkUpdate(null)
          setStatusText(userRequested ? `已是最新版本 ${installed}` : '')
          return
        }

        const release = await verifiedRelease(manifest, targetVersion)
        if (cancelled) return
        if (!release) {
          setStatusText(`版本 ${targetVersion} 正在完成签名发布，完成后会自动再次检查。`)
          return
        }
        const update = {
          installedVersion: installed,
          targetVersion,
          apkUrl: release.url,
          releaseTitle: release.title,
          releaseNotes: manifest.release_notes || 'This version is required to continue using OPS.',
        }
        setApkUpdate(update)
        setStatusText('')

        const sessionKey = `chefops.apk-update.opened.${targetVersion}`
        if (sessionStorage.getItem(sessionKey) !== '1') {
          sessionStorage.setItem(sessionKey, '1')
          openApkDownload(update.apkUrl).catch(() => undefined)
        }
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
    check()
    window.addEventListener('online', check)
    document.addEventListener('visibilitychange', onVisible)
    const timer = window.setInterval(check, CHECK_MS)
    return () => {
      cancelled = true
      window.removeEventListener('online', check)
      document.removeEventListener('visibilitychange', onVisible)
      window.clearInterval(timer)
    }
  }, [android])

  if (android && apkUpdate) {
    return (
      <div className="fixed inset-0 z-[240] flex items-center justify-center bg-black/90 p-4 backdrop-blur-sm">
        <section className="w-full max-w-md rounded-3xl border border-red-400/50 bg-background p-5 shadow-2xl sm:p-7">
          <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-red-100 text-red-700"><ShieldAlert className="h-7 w-7" /></span>
          <p className="mt-5 text-xs font-bold uppercase tracking-[0.18em] text-red-600">Mandatory Android update</p>
          <h1 className="mt-2 text-2xl font-bold">必须更新 OPS 才能继续</h1>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">系统检测到新的 APK。旧版本会停在这里，安装新版并重新打开 OPS 后才会解除。</p>
          <div className="mt-5 grid grid-cols-2 gap-2">
            <VersionStat label="Installed" value={apkUpdate.installedVersion} />
            <VersionStat label="Required" value={apkUpdate.targetVersion} />
          </div>
          <div className="mt-4 rounded-2xl bg-muted/60 p-3">
            <p className="text-xs font-semibold">{apkUpdate.releaseTitle}</p>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">{apkUpdate.releaseNotes}</p>
          </div>
          {statusText ? <p className="mt-3 rounded-xl bg-amber-50 px-3 py-2 text-xs text-amber-800">{statusText}</p> : null}
          <button type="button" className="mt-5 flex h-12 w-full items-center justify-center rounded-xl bg-red-600 px-4 text-sm font-bold text-white" onClick={() => openApkDownload(apkUpdate.apkUrl)}>
            <Download className="mr-2 h-5 w-5" />下载并安装新版 APK
          </button>
          <button type="button" className="mt-2 flex h-11 w-full items-center justify-center rounded-xl border px-4 text-sm font-semibold" disabled={checking} onClick={() => window.location.reload()}>
            {checking ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <CheckCircle2 className="mr-2 h-4 w-4" />}安装完成后重新打开 / 检查
          </button>
          <p className="mt-3 text-center text-[11px] leading-5 text-muted-foreground">Android 下载后会显示安装确认。直接覆盖旧版本即可，不需要先删除 App。</p>
        </section>
      </div>
    )
  }

  if (android) {
    return statusText ? <div className="fixed inset-x-3 top-16 z-[90] mx-auto max-w-md rounded-xl bg-emerald-50 px-3 py-2 text-center text-xs text-emerald-800 shadow">{statusText}</div> : null
  }

  if (!registration) return null
  return (
    <div className="fixed inset-x-3 top-16 z-[90] mx-auto flex max-w-md items-center gap-3 rounded-2xl border border-amber-300 bg-amber-50 p-3 shadow-xl">
      <RefreshCw className="h-4 w-4 text-amber-700" />
      <div className="min-w-0 flex-1"><p className="text-sm font-semibold text-amber-900">New app version ready</p><p className="text-xs text-amber-800/75">Reload once to use the latest screens and cached data.</p></div>
      <button type="button" className="rounded-xl bg-amber-900 px-3 py-2 text-xs font-semibold text-white" onClick={() => { registration.waiting?.postMessage({ type: 'SKIP_WAITING' }); window.location.reload() }}>Update</button>
    </div>
  )
}

function VersionStat({ label, value }) {
  return <div className="rounded-xl bg-muted p-3"><p className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</p><p className="mt-1 text-sm font-bold">{value || '—'}</p></div>
}
