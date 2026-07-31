import { useEffect, useMemo, useState } from 'react'
import {
  AlertTriangle,
  ArchiveRestore,
  CheckCircle2,
  CloudDownload,
  Database,
  FileImage,
  HardDrive,
  Loader2,
  PackageCheck,
  RefreshCw,
  ScanSearch,
  Smartphone,
  UploadCloud,
} from 'lucide-react'

import { opsClient } from '@/api/opsClient'
import { Button } from '@/components/ui/button'
import { useAuth } from '@/lib/AuthContext'
import { listDataPackageDevices } from '@/lib/data-package-device-state'
import {
  checkDataPackageV2Storage,
  dataPackageV2Admin,
  getInstalledDataPackage,
  installLatestDataPackageV2,
} from '@/lib/data-package-v2-runtime'
import { outletLabel } from '@/lib/outlets'

const DEVICE_ACTIVE_WINDOW_MS = 30 * 24 * 60 * 60_000

function formatBytes(value = 0) {
  const bytes = Number(value || 0)
  if (!bytes) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  const amount = bytes / (1024 ** index)
  return `${amount.toFixed(index === 0 ? 0 : amount >= 10 ? 1 : 2)} ${units[index]}`
}

function dateTime(value = '') {
  if (!value) return 'Not reported'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString()
}

function shortVersion(value = '') {
  return String(value || '').slice(0, 12) || '—'
}

function deviceState(device, latestVersion) {
  const lastSeen = Date.parse(device?.last_seen_at || '')
  const stale = !lastSeen || Date.now() - lastSeen > DEVICE_ACTIVE_WINDOW_MS
  const version = String(device?.data_package_version || '')
  if (!version) return { key: 'missing', label: stale ? 'No package · inactive' : 'No package', className: 'bg-red-100 text-red-800', stale }
  if (latestVersion && version === latestVersion) return { key: 'current', label: stale ? 'Current · inactive' : 'Current', className: stale ? 'bg-slate-100 text-slate-700' : 'bg-emerald-100 text-emerald-800', stale }
  return { key: 'outdated', label: stale ? 'Update required · inactive' : 'Update required', className: 'bg-amber-100 text-amber-800', stale }
}

export default function DataPackages() {
  const { user } = useAuth()
  const canPublish = ['manager', 'owner'].includes(String(user?.role || ''))
  const [outlets, setOutlets] = useState([])
  const [outletId, setOutletId] = useState(String(user?.outlet_id || ''))
  const [status, setStatus] = useState(null)
  const [preview, setPreview] = useState(null)
  const [installed, setInstalled] = useState(null)
  const [deviceReport, setDeviceReport] = useState({ devices: [] })
  const [storagePlan, setStoragePlan] = useState(null)
  const [progress, setProgress] = useState(null)
  const [busy, setBusy] = useState('')
  const [message, setMessage] = useState('')

  const unresolvedMedia = preview?.comparison?.unresolved_media_count || 0
  const changedModules = preview?.comparison?.module_changes || []
  const latestManifest = status?.manifest || null
  const releases = status?.releases || []
  const devices = deviceReport?.devices || []

  const selectedOutlet = useMemo(
    () => outlets.find((row) => String(row.id) === String(outletId) || String(row.code) === String(outletId)),
    [outlets, outletId],
  )

  const coverage = useMemo(() => {
    const latestVersion = String(latestManifest?.version || '')
    const counts = { current: 0, outdated: 0, missing: 0, stale: 0 }
    for (const device of devices) {
      const state = deviceState(device, latestVersion)
      counts[state.key] += 1
      if (state.stale) counts.stale += 1
    }
    const total = devices.length
    return {
      ...counts,
      total,
      percent: total > 0 ? Math.round((counts.current / total) * 100) : 0,
    }
  }, [devices, latestManifest?.version])

  async function load(target = outletId) {
    setBusy('load')
    setMessage('')
    try {
      const outletRows = outlets.length ? outlets : await opsClient.entities.Outlet.list('name', 200)
      const resolvedTarget = target || outletRows?.[0]?.id || outletRows?.[0]?.code || ''
      setOutlets(outletRows || [])
      if (resolvedTarget !== outletId) setOutletId(resolvedTarget)

      if (!resolvedTarget) {
        setStatus(null)
        setInstalled(null)
        setDeviceReport({ devices: [] })
        setStoragePlan(null)
        return
      }

      const [remoteStatus, localRelease, remoteDevices, deviceStorage] = await Promise.all([
        dataPackageV2Admin.status(resolvedTarget).catch((error) => {
          if (error.status === 404) return null
          throw error
        }),
        getInstalledDataPackage(resolvedTarget),
        listDataPackageDevices(resolvedTarget).catch(() => ({ devices: [] })),
        checkDataPackageV2Storage(resolvedTarget).catch(() => null),
      ])
      setStatus(remoteStatus)
      setInstalled(localRelease)
      setDeviceReport(remoteDevices || { devices: [] })
      setStoragePlan(deviceStorage)
    } catch (error) {
      setMessage(error.message || 'Unable to load data package status')
    } finally {
      setBusy('')
    }
  }

  useEffect(() => {
    load(outletId)
  }, [])

  async function changeOutlet(value) {
    setOutletId(value)
    setPreview(null)
    setProgress(null)
    await load(value)
  }

  async function scanChanges() {
    if (!outletId) return
    setBusy('preview')
    setMessage('')
    try {
      const result = await dataPackageV2Admin.preview(outletId)
      setPreview(result)
      setMessage(result.comparison?.changed ? 'Source scan completed. Review the changes before publishing.' : 'No configuration changes were found.')
    } catch (error) {
      setMessage(error.message || 'Unable to preview package changes')
    } finally {
      setBusy('')
    }
  }

  async function publish() {
    if (!preview?.draft_manifest?.version || unresolvedMedia) return
    setBusy('publish')
    setMessage('')
    try {
      const result = await dataPackageV2Admin.publish({
        outletId,
        expectedVersion: preview.draft_manifest.version,
        expectedSourceVersion: preview.source_pack_version,
      })
      setMessage(`Published ${shortVersion(result.manifest?.version)} successfully.`)
      setPreview(null)
      await load(outletId)
    } catch (error) {
      setMessage(error.message || 'Unable to publish data package')
    } finally {
      setBusy('')
    }
  }

  async function install() {
    setBusy('install')
    setMessage('')
    setProgress(null)
    try {
      await installLatestDataPackageV2({
        outletId,
        onProgress: setProgress,
      })
      setInstalled(await getInstalledDataPackage(outletId))
      setStoragePlan(await checkDataPackageV2Storage(outletId).catch(() => null))
      setDeviceReport(await listDataPackageDevices(outletId).catch(() => ({ devices: [] })))
      setMessage('This device is now using the latest verified package.')
    } catch (error) {
      setStoragePlan(error.details || storagePlan)
      setMessage(error.message || 'Unable to install data package on this device')
    } finally {
      setBusy('')
    }
  }

  async function rollback(version) {
    setBusy(`rollback:${version}`)
    setMessage('')
    try {
      await dataPackageV2Admin.rollback({ outletId, version })
      setMessage(`Cloudflare latest pointer rolled back to ${shortVersion(version)}.`)
      await load(outletId)
    } catch (error) {
      setMessage(error.message || 'Unable to roll back release')
    } finally {
      setBusy('')
    }
  }

  if (!canPublish) {
    return (
      <div className="chefops-page mx-auto max-w-lg p-4">
        <div className="rounded-2xl border border-border bg-card p-6 text-center">
          <Database className="mx-auto h-10 w-10 text-muted-foreground" />
          <p className="mt-3 font-semibold">Manager access required</p>
          <p className="mt-1 text-sm text-muted-foreground">Data packages can only be previewed and published by managers or owners.</p>
        </div>
      </div>
    )
  }

  return (
    <div className="chefops-page mx-auto w-full max-w-5xl space-y-4 p-4 pb-28">
      <header>
        <h1 className="flex items-center gap-2 text-xl font-heading font-bold"><PackageCheck className="h-5 w-5" /> Data Packages</h1>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">Google and Statvara are editing sources. Staff devices run only from explicitly published, verified releases.</p>
      </header>

      <section className="rounded-2xl border border-border bg-card p-4">
        <label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Outlet</label>
        <select
          value={outletId}
          onChange={(event) => changeOutlet(event.target.value)}
          className="mt-2 h-11 w-full rounded-xl border border-input bg-background px-3 text-sm"
        >
          <option value="">Select outlet</option>
          {outlets.map((outlet) => (
            <option key={outlet.id || outlet.code} value={outlet.id || outlet.code}>{outletLabel(outlet, outlet.id || outlet.code)}</option>
          ))}
        </select>
      </section>

      {message ? <div className="rounded-xl border border-border bg-muted px-3 py-2 text-sm">{message}</div> : null}

      <div className="grid gap-3 md:grid-cols-3">
        <InfoCard label="Cloudflare release" value={shortVersion(latestManifest?.version)} detail={dateTime(latestManifest?.published_at)} icon={UploadCloud} />
        <InfoCard label="Installed on this device" value={shortVersion(installed?.manifest?.version)} detail={dateTime(installed?.installed_at)} icon={CloudDownload} />
        <InfoCard label="Source status" value={status?.dirty?.dirty ? 'Changes waiting' : 'Published'} detail={status?.dirty?.dirty_at ? dateTime(status.dirty.dirty_at) : `${formatBytes(latestManifest?.total_bytes)} package`} icon={status?.dirty?.dirty ? AlertTriangle : CheckCircle2} />
      </div>

      <section className="space-y-3 rounded-2xl border border-border bg-card p-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="font-semibold">1. Scan and preview</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">Reads the editing source once and calculates the next immutable release. It does not change staff devices.</p>
          </div>
          <Button disabled={!outletId || Boolean(busy)} onClick={scanChanges} variant="outline" className="rounded-xl">
            {busy === 'preview' ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <ScanSearch className="mr-2 h-4 w-4" />} Scan
          </Button>
        </div>

        {preview ? (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-2 text-sm md:grid-cols-4">
              <Metric label="Draft" value={shortVersion(preview.draft_manifest?.version)} />
              <Metric label="Changed modules" value={preview.comparison?.changed_modules?.length || 0} />
              <Metric label="Device download" value={formatBytes(preview.comparison?.download_bytes)} />
              <Metric label="Media waiting" value={unresolvedMedia} warning={unresolvedMedia > 0} />
            </div>

            <div className="overflow-hidden rounded-xl border border-border">
              {changedModules.map((item, index) => (
                <div key={item.name} className={`flex items-center justify-between gap-3 px-3 py-2.5 text-sm ${index ? 'border-t border-border' : ''}`}>
                  <div><p className="font-medium capitalize">{item.name}</p><p className="text-xs text-muted-foreground">{item.previous_records} → {item.next_records} records</p></div>
                  <span className={`rounded-full px-2 py-1 text-[11px] font-semibold ${item.state === 'unchanged' ? 'bg-muted text-muted-foreground' : 'bg-amber-100 text-amber-800'}`}>{item.state}</span>
                </div>
              ))}
            </div>

            {unresolvedMedia ? (
              <div className="rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
                <p className="flex items-center gap-2 font-semibold"><FileImage className="h-4 w-4" /> {unresolvedMedia} Drive image/video files still need packaging</p>
                <p className="mt-1 text-xs leading-5">Publishing is locked until the media publisher downloads, hashes and stores these files in the Published Package Drive folder.</p>
              </div>
            ) : null}
          </div>
        ) : null}
      </section>

      <section className="space-y-3 rounded-2xl border border-border bg-card p-4">
        <div>
          <h2 className="font-semibold">2. Publish release</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">Latest moves only after every module and media object is stored and verified.</p>
        </div>
        <Button className="w-full rounded-xl" disabled={!preview?.comparison?.changed || unresolvedMedia > 0 || Boolean(busy)} onClick={publish}>
          {busy === 'publish' ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <UploadCloud className="mr-2 h-4 w-4" />} Publish Data Package
        </Button>
      </section>

      <section className="space-y-3 rounded-2xl border border-border bg-card p-4">
        <div className="flex items-start justify-between gap-3">
          <div><h2 className="font-semibold">This device</h2><p className="mt-0.5 text-xs text-muted-foreground">Explicit install only. It will not reload an active Task, Stock Count or form.</p></div>
          <Button variant="outline" className="rounded-xl" disabled={!latestManifest || Boolean(busy) || storagePlan?.can_install === false} onClick={install}>
            {busy === 'install' ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <CloudDownload className="mr-2 h-4 w-4" />} Install latest
          </Button>
        </div>
        {storagePlan ? (
          <div className={`rounded-xl border p-3 ${storagePlan.can_install === false ? 'border-red-300 bg-red-50' : 'border-border bg-muted/40'}`}>
            <p className="flex items-center gap-2 text-sm font-semibold"><HardDrive className="h-4 w-4" /> Storage preflight</p>
            <div className="mt-2 grid grid-cols-2 gap-2 text-xs md:grid-cols-4">
              <Metric label="Download" value={formatBytes(storagePlan.download_bytes)} />
              <Metric label="Reused" value={formatBytes(storagePlan.reused_bytes)} />
              <Metric label="Free" value={storagePlan.storage_estimate_supported ? formatBytes(storagePlan.available_bytes) : 'Unknown'} />
              <Metric label="Required" value={formatBytes(storagePlan.required_available_bytes)} warning={storagePlan.can_install === false} />
            </div>
            {storagePlan.large_object_warning ? <p className="mt-2 text-xs text-amber-700">Largest media object: {formatBytes(storagePlan.largest_object?.bytes)}. Keep the app open during download and verification.</p> : null}
          </div>
        ) : null}
        {progress ? <ProgressRow progress={progress} /> : null}
      </section>

      <section className="space-y-3 rounded-2xl border border-border bg-card p-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="flex items-center gap-2 font-semibold"><Smartphone className="h-4 w-4" /> Device update coverage</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">Tracked from Cloudflare KV. Inactive means the device has not reported for more than 30 days.</p>
          </div>
          <Button size="sm" variant="ghost" disabled={Boolean(busy)} onClick={() => load(outletId)}><RefreshCw className="h-4 w-4" /></Button>
        </div>

        <div className="grid grid-cols-2 gap-2 md:grid-cols-5">
          <Metric label="Coverage" value={`${coverage.percent}%`} warning={coverage.total > 0 && coverage.current < coverage.total} />
          <Metric label="Devices" value={coverage.total} />
          <Metric label="Current" value={coverage.current} />
          <Metric label="Need update" value={coverage.outdated + coverage.missing} warning={coverage.outdated + coverage.missing > 0} />
          <Metric label="Inactive" value={coverage.stale} warning={coverage.stale > 0} />
        </div>

        {!devices.length ? (
          <p className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">No device has reported a Data Package v2 version for this outlet yet.</p>
        ) : (
          <div className="overflow-hidden rounded-xl border border-border">
            {devices.map((device, index) => {
              const state = deviceState(device, latestManifest?.version)
              return (
                <div key={device.device_id} className={`flex items-center gap-3 px-3 py-3 ${index ? 'border-t border-border' : ''}`}>
                  <Smartphone className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold">{device.user_name || device.user_email || device.device_id}</p>
                    <p className="truncate text-xs text-muted-foreground">{device.platform || 'unknown platform'} · App {device.app_version || 'unknown'} · Package {shortVersion(device.data_package_version)}</p>
                    <p className="mt-0.5 text-[11px] text-muted-foreground">Last seen {dateTime(device.last_seen_at)}</p>
                  </div>
                  <span className={`shrink-0 rounded-full px-2 py-1 text-[10px] font-semibold ${state.className}`}>{state.label}</span>
                </div>
              )
            })}
          </div>
        )}
      </section>

      <section className="space-y-3 rounded-2xl border border-border bg-card p-4">
        <div className="flex items-center justify-between gap-3">
          <div><h2 className="font-semibold">Release history</h2><p className="mt-0.5 text-xs text-muted-foreground">Cloudflare keeps immutable versions for rollback.</p></div>
          <Button size="sm" variant="ghost" disabled={Boolean(busy)} onClick={() => load(outletId)}><RefreshCw className="h-4 w-4" /></Button>
        </div>
        {!releases.length ? <p className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">No Data Package v2 release yet.</p> : (
          <div className="overflow-hidden rounded-xl border border-border">
            {releases.map((release, index) => {
              const current = release.version === status?.latest?.version
              return (
                <div key={release.version} className={`flex items-center gap-3 px-3 py-3 ${index ? 'border-t border-border' : ''}`}>
                  <ArchiveRestore className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1"><p className="truncate text-sm font-semibold">{shortVersion(release.version)} {current ? '· Current' : ''}</p><p className="text-xs text-muted-foreground">{dateTime(release.published_at)} · {formatBytes(release.total_bytes)}</p></div>
                  {!current ? <Button size="sm" variant="outline" className="h-8 rounded-lg text-xs" disabled={Boolean(busy)} onClick={() => rollback(release.version)}>{busy === `rollback:${release.version}` ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'Rollback'}</Button> : null}
                </div>
              )
            })}
          </div>
        )}
      </section>

      <p className="text-center text-[11px] text-muted-foreground">Selected: {selectedOutlet ? outletLabel(selectedOutlet, outletId) : outletId || 'No outlet'} · Data Package format v2</p>
    </div>
  )
}

function InfoCard({ label, value, detail, icon: Icon }) {
  return <div className="rounded-2xl border border-border bg-card p-4"><div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground"><Icon className="h-4 w-4" /> {label}</div><p className="mt-3 text-lg font-bold">{value}</p><p className="mt-1 truncate text-xs text-muted-foreground">{detail}</p></div>
}

function Metric({ label, value, warning = false }) {
  return <div className={`rounded-xl border p-3 ${warning ? 'border-amber-300 bg-amber-50' : 'border-border bg-muted/40'}`}><p className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</p><p className="mt-1 font-bold">{value}</p></div>
}

function ProgressRow({ progress }) {
  const total = Number(progress.totalBytes || progress.storagePlan?.download_bytes || 0)
  const completed = Number(progress.completedBytes || 0)
  const percent = total > 0 ? Math.min(100, Math.round((completed / total) * 100)) : progress.state === 'ready' ? 100 : 0
  return <div className="space-y-2"><div className="flex justify-between text-xs text-muted-foreground"><span>{progress.item?.name || progress.state}</span><span>{percent}%</span></div><div className="h-2 overflow-hidden rounded-full bg-muted"><div className="h-full rounded-full bg-primary transition-all" style={{ width: `${percent}%` }} /></div></div>
}
