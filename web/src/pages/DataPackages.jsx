import { useEffect, useMemo, useState } from 'react'
import {
  AlertTriangle,
  ArchiveRestore,
  CheckCircle2,
  CloudDownload,
  Database,
  FileImage,
  Loader2,
  PackageCheck,
  RefreshCw,
  ScanSearch,
  UploadCloud,
} from 'lucide-react'

import { opsClient } from '@/api/opsClient'
import { Button } from '@/components/ui/button'
import { useAuth } from '@/lib/AuthContext'
import {
  dataPackageV2Admin,
  getInstalledDataPackage,
  installLatestDataPackageV2,
} from '@/lib/data-package-v2-runtime'
import { outletLabel } from '@/lib/outlets'

function formatBytes(value = 0) {
  const bytes = Number(value || 0)
  if (!bytes) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  const amount = bytes / (1024 ** index)
  return `${amount.toFixed(index === 0 ? 0 : amount >= 10 ? 1 : 2)} ${units[index]}`
}

function dateTime(value = '') {
  if (!value) return 'Not published'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString()
}

function shortVersion(value = '') {
  return String(value || '').slice(0, 12) || '—'
}

export default function DataPackages() {
  const { user } = useAuth()
  const canPublish = ['manager', 'owner'].includes(String(user?.role || ''))
  const [outlets, setOutlets] = useState([])
  const [outletId, setOutletId] = useState(String(user?.outlet_id || ''))
  const [status, setStatus] = useState(null)
  const [preview, setPreview] = useState(null)
  const [installed, setInstalled] = useState(null)
  const [progress, setProgress] = useState(null)
  const [busy, setBusy] = useState('')
  const [message, setMessage] = useState('')

  const unresolvedMedia = preview?.comparison?.unresolved_media_count || 0
  const changedModules = preview?.comparison?.module_changes || []
  const latestManifest = status?.manifest || null
  const releases = status?.releases || []

  const selectedOutlet = useMemo(
    () => outlets.find((row) => String(row.id) === String(outletId) || String(row.code) === String(outletId)),
    [outlets, outletId],
  )

  async function load(target = outletId) {
    setBusy('load')
    setMessage('')
    try {
      const [outletRows, remoteStatus, localRelease] = await Promise.all([
        outlets.length ? Promise.resolve(outlets) : opsClient.entities.Outlet.list('name', 200),
        dataPackageV2Admin.status(target).catch((error) => {
          if (error.status === 404) return null
          throw error
        }),
        getInstalledDataPackage(target),
      ])
      setOutlets(outletRows || [])
      if (!target && outletRows?.[0]) {
        const initial = outletRows[0].id || outletRows[0].code || ''
        setOutletId(initial)
        setStatus(await dataPackageV2Admin.status(initial).catch(() => null))
        setInstalled(await getInstalledDataPackage(initial))
      } else {
        setStatus(remoteStatus)
        setInstalled(localRelease)
      }
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
      setMessage('This device is now using the latest verified package.')
    } catch (error) {
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
          <Button variant="outline" className="rounded-xl" disabled={!latestManifest || Boolean(busy)} onClick={install}>
            {busy === 'install' ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <CloudDownload className="mr-2 h-4 w-4" />} Install latest
          </Button>
        </div>
        {progress ? <ProgressRow progress={progress} /> : null}
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
  const total = Number(progress.totalBytes || 0)
  const completed = Number(progress.completedBytes || 0)
  const percent = total > 0 ? Math.min(100, Math.round((completed / total) * 100)) : progress.state === 'ready' ? 100 : 0
  return <div className="space-y-2"><div className="flex justify-between text-xs text-muted-foreground"><span>{progress.item?.name || progress.state}</span><span>{percent}%</span></div><div className="h-2 overflow-hidden rounded-full bg-muted"><div className="h-full rounded-full bg-primary transition-all" style={{ width: `${percent}%` }} /></div></div>
}
