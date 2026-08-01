import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { DatabaseZap, Download, Loader2, ShieldCheck, Trash2 } from 'lucide-react'
import { useAuth } from '@/lib/AuthContext'
import { getAppPackStatus, hasUsableAppPack, syncAppPack } from '@/lib/app-pack'
import { Button } from '@/components/ui/button'

const AUTO_CHECK_INTERVAL_MS = 60_000
const AUTO_FORCE_INTERVAL_MS = 5 * 60_000

function bytes(value) {
  const number = Number(value || 0)
  if (!number) return '—'
  if (number < 1024) return `${number} B`
  if (number < 1024 * 1024) return `${(number / 1024).toFixed(1)} KB`
  return `${(number / 1024 / 1024).toFixed(1)} MB`
}

function statusLabel(status) {
  if (status.state === 'checking') return 'Checking version'
  if (status.state === 'update_required') return 'Update required'
  if (status.state === 'downloading') {
    const completed = Number(status.completed_modules || 0)
    const total = Number(status.total_modules || 0)
    return total > 0 ? `Downloading ${completed}/${total}` : 'Downloading updates'
  }
  if (status.state === 'saving') return 'Verifying and switching version'
  if (status.state === 'cleaning') return 'Removing old package data'
  if (status.state === 'ready') return 'Ready'
  if (status.state === 'error') return 'Retry required'
  return 'Preparing'
}

export default function DataPackGate({ children }) {
  const { user } = useAuth()
  const outletId = String(user?.outlet_id || '').trim()
  const [status, setStatus] = useState(() => getAppPackStatus())
  const [downloading, setDownloading] = useState(false)
  const syncRunning = useRef(false)
  const lastForceAt = useRef(0)
  const ready = useMemo(() => hasUsableAppPack(outletId), [outletId, status])

  const syncLatest = useCallback(async ({ force = false, showBusy = false } = {}) => {
    if (!outletId || syncRunning.current || !navigator.onLine) return
    syncRunning.current = true
    if (showBusy) setDownloading(true)
    try {
      await syncAppPack({ outletId, force })
      if (force) lastForceAt.current = Date.now()
      setStatus(getAppPackStatus())
    } catch {
      setStatus(getAppPackStatus())
    } finally {
      syncRunning.current = false
      if (showBusy) setDownloading(false)
    }
  }, [outletId])

  useEffect(() => {
    const updateStatus = (event) => setStatus(event.detail || getAppPackStatus())
    const updatePack = () => setStatus(getAppPackStatus())
    window.addEventListener('chefops:pack-status', updateStatus)
    window.addEventListener('chefops:data-pack-updated', updatePack)
    window.addEventListener('chefops:data-pack-update-required', updatePack)
    return () => {
      window.removeEventListener('chefops:pack-status', updateStatus)
      window.removeEventListener('chefops:data-pack-updated', updatePack)
      window.removeEventListener('chefops:data-pack-update-required', updatePack)
    }
  }, [])

  useEffect(() => {
    if (!outletId) return undefined

    const check = () => {
      if (!navigator.onLine) return
      const force = Date.now() - lastForceAt.current >= AUTO_FORCE_INTERVAL_MS
      syncLatest({ force })
    }
    const onActive = () => {
      if (document.visibilityState === 'visible') check()
    }

    // A usable local package no longer stops update checks. The installed package
    // remains visible while OPS checks, then changed modules are downloaded and
    // switched atomically without requiring the employee to press Refresh.
    const initial = window.setTimeout(() => syncLatest({ force: true }), 150)
    const interval = window.setInterval(check, AUTO_CHECK_INTERVAL_MS)
    window.addEventListener('focus', onActive)
    window.addEventListener('online', check)
    document.addEventListener('visibilitychange', onActive)
    return () => {
      window.clearTimeout(initial)
      window.clearInterval(interval)
      window.removeEventListener('focus', onActive)
      window.removeEventListener('online', check)
      document.removeEventListener('visibilitychange', onActive)
    }
  }, [outletId, syncLatest])

  if (ready) return children

  const busy = downloading || ['checking', 'update_required', 'downloading', 'saving', 'cleaning'].includes(status.state)
  const requiredUpdate = Boolean(status.current_version && status.version && status.current_version !== status.version)

  return (
    <div className="flex min-h-full w-full items-center justify-center p-4 sm:p-6">
      <section className="w-full max-w-xl rounded-3xl border border-primary/25 bg-card p-5 shadow-sm sm:p-7">
        <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/15 text-primary"><DatabaseZap className="h-7 w-7" /></span>
        <h1 className="mt-5 text-2xl font-bold">{requiredUpdate ? 'Operational package update required' : 'Preparing operational data'}</h1>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">
          {requiredUpdate
            ? 'OPS found a newer published package. The new modules must finish downloading and old unnecessary package files must be removed before work can continue.'
            : 'The app checks the published outlet version automatically and downloads only modules that changed.'}
        </p>
        <div className="mt-5 grid gap-2 sm:grid-cols-3">
          <GateStat label="Outlet" value={outletId || 'Global'} />
          <GateStat label="Status" value={statusLabel(status)} />
          <GateStat label="Patch size" value={bytes(status.total_bytes)} />
        </div>
        {status.current_version && status.version ? (
          <div className="mt-3 grid grid-cols-2 gap-2">
            <GateStat label="Installed package" value={status.current_version} />
            <GateStat label="Required package" value={status.version} />
          </div>
        ) : null}
        {status.state === 'cleaning' ? <div className="mt-4 flex items-center gap-2 rounded-xl bg-slate-100 px-3 py-2 text-sm text-slate-700"><Trash2 className="h-4 w-4" />Deleting obsolete package hashes from this device.</div> : null}
        {status.error ? <p className="mt-4 rounded-xl bg-red-50 px-3 py-2 text-sm text-red-700">{status.error}</p> : null}
        <Button className="mt-5 h-12 w-full rounded-xl" onClick={() => syncLatest({ force: true, showBusy: true })} disabled={busy || !navigator.onLine}>
          {busy ? <Loader2 className="mr-2 h-5 w-5 animate-spin" /> : <Download className="mr-2 h-5 w-5" />}
          {busy ? statusLabel(status) : status.state === 'error' ? 'Retry required update' : 'Download latest package'}
        </Button>
        <div className="mt-4 flex items-start gap-2 text-xs leading-5 text-muted-foreground"><ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" /><span>The currently active package stays intact until every required new module is downloaded and verified. OPS then switches versions and removes obsolete module data.</span></div>
      </section>
    </div>
  )
}

function GateStat({ label, value }) {
  return <div className="rounded-xl bg-muted/60 p-3"><p className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</p><p className="mt-1 truncate text-sm font-semibold">{value}</p></div>
}
