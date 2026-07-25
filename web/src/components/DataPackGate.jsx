import { useEffect, useMemo, useState } from 'react'
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

export default function DataPackGate({ children }) {
  const { user } = useAuth()
  const outletId = String(user?.outlet_id || '').trim()
  const [status, setStatus] = useState(() => getAppPackStatus())
  const [downloading, setDownloading] = useState(false)
  const ready = useMemo(() => hasUsableAppPack(outletId), [outletId, status])

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

  if (ready) return children

  const download = async () => {
    setDownloading(true)
    try {
      await syncAppPack({ outletId, force: true })
      setStatus(getAppPackStatus())
    } catch {
      setStatus(getAppPackStatus())
    } finally {
      setDownloading(false)
    }
  }

  return (
    <div className="flex min-h-[calc(100dvh-3.5rem)] items-center justify-center p-4 sm:p-6">
      <section className="w-full max-w-xl rounded-3xl border border-primary/25 bg-card p-5 shadow-sm sm:p-7">
        <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/15 text-primary"><DatabaseZap className="h-7 w-7" /></span>
        <h1 className="mt-5 text-2xl font-bold">Download operational data</h1>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">This device has not downloaded the current outlet patch yet. Download it once before opening Tasks, Stock, SOP, Training and Food Labels.</p>
        <div className="mt-5 grid gap-2 sm:grid-cols-3">
          <GateStat label="Outlet" value={outletId || 'Global'} />
          <GateStat label="Status" value={status.state || 'Not downloaded'} />
          <GateStat label="Patch size" value={bytes(status.total_bytes)} />
        </div>
        {status.error ? <p className="mt-4 rounded-xl bg-red-50 px-3 py-2 text-sm text-red-700">{status.error}</p> : null}
        <Button className="mt-5 h-12 w-full rounded-xl" onClick={download} disabled={downloading || status.state === 'downloading'}>
          {downloading || status.state === 'downloading' ? <Loader2 className="mr-2 h-5 w-5 animate-spin" /> : <Download className="mr-2 h-5 w-5" />}
          {downloading || status.state === 'downloading' ? 'Downloading patch…' : 'Download and enter app'}
        </Button>
        <div className="mt-4 flex items-start gap-2 text-xs leading-5 text-muted-foreground"><ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" /><span>After this first download, the app opens from local IndexedDB immediately and only checks a small manifest for changed modules.</span></div>
      </section>
    </div>
  )
}

function GateStat({ label, value }) {
  return <div className="rounded-xl bg-muted/60 p-3"><p className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</p><p className="mt-1 truncate text-sm font-semibold capitalize">{value}</p></div>
}
