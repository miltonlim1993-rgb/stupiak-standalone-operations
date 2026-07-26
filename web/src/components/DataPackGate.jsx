import { useEffect, useMemo, useRef, useState } from 'react'
import { DatabaseZap, Download, Loader2, ShieldCheck } from 'lucide-react'
import { useAuth } from '@/lib/AuthContext'
import { getAppPackStatus, hasUsableAppPack, syncAppPack } from '@/lib/app-pack'
import { Button } from '@/components/ui/button'

function bytes(value) {
  const number = Number(value || 0)
  if (!number) return '—'
  if (number < 1024) return `${number} B`
  if (number < 1024 * 1024) return `${(number / 1024).toFixed(1)} KB`
  return `${(number / 1024 / 1024).toFixed(1)} MB`
}

function statusLabel(status) {
  if (status.state === 'checking') return 'Checking version'
  if (status.state === 'downloading') {
    const completed = Number(status.completed_modules || 0)
    const total = Number(status.total_modules || status.changed_modules?.length || 0)
    return total ? `Downloading ${completed}/${total}` : 'Downloading'
  }
  if (status.state === 'saving') return 'Saving on device'
  if (status.state === 'ready') return 'Ready'
  if (status.state === 'error') return 'Retry required'
  return 'Preparing'
}

export default function DataPackGate({ children }) {
  const { user } = useAuth()
  const outletId = String(user?.outlet_id || '').trim()
  const [status, setStatus] = useState(() => getAppPackStatus())
  const [downloading, setDownloading] = useState(false)
  const attemptedOutlet = useRef('')
  const ready = useMemo(() => hasUsableAppPack(outletId), [outletId, status])

  const download = async () => {
    if (!outletId || downloading) return
    setDownloading(true)
    try {
      await syncAppPack({ outletId, force: false })
      setStatus(getAppPackStatus())
    } catch {
      setStatus(getAppPackStatus())
    } finally {
      setDownloading(false)
    }
  }

  useEffect(() => {
    const updateStatus = (event) => setStatus(event.detail || getAppPackStatus())
    const updatePack = () => setStatus(getAppPackStatus())
    window.addEventListener('chefops:pack-status', updateStatus)
    window.addEventListener('chefops:data-pack-updated', updatePack)
    return () => {
      window.removeEventListener('chefops:pack-status', updateStatus)
      window.removeEventListener('chefops:data-pack-updated', updatePack)
    }
  }, [])

  useEffect(() => {
    if (!outletId || ready || !navigator.onLine || attemptedOutlet.current === outletId) return
    attemptedOutlet.current = outletId
    const timer = window.setTimeout(() => download(), 150)
    return () => window.clearTimeout(timer)
  }, [outletId, ready])

  if (ready) return children

  const busy = downloading || ['checking', 'downloading', 'saving'].includes(status.state)

  return (
    <div className="flex min-h-full w-full items-center justify-center p-4 sm:p-6">
      <section className="w-full max-w-xl rounded-3xl border border-primary/25 bg-card p-5 shadow-sm sm:p-7">
        <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/15 text-primary"><DatabaseZap className="h-7 w-7" /></span>
        <h1 className="mt-5 text-2xl font-bold">Preparing operational data</h1>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">The app checks the published outlet version automatically and downloads only modules that changed.</p>
        <div className="mt-5 grid gap-2 sm:grid-cols-3">
          <GateStat label="Outlet" value={outletId || 'Global'} />
          <GateStat label="Status" value={statusLabel(status)} />
          <GateStat label="Patch size" value={bytes(status.total_bytes)} />
        </div>
        {status.error ? <p className="mt-4 rounded-xl bg-red-50 px-3 py-2 text-sm text-red-700">{status.error}</p> : null}
        <Button className="mt-5 h-12 w-full rounded-xl" onClick={download} disabled={busy || !navigator.onLine}>
          {busy ? <Loader2 className="mr-2 h-5 w-5 animate-spin" /> : <Download className="mr-2 h-5 w-5" />}
          {busy ? statusLabel(status) : status.state === 'error' ? 'Retry download' : 'Download now'}
        </Button>
        <div className="mt-4 flex items-start gap-2 text-xs leading-5 text-muted-foreground"><ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" /><span>Completed tasks refresh independently. Template, SOP, inventory and label changes use small versioned modules.</span></div>
      </section>
    </div>
  )
}

function GateStat({ label, value }) {
  return <div className="rounded-xl bg-muted/60 p-3"><p className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</p><p className="mt-1 truncate text-sm font-semibold">{value}</p></div>
}
