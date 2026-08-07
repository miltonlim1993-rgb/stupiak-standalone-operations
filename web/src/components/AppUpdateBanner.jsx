import { useEffect, useRef, useState } from 'react'
import { CheckCircle2, Download, Loader2, RefreshCw, ShieldAlert } from 'lucide-react'
import { opsClient } from '@/api/opsClient'

const CURRENT_RELEASE = '4.5.25'
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
    if (!asset || Number(asset.size || 0) < 1_000_000) return null
    return {
      url: asset.browser_download_url || manifest.apk_url || DEFAULT_APK_URL,
      name: asset.name,
      size: Number(asset.size || 0),
    }
  } catch {
    return null
  }
}

function launchUpdate(url, version) {
  const plugins = window.Capacitor?.Plugins || {}
  const target = cacheBustedUrl(url || DEFAULT_APK_URL, version)
  if (!target) return false
  try {
    if (plugins.AppUpdate?.openUpdate) {
      Promise.resolve(plugins.AppUpdate.openUpdate({ url: target, version })).catch(() => {
        window.location.assign(target)
      })
      return true
    }
  } catch {}
  window.location.assign(target)
  return true
}

export default function AppUpdateBanner() {
  const [state, setState] = useState({ phase: 'idle', current: '', target: '', manifest: null, release: null, error: '' })
  const checking = useRef(false)
  const lastAutoOpen = useRef(0)

  useEffect(() => {
    if (!nativeAndroid()) return undefined
    let stopped = false

    const check = async () => {
      if (checking.current || stopped) return
      checking.current = true
      try {
        const [current, manifest] = await Promise.all([installedVersion(), remoteReleaseManifest()])
        if (stopped) return
        const target = String(manifest.minimum_apk_version || manifest.apk_version || '').trim()
        const required = Boolean(target) && compareVersions(current, target) < 0
        if (!required) {
          setState({ phase: 'current', current, target, manifest, release: null, error: '' })
          return
        }

        setState({ phase: 'checking-release', current, target, manifest, release: null, error: '' })
        const release = await verifiedRelease(manifest, target)
        if (stopped) return
        if (!release) {
          setState({ phase: 'release-pending', current, target, manifest, release: null, error: 'Signed APK is not ready yet. OPS will check again automatically.' })
          return
        }

        setState({ phase: 'update-required', current, target, manifest, release, error: '' })
        if (Date.now() - lastAutoOpen.current >= AUTO_OPEN_COOLDOWN_MS) {
          lastAutoOpen.current = Date.now()
          launchUpdate(release.url, target)
        }
      } catch (error) {
        if (!stopped) setState((current) => ({ ...current, phase: 'error', error: error?.message || 'Unable to check for updates' }))
      } finally {
        checking.current = false
      }
    }

    void check()
    const timer = window.setInterval(() => { void check() }, CHECK_MS)
    window.addEventListener('focus', check)
    document.addEventListener('visibilitychange', check)
    return () => {
      stopped = true
      window.clearInterval(timer)
      window.removeEventListener('focus', check)
      document.removeEventListener('visibilitychange', check)
    }
  }, [])

  if (!nativeAndroid()) return null
  if (['idle', 'current'].includes(state.phase)) return null

  const updating = state.phase === 'checking-release'
  const ready = state.phase === 'update-required' && state.release
  const pending = state.phase === 'release-pending'

  return (
    <div className="fixed inset-x-0 top-0 z-[1200] border-b border-amber-300 bg-amber-50 px-4 pb-3 pt-[calc(.75rem+env(safe-area-inset-top))] text-amber-950 shadow-lg">
      <div className="mx-auto flex max-w-4xl items-start gap-3">
        {updating ? <Loader2 className="mt-0.5 h-5 w-5 shrink-0 animate-spin" /> : pending ? <RefreshCw className="mt-0.5 h-5 w-5 shrink-0" /> : ready ? <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0" /> : <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0" />}
        <div className="min-w-0 flex-1">
          <p className="text-sm font-bold">{ready ? 'OPS 必须更新 / Update required' : pending ? '新版本正在准备 / Release preparing' : '正在检查 OPS 更新'}</p>
          <p className="mt-1 text-xs leading-5">
            {ready
              ? `当前 ${state.current || 'unknown'} → 必须更新至 ${state.target}. ${state.manifest?.release_notes || ''}`
              : pending
                ? `版本 ${state.target} 已要求更新，但签名 APK 尚未完成。系统会自动重试。`
                : state.error || `正在验证 ${state.target || 'latest'} 的签名 APK…`}
          </p>
          {ready ? (
            <button
              type="button"
              onClick={() => launchUpdate(state.release.url, state.target)}
              className="mt-2 inline-flex items-center gap-2 rounded-lg bg-amber-900 px-3 py-2 text-xs font-bold text-white"
            >
              <Download className="h-4 w-4" />立即更新 / Update now
            </button>
          ) : null}
        </div>
      </div>
    </div>
  )
}
