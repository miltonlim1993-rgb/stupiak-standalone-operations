import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Bell, Check, ChevronRight, Loader2 } from 'lucide-react'
import { opsClient } from '@/api/opsClient'
import { Button } from '@/components/ui/button'

export default function Notifications() {
  const navigate = useNavigate()
  const [items, setItems] = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    opsClient.notifications.list({ unreadOnly: false, limit: 100 })
      .then(setItems)
      .catch(() => setItems([]))
      .finally(() => setLoading(false))
  }, [])

  async function read(item, open = false) {
    try { await opsClient.notifications.read(item.id) } catch {}
    setItems((current) => current.map((row) => row.id === item.id ? { ...row, status: 'read', read_at: new Date().toISOString() } : row))
    if (open) navigate(item.target_page || '/')
  }

  return (
    <div className="chefops-page notifications-page mx-auto max-w-2xl space-y-4 p-4 pb-24">
      <div>
        <h1 className="text-xl font-heading font-bold">Notifications</h1>
        <p className="mt-0.5 text-xs text-muted-foreground">Operational notices for your account.</p>
      </div>
      {loading ? <div className="flex justify-center py-12"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div> : null}
      {!loading && !items.length ? (
        <div className="rounded-2xl border border-dashed py-12 text-center text-sm text-muted-foreground">
          <Bell className="mx-auto mb-2 h-9 w-9" /> No notifications
        </div>
      ) : null}
      <div className="space-y-2">
        {items.map((item) => (
          <article key={item.id} className={`rounded-2xl border p-3.5 ${String(item.status || 'unread') === 'unread' ? 'border-amber-200 bg-amber-50' : 'bg-card'}`}>
            <div className="flex items-start gap-3">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-amber-100 text-amber-700"><Bell className="h-4 w-4" /></span>
              <button type="button" onClick={() => read(item, true)} className="min-w-0 flex-1 text-left">
                <p className="text-sm font-semibold">{item.title}</p>
                {item.message ? <p className="mt-1 text-xs leading-5 text-muted-foreground">{item.message}</p> : null}
                <span className="mt-2 inline-flex items-center gap-1 text-[11px] font-medium">{item.action_label || 'Open'} <ChevronRight className="h-3 w-3" /></span>
              </button>
              {String(item.status || 'unread') === 'unread' ? (
                <Button type="button" variant="ghost" size="icon" className="h-8 w-8" onClick={() => read(item, false)} aria-label="Mark as read"><Check className="h-4 w-4" /></Button>
              ) : null}
            </div>
          </article>
        ))}
      </div>
    </div>
  )
}
