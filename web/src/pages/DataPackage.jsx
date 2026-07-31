import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, CheckCircle2, DatabaseZap, Download, Loader2, PackageCheck, RefreshCw, ShieldCheck, Trash2 } from 'lucide-react'
import { useAuth } from '@/lib/AuthContext'
import { getAppPackStatus, syncAppPack } from '@/lib/app-pack'
import { Button } from '@/components/ui/button'

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

function stateLabel(value) {
  const state = String(value || '')
  if (state === 'ready') return 'Ready'
  if (state === 'checking') return 'Checking latest package'
  if (state === 'update_required') return 'Update required'
  if (state === 'downloading') return 'Downloading modules'
  if (state === 'saving') return 'Verifying package'
  if (state === 'cleaning') return 'Removing obsolete data'
  if (state === 'error') return 'Update failed'
  return 'Not downloaded'
}

function moduleText(value) {
  return Array.isArray(value) && value.length ? value.join(', ') : 'None'
}

export default function DataPackage() {
  const { user } = useAuth()
  const outletId = String(user?.outlet_id || '').trim()
  const [status, setStatus] = useState(() => getAppPackStatus())
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    const update = (event) => setStatus(event.detail || getAppPackStatus())
    window.addEventListener('chefops:pack-status', update)
    window.addEventListener('chefops:data-pack-updated', update)
    window.addEventListener('chefops:data-pack-update-required', update)
    return () => {
      window.removeEventListener('chefops:pack-status', update)
      window.removeEventListener('chefops:data-pack-updated', update)
      window.removeEventListener('chefops:data-pack-update-required', update)
    }
  }, [])

  const updatePackage = async () => {
    if (!outletId || busy || !navigator.onLine) return
    setBusy(true)
    try {
      await syncAppPack({ outletId, force: true })
    } catch {
      // The permanent status panel below displays the exact package error.
    } finally {
      setStatus(getAppPackStatus())
      setBusy(false)
    }
  }

  const blocking = ['update_required', 'downloading', 'saving', 'cleaning', 'error'].includes(String(status.state || ''))
  const progress = useMemo(() => {
    const completed = Number(status.completed_modules || 0)
    const total = Number(status.total_modules || 0)
    return total > 0 ? `${completed}/${total}` : '—'
  }, [status.completed_modules, status.total_modules])

  return (
    <div className="chefops-page mx-auto w-full max-w-5xl space-y-4 p-4 pb-24">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-bold"><DatabaseZap className="h-5 w-5" /> Data Package</h1>
          <p className="mt-1 text-xs text-muted-foreground">Permanent package status, update history and local cleanup for this outlet.</p>
        </div>
        <Button size="sm" variant="outline" className="shrink-0 rounded-xl" onClick={updatePackage} disabled={busy || !navigator.onLine}>
          {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
          Check update
        </Button>
      </div>

      <section className={`rounded-3xl border p-5 shadow-sm ${blocking ? 'border-amber-300 bg-amber-50/50' : 'border-emerald-200 bg-emerald-50/40'}`}>
        <div className="flex items-start gap-3">
          <span className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl ${blocking ? 'bg-amber-100 text-amber-700' : 'bg-emerald-100 text-emerald-700'}`}>
            {blocking ? <AlertTriangle className="h-6 w-6" /> : <PackageCheck className="h-6 w-6" />}
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold">{blocking ? 'Package attention required' : 'Current package is installed'}</p>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">
              {blocking
                ? 'OPS will keep this page visible until the required modules finish downloading, verification succeeds and obsolete hashes are removed.'
                : 'The active package remains on this device. Only an older module hash is removed after a complete replacement has been verified.'}
            </p>
          </div>
        </div>
      </section>

      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Stat label="Outlet" value={outletId || 'Global'} />
        <Stat label="Status" value={stateLabel(status.state)} />
        <Stat label="Active package" value={status.version || status.current_version || '—'} />
        <Stat label="Data version" value={status.data_version || '—'} />
        <Stat label="Package size" value={bytes(status.total_bytes)} />
        <Stat label="Module progress" value={progress} />
        <Stat label="Old modules removed" value={String(Number(status.deleted_modules || 0))} />
        <Stat label="Last checked" value={dateTime(status.last_checked_at)} />
      </section>

      <section className="rounded-2xl border bg-card p-4">
        <h2 className="text-sm font-semibold">Package contents and cleanup</h2>
        <div className="mt-3 grid gap-3 md:grid-cols-2">
          <Info icon={Download} label="Changed modules" value={moduleText(status.changed_modules)} />
          <Info icon={Trash2} label="Removed modules" value={moduleText(status.removed_modules)} />
          <Info icon={CheckCircle2} label="Generated" value={dateTime(status.generated_at)} />
          <Info icon={ShieldCheck} label="Last installed" value={dateTime(status.last_downloaded_at)} />
        </div>
        {status.warning ? <p className="mt-4 rounded-xl bg-amber-50 px-3 py-2 text-sm text-amber-800">{status.warning}</p> : null}
        {status.error ? <p className="mt-4 rounded-xl bg-red-50 px-3 py-2 text-sm text-red-700">{status.error}</p> : null}
        <Button className="mt-4 h-12 w-full rounded-xl" onClick={updatePackage} disabled={busy || !navigator.onLine}>
          {busy ? <Loader2 className="mr-2 h-5 w-5 animate-spin" /> : <Download className="mr-2 h-5 w-5" />}
          {busy ? stateLabel(status.state) : status.state === 'error' ? 'Retry required package update' : 'Check and download latest package'}
        </Button>
      </section>
    </div>
  )
}

function Stat({ label, value }) {
  return <div className="min-w-0 rounded-2xl border bg-card p-4"><p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</p><p className="mt-1 break-words text-sm font-bold">{value}</p></div>
}

function Info({ icon: Icon, label, value }) {
  return <div className="flex items-start gap-3 rounded-xl bg-muted/50 p-3"><Icon className="mt-0.5 h-4 w-4 shrink-0 text-primary" /><div className="min-w-0"><p className="text-xs font-semibold">{label}</p><p className="mt-1 break-words text-xs leading-5 text-muted-foreground">{value}</p></div></div>
}
