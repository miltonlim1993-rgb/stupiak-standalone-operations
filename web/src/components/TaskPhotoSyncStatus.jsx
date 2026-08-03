import { useEffect, useRef, useState } from 'react'
import { AlertTriangle, CheckCircle2, CloudOff, Loader2, X } from 'lucide-react'

const CLEAR_AFTER_MS = 5000

function messageFor(detail = {}) {
  const state = String(detail.state || '')
  if (state === 'uploading') return { kind: 'busy', text: '照片已取得，正在保存…' }
  if (state === 'committed') return { kind: 'success', text: '照片已显示并保存' }
  if (state === 'queued_offline') return { kind: 'queued', text: '照片已显示，网络恢复后会自动同步' }
  if (state === 'rejected') return { kind: 'error', text: `照片保存失败：${detail.error || '请重新拍摄'}` }
  return null
}

export default function TaskPhotoSyncStatus() {
  const [status, setStatus] = useState(null)
  const timer = useRef(null)

  useEffect(() => {
    const onState = (event) => {
      const next = messageFor(event.detail || {})
      if (!next) return
      window.clearTimeout(timer.current)
      setStatus(next)
      if (next.kind !== 'busy') {
        timer.current = window.setTimeout(() => setStatus(null), CLEAR_AFTER_MS)
      }
    }
    window.addEventListener('chefops:task-photo-sync-state', onState)
    return () => {
      window.clearTimeout(timer.current)
      window.removeEventListener('chefops:task-photo-sync-state', onState)
    }
  }, [])

  if (!status) return null
  const error = status.kind === 'error'
  const queued = status.kind === 'queued'
  const success = status.kind === 'success'

  return (
    <div
      className={`fixed left-1/2 top-28 z-[10030] flex w-[min(92vw,420px)] -translate-x-1/2 items-center gap-3 rounded-2xl border px-4 py-3 text-sm font-semibold shadow-2xl ${error ? 'border-red-300 bg-red-50 text-red-800' : queued ? 'border-sky-300 bg-sky-50 text-sky-900' : success ? 'border-emerald-300 bg-emerald-50 text-emerald-900' : 'border-amber-300 bg-amber-50 text-amber-900'}`}
      role="status"
      aria-live="assertive"
    >
      {error
        ? <AlertTriangle className="h-5 w-5 shrink-0" />
        : queued
          ? <CloudOff className="h-5 w-5 shrink-0" />
          : success
            ? <CheckCircle2 className="h-5 w-5 shrink-0" />
            : <Loader2 className="h-5 w-5 shrink-0 animate-spin" />}
      <span className="min-w-0 flex-1">{status.text}</span>
      {status.kind !== 'busy' ? (
        <button type="button" onClick={() => setStatus(null)} className="rounded-full p-1" aria-label="Close task photo status">
          <X className="h-4 w-4" />
        </button>
      ) : null}
    </div>
  )
}
