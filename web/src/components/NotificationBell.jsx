import { useEffect, useState } from 'react'
import { Bell } from 'lucide-react'
import { Link } from 'react-router-dom'

export default function NotificationBell() {
  const [count, setCount] = useState(() => (window.__chefopsNotifications || []).length)
  useEffect(() => {
    const listener = (event) => setCount((event.detail || []).length)
    window.addEventListener('chefops:notifications', listener)
    return () => window.removeEventListener('chefops:notifications', listener)
  }, [])
  return (
    <Link to="/notifications" className="relative flex h-9 w-9 items-center justify-center rounded-xl border border-border bg-background text-muted-foreground hover:text-foreground" aria-label="Notifications">
      <Bell className="h-4 w-4" />
      {count > 0 ? <span className="absolute -right-1 -top-1 flex min-h-4 min-w-4 items-center justify-center rounded-full bg-red-600 px-1 text-[9px] font-bold text-white">{count > 99 ? '99+' : count}</span> : null}
    </Link>
  )
}
