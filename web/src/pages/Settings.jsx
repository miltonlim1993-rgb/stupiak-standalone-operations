import { useEffect, useState } from 'react'
import { opsClient } from '@/api/opsClient'
import { useAuth } from '@/lib/AuthContext'
import { ROLE_BADGE_CLASSES, ROLE_LABELS, ROLE_LEVEL } from '@/lib/ops-helpers'
import { getStoredTheme, saveTheme, watchSystemTheme } from '@/lib/theme'
import { parseOutletIds, outletLabel } from '@/lib/outlets'
import { Check, CloudCog, Loader2, LogOut, Moon, Save, Sun, User as UserIcon, Monitor } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

const THEME_OPTIONS = [
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'dark', label: 'Dark', icon: Moon },
  { value: 'system', label: 'System', icon: Monitor },
]

export default function Settings() {
  const { user, setUser, logout } = useAuth()
  const isOwner = (ROLE_LEVEL[user?.role] || 0) >= ROLE_LEVEL.owner
  const [profile, setProfile] = useState({ full_name: user?.full_name || '', phone: user?.phone || '', department: user?.department || '' })
  const [outlets, setOutlets] = useState([])
  const [savingProfile, setSavingProfile] = useState(false)
  const [message, setMessage] = useState('')
  const [theme, setTheme] = useState(() => getStoredTheme())
  const [statvara, setStatvara] = useState({ loading: isOwner, configured: false, status: 'not_configured' })

  useEffect(() => {
    setProfile({ full_name: user?.full_name || '', phone: user?.phone || '', department: user?.department || '' })
  }, [user])

  useEffect(() => watchSystemTheme(() => setTheme(getStoredTheme())), [])

  useEffect(() => {
    opsClient.entities.Outlet.list('name', 100).then(setOutlets).catch(() => setOutlets([]))
  }, [])

  useEffect(() => {
    if (!isOwner) return
    opsClient.integrations.Statvara.status()
      .then((result) => setStatvara({ loading: false, ...result }))
      .catch((error) => setStatvara({ loading: false, configured: false, status: 'unavailable', message: error.message }))
  }, [isOwner])

  async function saveProfile() {
    setSavingProfile(true)
    setMessage('')
    try {
      const updated = await opsClient.auth.updateMe(profile)
      setUser(updated)
      setMessage('Profile saved.')
    } catch (error) {
      setMessage(error.message || 'Profile could not be saved')
    } finally {
      setSavingProfile(false)
    }
  }

  function changeTheme(value) {
    saveTheme(value)
    setTheme(value)
  }

  return (
    <div className="p-4 space-y-5 max-w-lg mx-auto">
      <div>
        <h1 className="text-xl font-heading font-bold">Settings</h1>
        <p className="mt-0.5 text-xs text-muted-foreground">Personal preferences and real integrations only.</p>
      </div>

      <Section icon={UserIcon} title="My profile">
        <div className="flex items-center gap-3 mb-3">
          <div className="w-12 h-12 rounded-2xl bg-[#F6B900] flex items-center justify-center text-black font-black text-lg ring-1 ring-black/10">
            {user?.full_name?.charAt(0)?.toUpperCase() || user?.email?.charAt(0)?.toUpperCase()}
          </div>
          <div className="min-w-0">
            <p className="truncate font-medium">{user?.full_name || 'User'}</p>
            <p className="truncate text-xs text-muted-foreground">{user?.email}</p>
            <span className={`inline-block text-[10px] px-1.5 py-0.5 rounded-full mt-1 ${ROLE_BADGE_CLASSES[user?.role] || ''}`}>
              {ROLE_LABELS[user?.role] || user?.role}
            </span>
          </div>
        </div>
        <div className="space-y-3">
          <Field label="Profile name"><Input value={profile.full_name} onChange={(e) => setProfile({ ...profile, full_name: e.target.value })} placeholder="Name shown in tasks and reports" /></Field>
          <Field label="Phone (WhatsApp)"><Input value={profile.phone} onChange={(e) => setProfile({ ...profile, phone: e.target.value })} placeholder="+60123456789" /></Field>
          <Field label="Department / position"><Input value={profile.department} onChange={(e) => setProfile({ ...profile, department: e.target.value })} placeholder="FOH, Kitchen, Supervisor" /></Field>
          <div className="rounded-xl bg-muted/50 p-3">
            <p className="text-xs font-semibold">Assigned outlets</p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {parseOutletIds(user).length ? parseOutletIds(user).map((id) => {
                const outlet = outlets.find((row) => row.id === id)
                return <span key={id} className="rounded-full border border-border bg-background px-2 py-1 text-[10px] font-medium">{outletLabel(outlet, id)}</span>
              }) : <span className="text-xs text-muted-foreground">No outlet assigned</span>}
            </div>
          </div>
          <Button onClick={saveProfile} disabled={savingProfile} size="sm" className="w-full">
            {savingProfile ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Save className="h-4 w-4 mr-2" />} Save profile
          </Button>
        </div>
      </Section>

      <Section icon={Monitor} title="Appearance">
        <div className="grid grid-cols-3 gap-2">
          {THEME_OPTIONS.map(({ value, label, icon: Icon }) => {
            const active = theme === value
            return (
              <button
                type="button"
                key={value}
                onClick={() => changeTheme(value)}
                className={`relative flex flex-col items-center justify-center gap-1.5 rounded-xl border px-2 py-3 text-xs font-medium transition-colors ${active ? 'border-primary bg-primary/15 text-foreground' : 'border-border bg-background text-muted-foreground'}`}
              >
                <Icon className="h-5 w-5" />
                {label}
                {active && <Check className="absolute right-2 top-2 h-3.5 w-3.5 text-primary" />}
              </button>
            )
          })}
        </div>
      </Section>

      {isOwner && (
        <Section icon={CloudCog} title="Statvara integration">
          <div className="flex items-center justify-between rounded-xl border border-border bg-muted/40 px-3 py-3">
            <div>
              <p className="text-sm font-medium">Receipt API</p>
              <p className="mt-0.5 text-xs text-muted-foreground">Reserved for Statvara receipt and sales sync.</p>
            </div>
            <StatusBadge loading={statvara.loading} configured={statvara.configured} />
          </div>
          <p className="mt-3 text-xs leading-5 text-muted-foreground">
            The API base URL and token remain in Cloudflare Worker secrets. They are not saved in Google Sheets or exposed to staff devices.
          </p>
        </Section>
      )}

      {message && <p className="text-sm text-center text-muted-foreground">{message}</p>}
      <Button onClick={logout} variant="outline" className="w-full text-destructive"><LogOut className="h-4 w-4 mr-2" /> Log out</Button>
      <p className="text-center text-xs text-muted-foreground pb-4">Stupiak’s Ops v2.5</p>
    </div>
  )
}

function Section({ icon: Icon, title, children }) {
  return <section className="rounded-2xl border border-border bg-card p-4"><div className="flex items-center gap-2 mb-3"><Icon className="h-4 w-4 text-primary" /><h2 className="font-heading font-semibold text-sm">{title}</h2></div>{children}</section>
}

function Field({ label, children }) {
  return <div className="space-y-1.5"><Label>{label}</Label>{children}</div>
}

function StatusBadge({ loading, configured }) {
  if (loading) return <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
  return <span className={`rounded-full px-2 py-1 text-[10px] font-semibold ${configured ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300' : 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300'}`}>
    {configured ? 'Connected' : 'Not connected'}
  </span>
}
