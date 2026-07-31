import { useEffect, useRef, useState } from 'react'
import { DatabaseZap, Download, HardDrive, Loader2, ShieldCheck } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { useAuth } from '@/lib/AuthContext'
import { hasUsableAppPack, syncAppPack } from '@/lib/app-pack'
import {
  getDataPackageV2Status,
  getInstalledDataPackage,
  installLatestDataPackageV2,
} from '@/lib/data-package-v2-runtime'

function bytes(value) {
  const number = Number(value || 0)
  if (!number) return '—'
  if (number < 1024) return `${number} B`
  if (number < 1024 * 1024) return `${(number / 1024).toFixed(1)} KB`
  return `${(number / 1024 / 1024).toFixed(number >= 10 * 1024 * 1024 ? 1 : 2)} MB`
}

function statusLabel(status) {
  if (status.state === 'checking') return 'Checking published release'
  if (status.state === 'preflight') return 'Checking device storage'
  if (status.state === 'downloading') {
    const completed = Number(status.completed_objects || 0)
    const total = Number(status.total_objects || 0)
    return total > 0 ? `Downloading ${completed}/${total}` : 'Downloading package'
  }
  if (status.state === 'legacy-ready') return 'Using current operations data'
  if (status.state === 'ready') return 'Verified and ready'
  if (status.state === 'error') return 'Retry required'
  return 'Preparing'
}

function percent(status) {
  const total = Number(status.total_bytes || 0)
  const completed = Number(status.completed_bytes || 0)
  if (status.state === 'ready') return 100
  return total > 0 ? Math.min(100, Math.round((completed / total) * 100)) : 0
}

export default function DataPackGate({ children }) {
  const { user } = useAuth()
  const outletId = String(user?.outlet_id || '').trim()
  const [status, setStatus] = useState(() => getDataPackageV2Status())
  const [ready, setReady] = useState(false)
  const [checkingLocal, setCheckingLocal] = useState(true)
  const [downloading, setDownloading] = useState(false)
  const attemptedOutlet = useRef('')

  const enableLegacy = (reason = 'migration') => {
    if (!hasUsableAppPack(outletId)) return false
    setReady(true)
    setCheckingLocal(false)
    setStatus((current) => ({
      ...current,
      state: 'legacy-ready',
      outlet_id: outletId,
      migration_mode: true,
      migration_reason: reason,
      error: '',
      error_code: '',
      error_details: null,
    }))
    return true
  }

  const checkLocal = async () => {
    if (!outletId) {
      setReady(false)
      setCheckingLocal(false)
      return false
    }
    const installed = await getInstalledDataPackage(outletId)
    const usable = Boolean(installed?.verified && installed?.manifest?.version)
    if (usable) {
      setReady(true)
      setCheckingLocal(false)
      setStatus((current) => ({
        ...current,
        state: 'ready',
        outlet_id: outletId,
        installed_version: installed.manifest.version,
        total_bytes: installed.manifest.total_bytes || current.total_bytes || 0,
        migration_mode: false,
      }))
      return true
    }
    if (enableLegacy(navigator.onLine ? 'v2-not-installed' : 'offline')) return true
    setReady(false)
    setCheckingLocal(false)
    return false
  }

  const download = async () => {
    if (!outletId || downloading) return
    setDownloading(true)
    try {
      await installLatestDataPackageV2({
        outletId,
        onProgress(progress) {
          setStatus((current) => ({
            ...current,
            state: progress.state,
            outlet_id: outletId,
            completed_bytes: progress.completedBytes || 0,
            total_bytes: progress.totalBytes || progress.storagePlan?.download_bytes || current.total_bytes || 0,
            completed_objects: progress.completedObjects || 0,
            total_objects: progress.totalObjects || 0,
            current_object: progress.item?.name || '',
            storage_plan: progress.storagePlan || current.storage_plan || null,
            error: '',
            error_code: '',
            error_details: null,
            migration_mode: false,
          }))
        },
      })
      await checkLocal()
    } catch (error) {
      if (error?.code === 'data_package_v2_not_published') {
        try {
          await syncAppPack({ outletId })
        } catch {}
        if (enableLegacy('v2-not-published')) return
      }
      if (enableLegacy('v2-download-failed')) return
      setReady(false)
      setStatus((current) => ({
        ...current,
        state: 'error',
        outlet_id: outletId,
        error: error.message || 'Unable to install the outlet data package',
        error_code: error.code || '',
        error_details: error.details || null,
      }))
    } finally {
      setDownloading(false)
    }
  }

  useEffect(() => {
    setCheckingLocal(true)
    checkLocal()
  }, [outletId])

  useEffect(() => {
    const updateStatus = (event) => setStatus(event.detail || getDataPackageV2Status())
    const activated = async (event) => {
      if (String(event?.detail?.outlet_id || '') !== outletId && String(event?.detail?.outlet_id || '') !== 'global') return
      await checkLocal()
    }
    window.addEventListener('chefops:data-package-v2-status', updateStatus)
    window.addEventListener('chefops:data-package-v2-activated', activated)
    return () => {
      window.removeEventListener('chefops:data-package-v2-status', updateStatus)
      window.removeEventListener('chefops:data-package-v2-activated', activated)
    }
  }, [outletId])

  useEffect(() => {
    if (!outletId || checkingLocal || ready || !navigator.onLine || attemptedOutlet.current === outletId) return
    attemptedOutlet.current = outletId
    const timer = window.setTimeout(() => download(), 150)
    return () => window.clearTimeout(timer)
  }, [outletId, checkingLocal, ready])

  if (ready) return children

  const busy = checkingLocal || downloading || ['checking', 'preflight', 'downloading'].includes(status.state)
  const progress = percent(status)
  const storage = status.storage_plan || status.error_details || null

  return (
    <div className="flex min-h-full w-full items-center justify-center p-4 sm:p-6">
      <section className="w-full max-w-xl rounded-3xl border border-primary/25 bg-card p-5 shadow-sm sm:p-7">
        <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/15 text-primary"><DatabaseZap className="h-7 w-7" /></span>
        <h1 className="mt-5 text-2xl font-bold">Preparing outlet operations</h1>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">This first download installs Task, SOP, Stock, Label rules, images and videos as one verified local release. Normal page opening will not search Google.</p>

        <div className="mt-5 grid gap-2 sm:grid-cols-3">
          <GateStat label="Outlet" value={outletId || 'Not assigned'} />
          <GateStat label="Status" value={checkingLocal ? 'Checking this device' : statusLabel(status)} />
          <GateStat label="Download" value={bytes(storage?.download_bytes || status.total_bytes)} />
        </div>

        {storage ? (
          <div className="mt-4 rounded-xl border border-border bg-muted/40 p-3 text-xs leading-5">
            <p className="flex items-center gap-2 font-semibold"><HardDrive className="h-4 w-4" /> Device storage preflight</p>
            <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-muted-foreground">
              <span>Free space</span><span className="text-right font-medium text-foreground">{storage.storage_estimate_supported ? bytes(storage.available_bytes) : 'Device estimate unavailable'}</span>
              <span>Required with reserve</span><span className="text-right font-medium text-foreground">{bytes(storage.required_available_bytes)}</span>
              <span>Reused locally</span><span className="text-right font-medium text-foreground">{bytes(storage.reused_bytes)}</span>
            </div>
            {storage.large_object_warning ? <p className="mt-2 text-amber-700">Large media detected: {bytes(storage.largest_object?.bytes)}. Keep the app open until verification finishes.</p> : null}
          </div>
        ) : null}

        {busy && Number(status.total_bytes || 0) > 0 ? (
          <div className="mt-4 space-y-2">
            <div className="flex justify-between text-xs text-muted-foreground"><span className="truncate">{status.current_object || statusLabel(status)}</span><span>{progress}%</span></div>
            <div className="h-2 overflow-hidden rounded-full bg-muted"><div className="h-full rounded-full bg-primary transition-all" style={{ width: `${progress}%` }} /></div>
            <p className="text-right text-[11px] text-muted-foreground">{bytes(status.completed_bytes)} / {bytes(status.total_bytes)}</p>
          </div>
        ) : null}

        {status.error ? <p className="mt-4 rounded-xl bg-red-50 px-3 py-2 text-sm leading-5 text-red-700">{status.error}</p> : null}
        {!navigator.onLine ? <p className="mt-4 rounded-xl bg-amber-50 px-3 py-2 text-sm text-amber-800">This device has no installed package yet. Connect once to download the published outlet release.</p> : null}

        <Button className="mt-5 h-12 w-full rounded-xl" onClick={download} disabled={busy || !navigator.onLine || !outletId}>
          {busy ? <Loader2 className="mr-2 h-5 w-5 animate-spin" /> : <Download className="mr-2 h-5 w-5" />}
          {busy ? statusLabel(status) : status.state === 'error' ? 'Retry package download' : 'Download operations package'}
        </Button>

        <div className="mt-4 flex items-start gap-2 text-xs leading-5 text-muted-foreground"><ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" /><span>The current release is activated only after every module and media file passes SHA-256 and size verification. A failed download cannot replace a working release.</span></div>
      </section>
    </div>
  )
}

function GateStat({ label, value }) {
  return <div className="rounded-xl bg-muted/60 p-3"><p className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</p><p className="mt-1 truncate text-sm font-semibold">{value}</p></div>
}
