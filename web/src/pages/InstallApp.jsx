import { useEffect, useMemo, useState } from 'react'
import { CheckCircle2, DatabaseZap, Download, Monitor, PackageOpen, RefreshCw, Smartphone, Tablet } from 'lucide-react'
import { opsClient } from '@/api/opsClient'
import { Button } from '@/components/ui/button'
import { canPromptInstall, promptInstall } from '@/lib/install-prompt'
import { getAppPackStatus, syncAppPack } from '@/lib/app-pack'
import { useAuth } from '@/lib/AuthContext'

const MODE_KEY = 'chefops.display.mode'
const RELEASE_FALLBACK = '4.3.0-ops-insights-data-gate'

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

function qr(value) {
  return `https://api.qrserver.com/v1/create-qr-code/?size=240x240&data=${encodeURIComponent(value)}`
}

export default function InstallApp() {
  const { user } = useAuth()
  const outletId = String(user?.outlet_id || '')
  const [release, setRelease] = useState({ app_version: RELEASE_FALLBACK, apk_url: '', production_web_url: '' })
  const [installReady, setInstallReady] = useState(canPromptInstall())
  const [installed, setInstalled] = useState(isStandalone())
  const [mode, setMode] = useState(() => localStorage.getItem(MODE_KEY) || 'auto')
  const [permission, setPermission] = useState(() => ('Notification' in window ? Notification.permission : 'unsupported'))
  const [pack, setPack] = useState(() => getAppPackStatus())
  const [updatingPack, setUpdatingPack] = useState(false)

  useEffect(() => {
    opsClient.app.version().then(setRelease).catch(() => undefined)
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
  const apkQrUrl = useMemo(() => release.apk_url ? qr(release.apk_url) : '', [release.apk_url])
  const selectMode = (value) => { setMode(value); localStorage.setItem(MODE_KEY, value); window.location.reload() }
  const enableNotifications = async () => { if (!('Notification' in window)) return; setPermission(await Notification.requestPermission()) }
  const updateData = async () => {
    setUpdatingPack(true)
    try { await syncAppPack({ outletId, force: true }) } finally { setUpdatingPack(false) }
  }

  const pwaState = installed ? 'Installed' : installReady ? 'Ready to install' : 'Browser menu required'

  return <div className="chefops-page install-page mx-auto space-y-4 pb-24">
    <div><h1 className="text-xl font-bold">Install Stupiak’s Ops</h1><p className="mt-0.5 text-xs text-muted-foreground">One responsive application for phone, tablet and desktop.</p></div>

    <section className="rounded-2xl border border-primary/20 bg-primary/5 p-4 sm:p-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-primary/15 text-primary"><PackageOpen className="h-5 w-5" /></span>
          <div className="min-w-0"><h2 className="font-semibold">Operational data patch</h2><p className="mt-1 text-sm leading-5 text-muted-foreground">Stock, task templates, SOP steps and images, training content, payment methods and food-label rules are stored locally. Only changed modules download later.</p></div>
        </div>
        <Button onClick={updateData} disabled={updatingPack || pack.state === 'downloading'} className="shrink-0"><RefreshCw className={`mr-2 h-4 w-4 ${updatingPack || pack.state === 'downloading' ? 'animate-spin' : ''}`} />Download latest</Button>
      </div>
      <div className="mt-4 grid grid-cols-2 gap-2 lg:grid-cols-6">
        <PackStat label="Status" value={pack.state === 'ready' ? 'Ready' : pack.state || 'Not downloaded'} />
        <PackStat label="Patch version" value={pack.version ? pack.version.slice(0, 12) : '—'} />
        <PackStat label="Download size" value={bytes(pack.total_bytes || release.data_pack_bytes)} />
        <PackStat label="Changed modules" value={Array.isArray(pack.changed_modules) && pack.changed_modules.length ? pack.changed_modules.join(', ') : 'None'} />
        <PackStat label="Generated" value={dateTime(pack.generated_at)} />
        <PackStat label="Last checked" value={dateTime(pack.last_checked_at)} />
      </div>
      {pack.error ? <p className="mt-3 rounded-xl bg-red-50 p-3 text-xs text-red-700">{pack.error}</p> : null}
      <div className="mt-3 grid gap-2 text-[11px] leading-5 text-muted-foreground md:grid-cols-3">
        <TrustLine text="A new device must download its outlet patch before operational pages open." />
        <TrustLine text="Changes made inside the app mark the patch dirty immediately; direct Sheet edits are rebuilt by the scheduled pack publisher." />
        <TrustLine text="The device checks only a small manifest, then downloads modules whose SHA-256 version changed." />
      </div>
    </section>

    <div className="grid gap-4 xl:grid-cols-2">
      <section className="rounded-2xl border border-border bg-card p-5">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0"><span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-primary/15 text-primary"><Smartphone className="h-6 w-6" /></span><h2 className="mt-4 font-semibold">Install Web App (PWA)</h2><p className="mt-1 text-sm leading-6 text-muted-foreground">This is the real browser-installed app: standalone window, service-worker shell, local data patch and device notifications.</p></div>
          <img src={webQrUrl} alt="Open Stupiak’s Ops web app QR code" className="h-28 w-28 self-center rounded-xl border border-border bg-white p-1 sm:self-auto" />
        </div>
        <div className="mt-4 flex items-center justify-between rounded-xl bg-muted/60 px-3 py-2 text-sm"><span>Status</span><span className="font-semibold">{pwaState}</span></div>
        <Button className="mt-3 w-full" disabled={installed || !installReady} onClick={async () => { const result = await promptInstall(); if (result) setInstallReady(false) }}><Download className="mr-2 h-4 w-4" />{installed ? 'Installed on this device' : installReady ? 'Install on this device' : 'Use browser “Install app”'}</Button>
        <Button variant="outline" className="mt-2 w-full" disabled={permission === 'granted'} onClick={enableNotifications}>{permission === 'granted' ? 'Notifications enabled' : 'Enable notifications'}</Button>
      </section>

      <section className="rounded-2xl border border-border bg-card p-5">
        {release.apk_url ? <>
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between"><div><span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-emerald-100 text-emerald-700"><Download className="h-6 w-6" /></span><h2 className="mt-4 font-semibold">Published Android APK</h2><p className="mt-1 text-sm leading-6 text-muted-foreground">A signed release is published. Download on desktop or scan this APK-specific QR code on Android.</p></div><img src={apkQrUrl} alt="Download signed Android APK QR code" className="h-28 w-28 self-center rounded-xl border border-border bg-white p-1 sm:self-auto" /></div>
          <a href={release.apk_url} className="mt-4 flex h-10 items-center justify-center rounded-xl bg-primary px-4 text-sm font-semibold text-primary-foreground"><Download className="mr-2 h-4 w-4" />Download APK {release.apk_version || ''}</a>
        </> : <>
          <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-muted text-muted-foreground"><Download className="h-6 w-6" /></span><h2 className="mt-4 font-semibold">Android APK not published</h2><p className="mt-1 text-sm leading-6 text-muted-foreground">There is currently no signed APK URL in Master → AppSettings, so this card does not show a fake APK button or APK QR code.</p><div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs leading-5 text-amber-900">The repository contains a Capacitor build scaffold, not a verified downloadable release. A real APK requires the Android project, SDK build, signing key, signature verification and a published HTTPS file URL.</div>
        </>}
      </section>
    </div>

    <section className="rounded-2xl border border-border bg-card p-5"><div className="flex items-center gap-2"><Monitor className="h-5 w-5" /><h2 className="font-semibold">Display mode</h2></div><div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">{['auto','desktop','tablet','mobile'].map((value) => <button key={value} onClick={() => selectMode(value)} className={`flex items-center justify-center gap-2 rounded-xl border p-3 text-sm font-medium capitalize ${mode === value ? 'border-primary bg-primary/10 text-primary' : 'border-border'}`}>{value === 'tablet' ? <Tablet className="h-4 w-4" /> : value === 'mobile' ? <Smartphone className="h-4 w-4" /> : <Monitor className="h-4 w-4" />}{value}</button>)}</div></section>
    <section className="rounded-2xl border border-border bg-card p-5"><div className="flex items-center gap-2"><DatabaseZap className="h-5 w-5" /><h2 className="font-semibold">App version</h2></div><p className="mt-3 text-sm">{release.app_version}</p><p className="mt-1 text-xs text-muted-foreground">Data version: {release.data_version || release.app_version}</p>{release.release_notes ? <p className="mt-3 whitespace-pre-line text-sm text-muted-foreground">{release.release_notes}</p> : null}</section>
  </div>
}

function PackStat({ label, value }) { return <div className="min-w-0 rounded-xl bg-background/80 p-3"><p className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</p><p className="mt-1 break-words text-sm font-semibold">{value}</p></div> }
function TrustLine({ text }) { return <div className="flex items-start gap-2 rounded-xl bg-background/60 p-2.5"><CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" /><span>{text}</span></div> }
