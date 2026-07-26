import { useEffect, useMemo, useState } from 'react'
import { Link, Navigate } from 'react-router-dom'
import { opsClient } from '@/api/opsClient'
import { useAuth } from '@/lib/AuthContext'
import { ROLE_LEVEL } from '@/lib/ops-helpers'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  ArrowLeft, Bluetooth, CheckCircle2, Database, HardDriveDownload,
  Loader2, Network, Printer, RotateCcw, Save, Settings2, Smartphone,
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
  ip_address: '',
  port: 9100,
  bluetooth_mode: 'ble',
  bluetooth_device_name: '',
  bluetooth_device_id: '',
  label_width_mm: 40,
  label_height_mm: 30,
  dpi: 203,
  default_copies: 1,
  auto_print: false,
  standby_enabled: false,
  auto_reconnect: true,
  queue_when_offline: true,
  retry_limit: 3,
  is_default: true,
  enabled: true,
  station_mode: 'this_device',
  station_device_name: '',
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
    port: numberValue(profile?.port, 9100),
    label_width_mm: numberValue(profile?.label_width_mm, 40),
    label_height_mm: numberValue(profile?.label_height_mm, 30),
    dpi: numberValue(profile?.dpi, 203),
    default_copies: numberValue(profile?.default_copies, 1),
    retry_limit: numberValue(profile?.retry_limit, 3),
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

export default function LabelPrinterSettings() {
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
    if (form.connection_type === 'network' && !String(form.ip_address || '').trim()) return 'Enter the printer IP address.'
    if (form.connection_type === 'bluetooth' && !String(form.bluetooth_device_name || form.bluetooth_device_id || '').trim()) return 'Enter a Bluetooth device name or ID.'
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
        connection_type: String(form.connection_type || 'system_print'),
        command_language: String(form.command_language || 'browser'),
        ip_address: String(form.ip_address || '').trim(),
        port: numberValue(form.port, 9100),
        bluetooth_mode: String(form.bluetooth_mode || 'ble'),
        bluetooth_device_name: String(form.bluetooth_device_name || '').trim(),
        bluetooth_device_id: String(form.bluetooth_device_id || '').trim(),
        label_width_mm: numberValue(form.label_width_mm, 40),
        label_height_mm: numberValue(form.label_height_mm, 30),
        dpi: numberValue(form.dpi, 203),
        default_copies: numberValue(form.default_copies, 1),
        auto_print: Boolean(form.auto_print),
        standby_enabled: Boolean(form.standby_enabled),
        auto_reconnect: Boolean(form.auto_reconnect),
        queue_when_offline: Boolean(form.queue_when_offline),
        retry_limit: numberValue(form.retry_limit, 3),
        is_default: Boolean(form.is_default),
        enabled: Boolean(form.enabled),
        station_mode: String(form.station_mode || 'this_device'),
        station_device_name: String(form.station_device_name || '').trim(),
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
      setMessage('Printer profile saved to ChefOps Master and this device.')
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
      setError('The app blocked the test-label window.')
      return
    }
    win.document.write(`<!doctype html><html><head><title>Stupiak's Ops Test Label</title><style>
      @page{size:${width}mm ${height}mm;margin:0}*{box-sizing:border-box}body{margin:0;width:${width}mm;height:${height}mm;font-family:Arial,sans-serif;color:#000}.label{height:100%;padding:1.3mm 1.6mm;display:flex;flex-direction:column}.title{font-size:9pt;font-weight:900;border-bottom:.3mm solid #000;padding-bottom:.5mm}.meta{font-size:5.5pt;font-weight:800;margin-top:.5mm}.time{display:grid;grid-template-columns:1fr 1fr;gap:.7mm;margin-top:.7mm}.box{border:.2mm solid #000;padding:.5mm;font-size:5pt}.box strong{display:block;font-size:6pt;margin-top:.4mm}.batch{margin-top:auto;text-align:center;font:700 5pt monospace}
    </style></head><body><div class="label"><div class="title">TEST LABEL</div><div class="meta">${escapeHtml(String(form.connection_type || '').toUpperCase())} • ${escapeHtml(selectedOutlet?.name || selectedOutletId)}</div><div class="time"><div class="box">MADE 14:30<strong>26 JUL 2026</strong></div><div class="box">USE BY 14:30<strong>27 JUL 2026</strong></div></div><div class="batch">BATCH TEST-260726-001</div></div><script>window.onload=()=>setTimeout(()=>window.print(),80)</script></body></html>`)
    win.document.close()
  }

  if (!canManage) return <Navigate to="/labels" replace />

  return (
    <div className="chefops-page mx-auto max-w-2xl space-y-4 p-4">
      <div className="flex items-start gap-3">
        <Button asChild variant="outline" size="icon" className="h-10 w-10 shrink-0"><Link to="/labels"><ArrowLeft className="h-4 w-4" /></Link></Button>
        <div className="min-w-0">
          <h1 className="text-xl font-heading font-bold">Label printer settings</h1>
          <p className="mt-0.5 text-xs text-muted-foreground">Full outlet printer profile for web, PWA and Android devices.</p>
        </div>
      </div>

      {loading ? <div className="flex justify-center py-16"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div> : (
        <>
          <Section icon={Printer} title="Printer profile">
            <Field label="Outlet">
              <select className="h-11 w-full rounded-md border border-input bg-background px-3 text-sm" value={selectedOutletId} onChange={(event) => setSelectedOutletId(event.target.value)}>
                {outlets.map((outlet) => <option key={outlet.id} value={outlet.id}>{outlet.name || outlet.code || outlet.id}</option>)}
              </select>
            </Field>
            <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label="Profile name"><Input value={form.profile_name} onChange={(event) => update('profile_name', event.target.value)} /></Field>
              <Field label="Printer brand"><Input value={form.brand} onChange={(event) => update('brand', event.target.value)} placeholder="Optional" /></Field>
              <Field label="Printer model"><Input value={form.model} onChange={(event) => update('model', event.target.value)} placeholder="Optional" /></Field>
              <Field label="Command language">
                <select className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm" value={form.command_language} onChange={(event) => update('command_language', event.target.value)}>
                  <option value="browser">Browser / system</option>
                  <option value="escpos">ESC/POS</option>
                  <option value="tspl">TSPL</option>
                  <option value="zpl">ZPL</option>
                  <option value="cpcl">CPCL</option>
                </select>
              </Field>
            </div>
          </Section>

          <Section icon={Network} title="Connection">
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
              <ConnectionChoice value="system_print" label="System print" icon={Printer} current={form.connection_type} onSelect={(value) => update('connection_type', value)} />
              <ConnectionChoice value="network" label="Wi-Fi / LAN" icon={Network} current={form.connection_type} onSelect={(value) => update('connection_type', value)} />
              <ConnectionChoice value="bluetooth" label="Bluetooth" icon={Bluetooth} current={form.connection_type} onSelect={(value) => update('connection_type', value)} />
            </div>

            {form.connection_type === 'system_print' && (
              <div className="mt-3 rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-xs leading-5 text-emerald-800">
                Uses the device print sheet. This remains the safest fallback on PWA and APK.
              </div>
            )}

            {form.connection_type === 'network' && (
              <div className="mt-3 grid grid-cols-[minmax(0,1fr)_110px] gap-3">
                <Field label="Printer IP address"><Input value={form.ip_address} onChange={(event) => update('ip_address', event.target.value)} placeholder="192.168.1.50" inputMode="decimal" /></Field>
                <Field label="Port"><Input type="number" min="1" max="65535" value={form.port} onChange={(event) => update('port', event.target.value)} /></Field>
              </div>
            )}

            {form.connection_type === 'bluetooth' && (
              <div className="mt-3 space-y-3">
                <Field label="Bluetooth mode">
                  <select className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm" value={form.bluetooth_mode} onChange={(event) => update('bluetooth_mode', event.target.value)}>
                    <option value="ble">Bluetooth Low Energy</option>
                    <option value="classic">Bluetooth Classic</option>
                    <option value="system">Android paired printer</option>
                  </select>
                </Field>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <Field label="Device name"><Input value={form.bluetooth_device_name} onChange={(event) => update('bluetooth_device_name', event.target.value)} placeholder="Printer name" /></Field>
                  <Field label="Device ID / MAC"><Input value={form.bluetooth_device_id} onChange={(event) => update('bluetooth_device_id', event.target.value)} placeholder="Optional device ID" /></Field>
                </div>
              </div>
            )}
          </Section>

          <Section icon={Settings2} title="Print behavior">
            <div className="overflow-hidden rounded-xl border border-border">
              <CheckRow label="Default food-label printer" checked={form.is_default} onChange={(value) => update('is_default', value)} />
              <CheckRow label="Profile enabled" checked={form.enabled} onChange={(value) => update('enabled', value)} />
              <CheckRow label="Auto print after label creation" checked={form.auto_print} onChange={(value) => update('auto_print', value)} />
              <CheckRow label="Keep printer connection ready" checked={form.standby_enabled} onChange={(value) => update('standby_enabled', value)} />
              <CheckRow label="Reconnect automatically" checked={form.auto_reconnect} onChange={(value) => update('auto_reconnect', value)} />
              <CheckRow label="Queue labels while offline" checked={form.queue_when_offline} onChange={(value) => update('queue_when_offline', value)} />
            </div>
            <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Field label="Width (mm)"><Input type="number" min="1" step="0.1" value={form.label_width_mm} onChange={(event) => update('label_width_mm', event.target.value)} /></Field>
              <Field label="Height (mm)"><Input type="number" min="1" step="0.1" value={form.label_height_mm} onChange={(event) => update('label_height_mm', event.target.value)} /></Field>
              <Field label="DPI"><Input type="number" min="72" value={form.dpi} onChange={(event) => update('dpi', event.target.value)} /></Field>
              <Field label="Copies"><Input type="number" min="1" max="100" value={form.default_copies} onChange={(event) => update('default_copies', event.target.value)} /></Field>
            </div>
            <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label="Retry limit"><Input type="number" min="0" max="20" value={form.retry_limit} onChange={(event) => update('retry_limit', event.target.value)} /></Field>
              <Field label="Station mode">
                <select className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm" value={form.station_mode} onChange={(event) => update('station_mode', event.target.value)}>
                  <option value="this_device">This device</option>
                  <option value="shared_station">Shared print station</option>
                  <option value="outlet_default">Outlet default station</option>
                </select>
              </Field>
            </div>
            {form.station_mode !== 'this_device' && <Field label="Station device name" className="mt-3"><Input value={form.station_device_name} onChange={(event) => update('station_device_name', event.target.value)} placeholder="Kitchen label station" /></Field>}
            <Field label="Notes" className="mt-3"><Input value={form.notes} onChange={(event) => update('notes', event.target.value)} placeholder="Optional" /></Field>
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

          <Section icon={HardDriveDownload} title="Device cache">
            <p className="text-xs leading-5 text-muted-foreground">Changes are cached on this device immediately. Save writes the same profile to ChefOps Master.</p>
            <div className="mt-3 flex items-center justify-between gap-3 rounded-xl bg-muted/50 px-3 py-3 text-xs">
              <span>Local draft</span>
              <span className="text-right font-medium">{cacheSavedAt ? new Date(cacheSavedAt).toLocaleString('en-MY') : 'Not saved yet'}</span>
            </div>
            <Button type="button" variant="outline" className="mt-3 w-full" onClick={resetDraft}><RotateCcw className="mr-2 h-4 w-4" /> Restore server settings</Button>
          </Section>

          {error && <div className="rounded-xl bg-destructive/10 p-3 text-sm text-destructive">{error}</div>}
          {message && <div className="rounded-xl bg-emerald-500/10 p-3 text-sm text-emerald-700">{message}</div>}

          <div className="grid grid-cols-2 gap-2 pb-2">
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
  return <div className="flex items-start justify-between gap-3"><span className="text-muted-foreground">{label}</span><span className={`text-right font-medium ${good ? 'text-emerald-600' : ''}`}>{value}</span></div>
}

function ConnectionChoice({ value, label, icon: Icon, current, onSelect }) {
  const active = current === value
  return (
    <button type="button" onClick={() => onSelect(value)} className={`flex min-h-20 flex-col items-center justify-center gap-2 rounded-xl border p-3 text-center transition ${active ? 'border-primary bg-primary/10 text-foreground' : 'border-border bg-background text-muted-foreground active:bg-muted'}`}>
      <Icon className="h-5 w-5" />
      <span className="text-xs font-semibold">{label}</span>
      {active ? <CheckCircle2 className="h-4 w-4 text-emerald-600" /> : null}
    </button>
  )
}
