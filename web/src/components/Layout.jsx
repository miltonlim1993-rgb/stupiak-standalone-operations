import { useEffect, useMemo, useState } from 'react'
import { Outlet, NavLink } from 'react-router-dom'
import {
  AlertTriangle, CheckSquare, ClipboardList, Home, LayoutGrid,
  Package, Printer, Receipt, Tag, WalletCards,
} from 'lucide-react'
import { useAuth } from '@/lib/AuthContext'
import { ROLE_LABELS } from '@/lib/ops-helpers'
import AppFoundation from '@/components/AppFoundation'
import NotificationBell from '@/components/NotificationBell'
import AppUpdateBanner from '@/components/AppUpdateBanner'
import DataPackGate from '@/components/DataPackGate'

const primaryNav = [
  { to: '/', label: 'Home', icon: Home, end: true },
  { to: '/tasks', label: 'Tasks', icon: CheckSquare },
  { to: '/stock', label: 'Stock', icon: Package },
  { to: '/labels', label: 'Labels', icon: Tag },
  { to: '/close-up', label: 'Close Up', icon: WalletCards },
  { to: '/more', label: 'More', icon: LayoutGrid },
]

const desktopNav = [
  ...primaryNav.slice(0, 3),
  { to: '/labels', label: 'Food Labels', icon: Tag },
  { to: '/labels/settings', label: 'Label Printer Settings', icon: Printer },
  ...primaryNav.slice(4, 5),
  { to: '/urgent', label: 'Issues', icon: AlertTriangle },
  { to: '/receipts', label: 'Receipts & OCR', icon: Receipt },
  { to: '/attendance', label: 'Duty Roster', icon: ClipboardList },
  { to: '/more', label: 'More', icon: LayoutGrid },
]

const MODE_KEY = 'chefops.display.mode'

function nativeAndroid() {
  const capacitor = window.Capacitor
  return Boolean(
    (capacitor?.isNativePlatform?.() && capacitor?.getPlatform?.() === 'android')
    || window.location.origin === 'https://localhost'
    || window.location.origin === 'capacitor://localhost'
  )
}

function installedMobilePwa() {
  return Boolean(
    window.matchMedia?.('(display-mode: standalone)').matches
    && window.matchMedia?.('(max-width: 767px)').matches
  )
}

function initialMode() {
  if (nativeAndroid() || installedMobilePwa()) return 'mobile'
  return localStorage.getItem(MODE_KEY) || 'auto'
}

function navClass({ isActive }) {
  return `chefops-sidebar-link flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition ${isActive ? 'bg-primary text-primary-foreground shadow-sm' : 'text-muted-foreground hover:bg-muted hover:text-foreground'}`
}

export default function Layout() {
  const { user } = useAuth()
  const [mode, setMode] = useState(initialMode)
  const [online, setOnline] = useState(() => navigator.onLine)

  useEffect(() => {
    if (!nativeAndroid()) return
    localStorage.setItem(MODE_KEY, 'mobile')
    setMode('mobile')
  }, [])

  useEffect(() => {
    const onlineHandler = () => setOnline(true)
    const offlineHandler = () => setOnline(false)
    const modeHandler = (event) => {
      if (nativeAndroid()) {
        setMode('mobile')
        return
      }
      const next = String(event?.detail || localStorage.getItem(MODE_KEY) || 'auto')
      setMode(next)
    }
    window.addEventListener('online', onlineHandler)
    window.addEventListener('offline', offlineHandler)
    window.addEventListener('chefops:display-mode', modeHandler)
    return () => {
      window.removeEventListener('online', onlineHandler)
      window.removeEventListener('offline', offlineHandler)
      window.removeEventListener('chefops:display-mode', modeHandler)
    }
  }, [])

  useEffect(() => {
    document.documentElement.dataset.chefopsMode = mode
    return () => { delete document.documentElement.dataset.chefopsMode }
  }, [mode])

  const rootClass = useMemo(() => {
    if (mode === 'mobile') return 'chefops-force-mobile'
    if (mode === 'tablet') return 'chefops-force-tablet'
    if (mode === 'desktop') return 'chefops-force-desktop'
    return 'chefops-mode-auto'
  }, [mode])

  return (
    <div id="chefops-mobile-app" className={`chefops-app min-h-0 overflow-hidden bg-muted/40 ${rootClass}`}>
      <AppFoundation />
      <AppUpdateBanner />
      <div id="chefops-mobile-shell" className="chefops-shell mx-auto flex min-h-0 w-full overflow-hidden bg-background shadow-[0_0_40px_rgba(0,0,0,0.08)]">
        <aside className="chefops-sidebar hidden border-r border-border bg-background p-4">
          <div className="chefops-sidebar-brand flex items-center gap-3 px-2 py-2">
            <Logo />
            <div className="chefops-sidebar-copy min-w-0"><p className="truncate text-lg font-bold">Stupiak’s Ops</p><p className="text-xs text-muted-foreground">Operations workspace</p></div>
          </div>
          <nav className="mt-6 space-y-1.5">
            {desktopNav.map(({ to, label, icon: Icon, end }) => <NavLink key={to} to={to} end={end} className={navClass} title={label}><Icon className="h-4 w-4 shrink-0" /><span className="chefops-sidebar-label">{label}</span></NavLink>)}
          </nav>
          <div className="chefops-sidebar-user mt-auto rounded-2xl border border-border bg-muted/50 p-3">
            <div className="chefops-sidebar-user-copy"><p className="truncate text-sm font-semibold">{user?.full_name || user?.email}</p><p className="mt-1 text-xs text-muted-foreground">{ROLE_LABELS[user?.role] || user?.role}</p></div>
            <p className={`chefops-sidebar-online mt-2 text-[11px] ${online ? 'text-emerald-600' : 'text-amber-600'}`}>{online ? '● Online' : '● Offline · cached data'}</p>
          </div>
        </aside>

        <div id="chefops-mobile-content" className="chefops-content min-h-0 min-w-0 flex-1 overflow-hidden">
          <header id="chefops-mobile-header" className="chefops-app-header z-40 border-b border-border bg-background/95 backdrop-blur">
            <div className="flex h-14 items-center justify-between gap-3 px-4 lg:px-6">
              <div className="chefops-mobile-brand flex min-w-0 items-center gap-2.5">
                <Logo />
                <span className="truncate text-lg font-bold tracking-tight">Stupiak’s Ops</span>
                <span className="rounded-md bg-black px-1.5 py-0.5 text-[9px] font-bold text-white">v17</span>
              </div>
              <div className="chefops-desktop-heading hidden min-w-0"><p className="truncate text-sm font-semibold">{user?.full_name || 'Operations'}</p><p className="text-[11px] text-muted-foreground">{user?.outlet_id || 'All assigned outlets'}</p></div>
              <div className="flex items-center gap-2">
                {!online ? <span className="hidden rounded-full bg-amber-100 px-2 py-1 text-[10px] font-medium text-amber-800 sm:inline">Offline</span> : null}
                <NavLink
                  to="/labels/settings"
                  title="Label Printer Settings · available to all staff"
                  aria-label="Open Label Printer Settings"
                  className={({ isActive }) => `flex h-9 w-9 items-center justify-center rounded-xl border transition ${isActive ? 'border-primary bg-primary text-primary-foreground' : 'border-border bg-background text-foreground hover:bg-muted'}`}
                >
                  <Printer className="h-4 w-4" />
                </NavLink>
                <NotificationBell />
              </div>
            </div>
          </header>

          <main id="chefops-mobile-main" className="chefops-main-scroll min-h-0 min-w-0 overflow-x-hidden overflow-y-auto">
            <DataPackGate><Outlet /></DataPackGate>
          </main>

          <nav id="chefops-mobile-nav" className="chefops-bottom-nav z-50 w-full border-t border-border bg-background/95 pb-[env(safe-area-inset-bottom)] backdrop-blur">
            <div className="flex h-16 items-center justify-around">
              {primaryNav.map(({ to, label, icon: Icon, end }) => (
                <NavLink key={to} to={to} end={end} className={({ isActive }) => `flex min-w-0 flex-1 flex-col items-center gap-0.5 px-1 py-1.5 text-[10px] font-medium ${isActive ? 'text-primary' : 'text-muted-foreground'}`}>
                  <Icon className="h-5 w-5" /><span className="truncate">{label}</span>
                </NavLink>
              ))}
            </div>
          </nav>
        </div>
      </div>
    </div>
  )
}

function Logo() {
  return <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-[#F6B900] shadow-sm ring-1 ring-black/10"><span className="text-sm font-black text-black">S</span></div>
}
