import { useEffect, useMemo, useState } from 'react'
import {
  CheckCircle2,
  DatabaseZap,
  Download,
  Info,
  Monitor,
  PackageOpen,
  RefreshCw,
  ShieldCheck,
  Smartphone,
  Tablet,
  WifiOff,
} from 'lucide-react'

import { opsClient } from '@/api/opsClient'
import { Button } from '@/components/ui/button'
import { canPromptInstall, promptInstall } from '@/lib/install-prompt'
import { getAppPackStatus, syncAppPack } from '@/lib/app-pack'
import { useAuth } from '@/lib/AuthContext'

const MODE_KEY = 'chefops.display.mode'
const RELEASE_FALLBACK = '4.6.8-printer-settings-responsive-workspace'
const RELEASE_APK_URL = 'https://github.com/miltonlim1993-rgb/stupiak-standalone-operations/releases/download/android-release-latest/stupiaks-ops-release.apk'

function bytes(value) {
  const number = Number(value || 0)
  if (!number) return '—'
  if (number < 1024) return `${number} B`
  if (number < 1024 * 1024) return `${(number / 1024).toFixed(1)} KB`
  return `${(number / 1024 / 1024).toFixed(1)} MB`
}

function dateTime(value) {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString()
}

function isStandalone() {
  return Boolean(window.matchMedia?.('(display-mode: standalone)').matches || window.navigator.standalone)
}

function isNativeAndroid() {
  const capacitor = window.Capacitor
  return Boolean(
    (capacitor?.isNativePlatform?.() && capacitor?.getPlatform?.() === 'android')
    || window.location.origin === 'https://localhost'
    || window.location.origin === 'capacitor://localhost'
  )
}

function qr(value) {
  return `https://api.qrserver.com/v1/create-qr-code/?size=240x240&data=${encodeURIComponent(value)}`
}

export default function InstallApp() {
  const { user } = useAuth()
  const outletId = String(user?.outlet_id || '')
  const nativeAndroid = isNativeAndroid()
  const [release, setRelease] = useState({
    app_version: RELEASE_FALLBACK,
    apk_url: RELEASE_APK_URL,
    apk_version: 'Signed release',
    production_web_url: '',
  })
  const [installReady, setInstallReady] = useState(canPromptInstall())
  const [installed, setInstalled] = useState(isStandalone())
  const [mode, setMode] = useState(() => localStorage.getItem(MODE_KEY) || 'auto')
  const [permission, setPermission] = useState(() => ('Notification' in window ? Notification.permission : 'unsupported'))
  const [pack, setPack] = useState(() => getAppPackStatus())
  const [updatingPack, setUpdatingPack] = useState(false)

  useEffect(() => {
    opsClient.app.version().then((value) => {
      const publishedApkUrl = String(value?.apk_url || '').trim()
      setRelease({
        ...value,
        apk_url: publishedApkUrl || RELEASE_APK_URL,
        apk_version: value?.apk_version || 'Signed release',
      })
    }).catch(() => undefined)

    const ready = () => setInstallReady(true)
    const onPack = (event) => setPack(event.detail || getAppPackStatus())
    const display = window.matchMedia?.('(display-mode: standalone)')
    const standalone = () => setInstalled(isStandalone())
    window.addEventListener('chefops:install-ready', ready)
    window.addEventListener('chefops:pack-status', onPack)
    window.addEventListener('appinstalled', standalone)
    display?.addEventListener?.('change', standalone)
    return () => {
      window.removeEventListener('chefops:install-ready', ready)
      window.removeEventListener('chefops:pack-status', onPack)
      window.removeEventListener('appinstalled', standalone)
      display?.removeEventListener?.('change', standalone)
    }
  }, [])

  const webUrl = release.production_web_url || window.location.origin
  const webQrUrl = useMemo(() => qr(webUrl), [webUrl])
  const apkQrUrl = useMemo(() => qr(release.apk_url), [release.apk_url])
  const selectMode = (value) => {
    setMode(value)
    localStorage.setItem(MODE_KEY, value)
    window.dispatchEvent(new CustomEvent('chefops:display-mode', { detail: value }))
  }
  const enableNotifications = async () => {
    if (!('Notification' in window)) return
    setPermission(await Notification.requestPermission())
  }
  const updateData = async () => {
    setUpdatingPack(true)
    try {
      await syncAppPack({ outletId, force: true })
    } finally {
      setUpdatingPack(false)
    }
  }

  const pwaState = installed ? 'Installed' : installReady ? 'Ready' : 'Use browser menu'
  const packReady = pack.state === 'ready'

  return (
    <div className="chefops-page install-page mx-auto space-y-5 pb-28">
      <header>
        <h1 className="text-xl font-heading font-bold">Install & update</h1>
        <p className="mt-1 text-sm text-muted-foreground">Choose the app type, update this device and refresh its outlet data.</p>
      </header>

      <section className="overflow-hidden rounded-3xl border border-primary/25 bg-card shadow-sm">
        <div className="border-b border-primary/15 bg-primary/10 px-4 py-3 sm:px-5">
          <div className="flex items-center justify-between gap-3">
            <span className="inline-flex items-center gap-2 text-sm font-semibold"><ShieldCheck className="h-4 w-4 text-primary" />Recommended for Android</span>
            <span className="rounded-full bg-emerald-100 px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide text-emerald-700">Signed release</span>
          </div>
        </div>
        <div className="grid gap-5 p-4 sm:p-5 md:grid-cols-[minmax(0,1fr)_132px] md:items-center">
          <div className="min-w-0">
            <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-primary/15 text-primary"><Smartphone className="h-6 w-6" /></span>
            <h2 className="mt-3 text-lg font-semibold">Stupiak’s Ops Android app</h2>
            <p className="mt-1 text-sm leading-6 text-muted-foreground">Best for staff phones and tablets. Includes direct Wi-Fi/LAN and Bluetooth label printing without opening Android print preview.</p>
            <a href={release.apk_url} className="mt-4 flex h-11 w-full items-center justify-center rounded-xl bg-primary px-4 text-sm font-semibold text-primary-foreground sm:w-fit sm:min-w-56">
              <Download className="mr-2 h-4 w-4" />Download signed APK
            </a>
            <div className="mt-3 flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs leading-5 text-amber-900">
              <Info className="mt-0.5 h-4 w-4 shrink-0" />
              <span>Updating an existing device: install the new APK over the current app. Do not uninstall first, so local device settings and printer selection remain available.</span>
            </div>
          </div>
          <div className="flex flex-col items-center gap-2">
            <img src={apkQrUrl} alt="Download signed Android APK QR code" className="h-32 w-32 rounded-2xl border border-border bg-white p-1.5" />
            <span className="text-center text-[10px] text-muted-foreground">Scan from another Android device</span>
          </div>
        </div>
      </section>

      <section className="rounded-3xl border border-border bg-card p-4 sm:p-5">
        <div className="grid gap-5 md:grid-cols-[minmax(0,1fr)_116px] md:items-center">
          <div className="min-w-0">
            <div className="flex items-center justify-between gap-3">
              <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-muted"><Monitor className="h-5 w-5" /></span>
              <StatusPill good={installed || installReady}>{pwaState}</StatusPill>
            </div>
            <h2 className="mt-3 font-semibold">Web app (PWA)</h2>
            <p className="mt-1 text-sm leading-6 text-muted-foreground">Use this for browser-based access on desktop, iPhone or devices that do not need Android direct printing.</p>
            <div className="mt-4 grid gap-2 sm:grid-cols-2">
              <Button disabled={installed || !installReady} onClick={async () => {
                const result = await promptInstall()
                if (result) setInstallReady(false)
              }}>
                <Download className="mr-2 h-4 w-4" />
                {installed ? 'Installed' : installReady ? 'Install web app' : 'Use browser Install app'}
              </Button>
              <Button variant="outline" disabled={permission === 'granted' || permission === 'unsupported'} onClick={enableNotifications}>
                {permission === 'granted' ? 'Notifications enabled' : permission === 'unsupported' ? 'Notifications unavailable' : 'Enable notifications'}
              </Button>
            </div>
          </div>
          <img src={webQrUrl} alt="Open Stupiak’s Ops web app QR code" className="mx-auto h-28 w-28 rounded-xl border border-border bg-white p-1" />
        </div>
      </section>

      <section className="rounded-3xl border border-border bg-card p-4 sm:p-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex min-w-0 items-start gap-3">
            <span className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl ${packReady ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-700'}`}>
              {packReady ? <PackageOpen className="h-5 w-5" /> : <WifiOff className="h-5 w-5" />}
            </span>
            <div className="min-w-0">
              <h2 className="font-semibold">Offline outlet data</h2>
              <p className="mt-1 text-sm leading-6 text-muted-foreground">Tasks, SOP, stock and label rules are stored on this device. Refresh after operations content is published.</p>
            </div>
          </div>
          <Button onClick={updateData} disabled={updatingPack || pack.state === 'downloading'} className="shrink-0">
            <RefreshCw className={`mr-2 h-4 w-4 ${updatingPack || pack.state === 'downloading' ? 'animate-spin' : ''}`} />Refresh data
          </Button>
        </div>

        <div className="mt-4 grid grid-cols-2 gap-2 lg:grid-cols-4">
          <PackStat label="Status" value={packReady ? 'Ready' : pack.state || 'Not downloaded'} good={packReady} />
          <PackStat label="Version" value={pack.version ? pack.version.slice(0, 12) : '—'} />
          <PackStat label="Download" value={bytes(pack.total_bytes || release.data_pack_bytes)} />
          <PackStat label="Last checked" value={dateTime(pack.last_checked_at)} />
        </div>
        {Array.isArray(pack.changed_modules) && pack.changed_modules.length ? <p className="mt-3 text-xs text-muted-foreground">Updated modules: {pack.changed_modules.join(', ')}</p> : null}
        {pack.error ? <p className="mt-3 rounded-xl bg-red-50 p-3 text-xs text-red-700">{pack.error}</p> : null}
      </section>

      <section className="grid gap-3 md:grid-cols-3">
        <SetupStep number="1" title="Install or update" text="Use the signed APK on Android, or install the PWA from a supported browser." />
        <SetupStep number="2" title="Refresh outlet data" text="Download the latest operational package for the outlet assigned to this account." />
        <SetupStep number="3" title="Set the printer" text="Open More → Label Printer Settings and choose the profile for this device." />
      </section>

      <section className="rounded-3xl border border-border bg-card p-4 sm:p-5">
        <div className="flex items-center gap-2"><Monitor className="h-5 w-5" /><h2 className="font-semibold">Display mode</h2></div>
        <p className="mt-1 text-xs text-muted-foreground">{nativeAndroid ? 'The Android app stays in Mobile mode.' : 'Auto is recommended. Manual modes are useful for checking layouts.'}</p>
        <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
          {['auto', 'desktop', 'tablet', 'mobile'].map((value) => (
            <button
              key={value}
              type="button"
              disabled={nativeAndroid && value !== 'mobile'}
              onClick={() => selectMode(value)}
              className={`flex items-center justify-center gap-2 rounded-xl border p-3 text-sm font-medium capitalize disabled:cursor-not-allowed disabled:opacity-40 ${(nativeAndroid ? value === 'mobile' : mode === value) ? 'border-primary bg-primary/10 text-primary' : 'border-border'}`}
            >
              {value === 'tablet' ? <Tablet className="h-4 w-4" /> : value === 'mobile' ? <Smartphone className="h-4 w-4" /> : <Monitor className="h-4 w-4" />}
              {value}
            </button>
          ))}
        </div>
      </section>

      <section className="rounded-3xl border border-border bg-card p-4 sm:p-5">
        <div className="flex items-center gap-2"><DatabaseZap className="h-5 w-5" /><h2 className="font-semibold">Version details</h2></div>
        <div className="mt-3 grid gap-2 text-sm sm:grid-cols-2">
          <VersionRow label="App" value={release.app_version || RELEASE_FALLBACK} />
          <VersionRow label="Android" value={release.apk_version || 'Signed release'} />
          <VersionRow label="Data" value={release.data_version || pack.version || '—'} />
          <VersionRow label="Last sync" value={dateTime(pack.saved_at || pack.last_checked_at)} />
        </div>
      </section>
    </div>
  )
}

function PackStat({ label, value, good = false }) {
  return <div className="rounded-2xl bg-muted/55 p-3"><p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</p><p className={`mt-1 truncate text-xs font-semibold ${good ? 'text-emerald-700' : ''}`}>{value}</p></div>
}

function SetupStep({ number, title, text }) {
  return <div className="rounded-2xl border border-border bg-card p-4"><div className="flex h-8 w-8 items-center justify-center rounded-full bg-primary text-xs font-bold text-primary-foreground">{number}</div><h2 className="mt-3 text-sm font-semibold">{title}</h2><p className="mt-1 text-xs leading-5 text-muted-foreground">{text}</p></div>
}

function VersionRow({ label, value }) {
  return <div className="flex items-start justify-between gap-3 rounded-xl bg-muted/50 px-3 py-2.5"><span className="text-muted-foreground">{label}</span><span className="max-w-[68%] break-all text-right font-medium">{value}</span></div>
}

function StatusPill({ good, children }) {
  return <span className={`rounded-full px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide ${good ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-700'}`}>{children}</span>
}
