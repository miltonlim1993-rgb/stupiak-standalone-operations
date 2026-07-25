import { useEffect, useMemo, useState } from 'react'
import { Link, Navigate } from 'react-router-dom'
import { opsClient } from '@/api/opsClient'
import { useAuth } from '@/lib/AuthContext'
import { ROLE_LEVEL } from '@/lib/ops-helpers'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  ArrowLeft,
  CheckCircle2,
  Database,
  HardDriveDownload,
  Loader2,
  Printer,
  RotateCcw,
  Save,
} from 'lucide-react'

const EMPTY_PROFILE = {
  id: '',
  outlet_id: '',
  purpose: 'food_label',
  profile_name: 'Food Label Printer',
  brand: '',
  model: '',
  connection_type: 'system_print',
  command_language: 'browser',
  label_width_mm: 40,
  label_height_mm: 30,
  dpi: 203,
  default_copies: 1,
  is_default: true,
  enabled: true,
  notes: '',
}

function numberValue(value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}

function profileToForm(profile, outletId) {
  return {
    ...EMPTY_PROFILE,
    ...(profile || {}),
    outlet_id: profile?.outlet_id || outletId || '',
    connection_type: 'system_print',
    command_language: 'browser',
    label_width_mm: numberValue(profile?.label_width_mm, 40),
    label_height_mm: numberValue(profile?.label_height_mm, 30),
    dpi: numberValue(profile?.dpi, 203),
    default_copies: numberValue(profile?.default_copies, 1),
  }
}

function cacheKey(outletId) {
  return `stupiaks_ops.label_printer_draft.${outletId || 'default'}`
}

function readCached(outletId) {
  try {
    const raw = localStorage.getItem(cacheKey(outletId))
    if (!raw) return null
    const parsed = JSON.parse(raw)
    return parsed?.form ? parsed : null
  } catch {
    return null
  }
}

function saveCached(outletId, form) {
  if (!outletId) return
  localStorage.setItem(cacheKey(outletId), JSON.stringify({ saved_at: new Date().toISOString(), form }))
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;')
}

export default function LabelSettings() {
  const { user } = useAuth()
  const canManage = (ROLE_LEVEL[user?.role] || 0) >= ROLE_LEVEL.manager
  const [outlets, setOutlets] = useState([])
  const [profiles, setProfiles] = useState([])
  const [selectedOutletId, setSelectedOutletId] = useState(user?.outlet_id || '')
  const [form, setForm] = useState(() => profileToForm(null, user?.outlet_id || ''))
  const [source, setSource] = useState(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [cacheSavedAt, setCacheSavedAt] = useState('')

  useEffect(() => {
    if (canManage) loadAll()
  }, [canManage])

  useEffect(() => {
    if (!selectedOutletId) return
    const outletProfiles = profiles.filter((row) => row.outlet_id === selectedOutletId && row.purpose === 'food_label')
    const serverProfile = outletProfiles.find((row) => row.is_default) || outletProfiles[0]
    const cached = readCached(selectedOutletId)
    const next = cached?.form
      ? profileToForm({ ...serverProfile, ...cached.form, id: serverProfile?.id || cached.form.id || '' }, selectedOutletId)
      : profileToForm(serverProfile, selectedOutletId)
    setForm(next)
    setCacheSavedAt(cached?.saved_at || '')
    setMessage('')
    setError('')
  }, [selectedOutletId, profiles])

  useEffect(() => {
    if (!selectedOutletId || loading) return
    const timer = window.setTimeout(() => {
      saveCached(selectedOutletId, form)
      setCacheSavedAt(new Date().toISOString())
    }, 250)
    return () => window.clearTimeout(timer)
  }, [form, selectedOutletId, loading])

  async function loadAll() {
    setLoading(true)
    setError('')
    try {
      const [outletRows, profileRows, sourceSummary] = await Promise.all([
        opsClient.entities.Outlet.list('name', 100),
        opsClient.entities.PrinterProfile.filter({ purpose: 'food_label' }, '-is_default,-updated_date', 200),
        opsClient.labels.catalog({ summaryOnly: true }).catch(() => null),
      ])
      setOutlets(outletRows || [])
      setProfiles(profileRows || [])
      setSource(sourceSummary)
      setSelectedOutletId((current) => current || user?.outlet_id || outletRows?.[0]?.id || '')
    } catch (loadError) {
      setError(loadError.message || 'Label settings could not be loaded')
    } finally {
      setLoading(false)
    }
  }

  const selectedOutlet = useMemo(
    () => outlets.find((row) => row.id === selectedOutletId),
    [outlets, selectedOutletId],
  )

  function update(key, value) {
    setForm((current) => ({ ...current, [key]: value }))
    setMessage('')
  }

  function validate() {
    if (!selectedOutletId) return 'Select an outlet.'
    if (!String(form.profile_name || '').trim()) return 'Enter a printer profile name.'
    if (numberValue(form.label_width_mm, 0) <= 0 || numberValue(form.label_height_mm, 0) <= 0) return 'Enter a valid label size.'
    if (numberValue(form.default_copies, 0) < 1) return 'Default copies must be at least 1.'
    return ''
  }

  async function save() {
    const validationError = validate()
    if (validationError) {
      setError(validationError)
      return
    }
    setSaving(true)
    setError('')
    setMessage('')
    try {
      const payload = {
        outlet_id: selectedOutletId,
        purpose: 'food_label',
        profile_name: String(form.profile_name || '').trim(),
        brand: String(form.brand || '').trim(),
        model: String(form.model || '').trim(),
        connection_type: 'system_print',
        command_language: 'browser',
        ip_address: '',
        port: 0,
        bluetooth_mode: '',
        bluetooth_device_name: '',
        bluetooth_device_id: '',
        label_width_mm: numberValue(form.label_width_mm, 40),
        label_height_mm: numberValue(form.label_height_mm, 30),
        dpi: numberValue(form.dpi, 203),
        default_copies: numberValue(form.default_copies, 1),
        auto_print: false,
        standby_enabled: false,
        auto_reconnect: false,
        queue_when_offline: false,
        retry_limit: 0,
        is_default: Boolean(form.is_default),
        enabled: Boolean(form.enabled),
        station_mode: 'this_device',
        station_device_name: '',
        notes: String(form.notes || '').trim(),
      }

      if (payload.is_default) {
        await opsClient.entities.PrinterProfile.updateMany(
          { outlet_id: selectedOutletId, purpose: 'food_label' },
          { is_default: false },
        )
      }

      const saved = form.id
        ? await opsClient.entities.PrinterProfile.update(form.id, payload)
        : await opsClient.entities.PrinterProfile.create(payload)

      const refreshed = await opsClient.entities.PrinterProfile.filter(
        { purpose: 'food_label' },
        '-is_default,-updated_date',
        200,
      )
      setProfiles(refreshed || [])
      const next = profileToForm(saved, selectedOutletId)
      setForm(next)
      saveCached(selectedOutletId, next)
      setCacheSavedAt(new Date().toISOString())
      setMessage('Saved to ChefOps Master and this device cache.')
    } catch (saveError) {
      setError(saveError.message || 'Printer profile could not be saved')
    } finally {
      setSaving(false)
    }
  }

  function resetDraft() {
    localStorage.removeItem(cacheKey(selectedOutletId))
    const outletProfiles = profiles.filter((row) => row.outlet_id === selectedOutletId && row.purpose === 'food_label')
    const serverProfile = outletProfiles.find((row) => row.is_default) || outletProfiles[0]
    setForm(profileToForm(serverProfile, selectedOutletId))
    setCacheSavedAt('')
    setMessage('Local draft cleared. Server settings restored.')
  }

  function previewTestLabel() {
    const width = Math.max(20, numberValue(form.label_width_mm, 40))
    const height = Math.max(15, numberValue(form.label_height_mm, 30))
    const win = window.open('', '_blank', 'width=480,height=640')
    if (!win) {
      setError('The browser blocked the test-label window.')
      return
    }
    win.document.write(`<!doctype html><html><head><title>Stupiak's Ops Test Label</title><style>
      @page{size:${width}mm ${height}mm;margin:0}*{box-sizing:border-box}body{margin:0;width:${width}mm;height:${height}mm;font-family:Arial,sans-serif;color:#000}.label{height:100%;padding:1.3mm 1.6mm;display:flex;flex-direction:column}.title{font-size:9pt;font-weight:900;border-bottom:.3mm solid #000;padding-bottom:.5mm}.meta{font-size:5.5pt;font-weight:800;margin-top:.5mm}.time{display:grid;grid-template-columns:1fr 1fr;gap:.7mm;margin-top:.7mm}.box{border:.2mm solid #000;padding:.5mm;font-size:5pt}.box strong{display:block;font-size:6pt;margin-top:.4mm}.batch{margin-top:auto;text-align:center;font:700 5pt monospace}
    </style></head><body><div class="label"><div class="title">TEST LABEL</div><div class="meta">BROWSER PRINT • ${escapeHtml(selectedOutlet?.name || selectedOutletId)}</div><div class="time"><div class="box">MADE 14:30<strong>24 JUL 2026</strong></div><div class="box">USE BY 14:30<strong>25 JUL 2026</strong></div></div><div class="batch">BATCH TEST-260724-001</div></div><script>window.onload=()=>setTimeout(()=>window.print(),80)</script></body></html>`)
    win.document.close()
  }

  if (!canManage) return <Navigate to="/labels" replace />

  return (
    <div className="mx-auto max-w-lg space-y-4 p-4 pb-24">
      <div className="flex items-start gap-3">
        <Button asChild variant="outline" size="icon" className="h-9 w-9 shrink-0"><Link to="/labels"><ArrowLeft className="h-4 w-4" /></Link></Button>
        <div>
          <h1 className="text-xl font-heading font-bold">Label settings</h1>
          <p className="mt-0.5 text-xs text-muted-foreground">Only settings that work in the current browser-print version are shown.</p>
        </div>
      </div>

      {loading ? <div className="flex justify-center py-16"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div> : (
        <>
          <Section icon={Printer} title="Outlet printer">
            <Field label="Outlet">
              <select className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm" value={selectedOutletId} onChange={(event) => setSelectedOutletId(event.target.value)}>
                {outlets.map((outlet) => <option key={outlet.id} value={outlet.id}>{outlet.name || outlet.code || outlet.id}</option>)}
              </select>
            </Field>
            <div className="mt-3 rounded-xl border border-emerald-200 bg-emerald-50 p-3 dark:border-emerald-900 dark:bg-emerald-950/30">
              <div className="flex items-center gap-2 text-sm font-semibold text-emerald-800 dark:text-emerald-200"><CheckCircle2 className="h-4 w-4" /> Browser / system print</div>
              <p className="mt-1 text-xs leading-5 text-emerald-700/80 dark:text-emerald-300/80">This is the active, tested connection. Wi-Fi, Bluetooth and silent-agent controls are hidden until their adapters exist.</p>
            </div>
            <div className="mt-3 space-y-3">
              <Field label="Profile name"><Input value={form.profile_name} onChange={(event) => update('profile_name', event.target.value)} /></Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Printer brand"><Input value={form.brand} onChange={(event) => update('brand', event.target.value)} placeholder="Optional" /></Field>
                <Field label="Printer model"><Input value={form.model} onChange={(event) => update('model', event.target.value)} placeholder="Optional" /></Field>
              </div>
            </div>
          </Section>

          <Section icon={Database} title="Label rules source">
            {source ? (
              <div className="space-y-2 text-xs">
                <Status label="Status" value="Connected" good />
                <Status label="Products" value={source.summary?.productCount ?? 0} />
                <Status label="Expiry rules" value={source.summary?.ruleCount ?? 0} />
                <Status label="Product tab" value={source.source?.productSheet || 'ProductMaster'} />
                <Status label="Rules tab" value={source.source?.rulesSheet || 'ExpiryRules'} />
              </div>
            ) : <p className="text-sm text-destructive">The label rules source could not be verified.</p>}
          </Section>

          <Section icon={Printer} title="Physical label">
            <div className="grid grid-cols-2 gap-3">
              <Field label="Width (mm)"><Input type="number" min="1" step="0.1" value={form.label_width_mm} onChange={(event) => update('label_width_mm', event.target.value)} /></Field>
              <Field label="Height (mm)"><Input type="number" min="1" step="0.1" value={form.label_height_mm} onChange={(event) => update('label_height_mm', event.target.value)} /></Field>
              <Field label="Default copies"><Input type="number" min="1" max="20" value={form.default_copies} onChange={(event) => update('default_copies', event.target.value)} /></Field>
            </div>
            <div className="mt-3 space-y-2 rounded-xl border border-border">
              <CheckRow label="Default food-label printer" checked={form.is_default} onChange={(value) => update('is_default', value)} />
              <CheckRow label="Profile enabled" checked={form.enabled} onChange={(value) => update('enabled', value)} />
            </div>
            <Field label="Notes" className="mt-3"><Input value={form.notes} onChange={(event) => update('notes', event.target.value)} placeholder="Optional" /></Field>
          </Section>

          <Section icon={HardDriveDownload} title="Device cache">
            <p className="text-xs leading-5 text-muted-foreground">Every change is cached automatically on this device. Saving writes the same profile to ChefOps Master.</p>
            <div className="mt-3 flex items-center justify-between gap-3 rounded-xl bg-muted/50 px-3 py-3 text-xs">
              <span>Local draft</span>
              <span className="font-medium">{cacheSavedAt ? new Date(cacheSavedAt).toLocaleString('en-MY') : 'Not saved yet'}</span>
            </div>
            <Button type="button" variant="outline" className="mt-3 w-full" onClick={resetDraft}><RotateCcw className="mr-2 h-4 w-4" /> Restore server settings</Button>
          </Section>

          {error && <div className="rounded-xl bg-destructive/10 p-3 text-sm text-destructive">{error}</div>}
          {message && <div className="rounded-xl bg-emerald-500/10 p-3 text-sm text-emerald-700 dark:text-emerald-300">{message}</div>}

          <div className="grid grid-cols-2 gap-2">
            <Button variant="outline" onClick={previewTestLabel}><Printer className="mr-2 h-4 w-4" /> Test label</Button>
            <Button onClick={save} disabled={saving}>{saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />} Save</Button>
          </div>
        </>
      )}
    </div>
  )
}

function Section({ icon: Icon, title, children }) {
  return <section className="rounded-2xl border border-border bg-card p-4"><div className="mb-3 flex items-center gap-2"><Icon className="h-4 w-4 text-primary" /><h2 className="text-sm font-semibold">{title}</h2></div>{children}</section>
}

function Field({ label, className = '', children }) {
  return <div className={`space-y-1.5 ${className}`}><Label>{label}</Label>{children}</div>
}

function CheckRow({ label, checked, onChange }) {
  return <label className="flex cursor-pointer items-center justify-between gap-3 border-b border-border p-3 last:border-b-0"><span className="text-sm font-medium">{label}</span><input type="checkbox" checked={Boolean(checked)} onChange={(event) => onChange(event.target.checked)} className="h-5 w-5 accent-[hsl(var(--primary))]" /></label>
}

function Status({ label, value, good = false }) {
  return <div className="flex items-start justify-between gap-3"><span className="text-muted-foreground">{label}</span><span className={`text-right font-medium ${good ? 'text-emerald-600 dark:text-emerald-400' : ''}`}>{value}</span></div>
}
