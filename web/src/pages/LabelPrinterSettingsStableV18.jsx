import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  ArrowLeft,
  Bluetooth,
  CheckCircle2,
  Loader2,
  Network,
  Plus,
  Printer,
  RefreshCw,
  Save,
  Server,
  Smartphone,
  Trash2,
  Wifi,
} from 'lucide-react'

import { opsClient } from '@/api/opsClient'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useAuth } from '@/lib/AuthContext'
import {
  DEFAULT_PRINTER_HARDWARE,
  clearPrinterDeviceBinding,
  readPrinterDeviceBinding,
  savePrinterDeviceBinding,
  savePrinterProfilesSnapshot,
} from '@/lib/label-printer-profile'
import {
  DEFAULT_PRINTER_TRANSPORT,
  encodePrinterTransportNotes,
  normalizeBridgeUrl,
  normalizePrinterTransportProfile,
  printerRouteLabel,
} from '@/lib/printer-transport-v12'
import {
  isNativeAndroidPrinterRuntime,
  testPrinterProfile,
} from '@/lib/native-label-print'
import { printStableLabelHtmlV18 } from '@/lib/stable-label-print-v18'

const SETTINGS_VERSION = '4.6.16-stable-settings-v18'

function clean(value = '') {
  return String(value ?? '').trim()
}

function numberValue(value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}

function emptyProfile(outletId = '') {
  return {
    id: '',
    outlet_id: outletId,
    purpose: 'food_label',
    profile_name: 'Food Label Printer',
    brand: '4BARCODE',
    model: '4B-2054K',
    connection_type: 'network',
    command_language: 'tspl',
    ip_address: '',
    port: 9100,
    network_protocol: 'raw_tcp',
    lpr_queue: 'lp',
    bluetooth_mode: 'classic',
    bluetooth_device_name: '',
    bluetooth_device_id: '',
    label_width_mm: 40,
    label_height_mm: 30,
    dpi: 203,
    default_copies: 1,
    media_sensor: 'gap',
    gap_mm: 2,
    gap_offset_mm: 0,
    black_mark_mm: 2,
    black_mark_offset_mm: 0,
    darkness: 8,
    print_speed_mm_s: 76,
    x_offset_mm: 0,
    y_offset_mm: 0,
    connection_timeout_ms: 4000,
    retry_limit: 3,
    enabled: true,
    is_default: true,
    station_mode: 'this_device',
    station_device_name: '',
    bridge_url: 'http://127.0.0.1:8787',
    bridge_token: '',
    bridge_transport: 'raw_tcp',
    bridge_queue: '',
    bridge_printer_ip: '',
    bridge_printer_port: 9100,
    bridge_lpr_queue: 'lp',
    ...DEFAULT_PRINTER_HARDWARE,
    ...DEFAULT_PRINTER_TRANSPORT,
    connection_type: 'network',
    command_language: 'tspl',
    label_width_mm: 40,
    label_height_mm: 30,
    dpi: 203,
    gap_mm: 2,
    bridge_url: 'http://127.0.0.1:8787',
    bridge_transport: 'raw_tcp',
  }
}

function toForm(profile, outletId) {
  return {
    ...emptyProfile(outletId),
    ...normalizePrinterTransportProfile(profile || {}, outletId),
    outlet_id: clean(profile?.outlet_id || outletId),
    command_language: 'tspl',
  }
}

function testLabelHtml(profile, outletId) {
  const width = Math.max(20, numberValue(profile.label_width_mm, 40))
  const height = Math.max(15, numberValue(profile.label_height_mm, 30))
  return `<!doctype html><html><head><title>Stupiak's Ops Stable TSPL Test</title><style>@page{size:${width}mm ${height}mm;margin:0}</style></head><body><div class="label"><div class="title">TEST LABEL</div><div class="meta">STABLE TSPL V18 - ${clean(outletId)}</div><div class="time"><div class="box">MADE 11:30<strong>30 JUL 2026</strong></div><div class="box">USE BY 11:30<strong>31 JUL 2026</strong></div></div><div class="batch">${clean(profile.profile_name)} - TEST</div></div></body></html>`
}

export default function LabelPrinterSettingsStableV18() {
  const { user } = useAuth()
  const outletId = clean(user?.outlet_id)
  const nativeAndroid = isNativeAndroidPrinterRuntime()
  const [profiles, setProfiles] = useState([])
  const [selectedId, setSelectedId] = useState('')
  const [form, setForm] = useState(() => emptyProfile(outletId))
  const [binding, setBinding] = useState(() => readPrinterDeviceBinding(outletId))
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')

  const selectedOnDevice = Boolean(form.id && binding.selected_profile_id === form.id)
  const routeText = useMemo(() => {
    if (form.connection_type === 'network' && !nativeAndroid) return `Web Direct ${String(form.network_protocol || 'raw_tcp').toUpperCase()} · ${form.ip_address || 'No printer IP'} via Local Connector`
    return printerRouteLabel(form)
  }, [form, nativeAndroid])

  useEffect(() => { void loadProfiles() }, [outletId])

  async function loadProfiles(preferredId = '') {
    if (!outletId) {
      setLoading(false)
      setError('Your staff account must be assigned to an outlet.')
      return
    }
    setLoading(true)
    setError('')
    try {
      const rows = await opsClient.entities.PrinterProfile.filter(
        { outlet_id: outletId, purpose: 'food_label' },
        '-is_default,-updated_date',
        100,
      )
      const normalized = (rows || []).map((row) => normalizePrinterTransportProfile(row, outletId))
      setProfiles(normalized)
      savePrinterProfilesSnapshot(outletId, rows || [])
      const device = readPrinterDeviceBinding(outletId)
      setBinding(device)
      const selected = normalized.find((row) => row.id === preferredId)
        || normalized.find((row) => row.id === device.selected_profile_id)
        || normalized.find((row) => row.is_default)
        || normalized[0]
        || null
      setSelectedId(selected?.id || '__new__')
      setForm(toForm(selected, outletId))
    } catch (loadError) {
      setError(loadError.message || 'Printer profiles could not be loaded.')
    } finally {
      setLoading(false)
    }
  }

  function update(key, value) {
    setForm((current) => ({ ...current, [key]: value }))
    setMessage('')
    setError('')
  }

  function selectProfile(profile) {
    setSelectedId(profile.id)
    setForm(toForm(profile, outletId))
    setMessage('')
    setError('')
  }

  function newProfile() {
    setSelectedId('__new__')
    setForm({
      ...emptyProfile(outletId),
      profile_name: `Food Label Printer ${profiles.length + 1}`,
      is_default: profiles.length === 0,
    })
    setMessage('New Stable TSPL profile started.')
    setError('')
  }

  function chooseConnection(type) {
    setForm((current) => ({
      ...current,
      connection_type: type,
      command_language: 'tspl',
      bridge_transport: type === 'driver_bridge' ? (current.bridge_transport || 'queue') : current.bridge_transport,
    }))
    setMessage('')
    setError('')
  }

  function validationError() {
    if (!outletId) return 'Your staff account must be assigned to an outlet.'
    if (!clean(form.profile_name)) return 'Enter a profile name.'
    if (form.connection_type === 'system_print') return 'System/Browser Print is disabled for Food Labels because it split labels. Choose Direct Wi-Fi/LAN or PC/Mac Bridge.'
    if (form.connection_type === 'network' && !clean(form.ip_address)) return 'Enter the printer’s own IP address.'
    if (form.connection_type === 'network' && !nativeAndroid && !normalizeBridgeUrl(form.bridge_url)) return 'Web Direct LAN requires the Local Print Connector URL.'
    if (form.connection_type === 'network' && !nativeAndroid && !clean(form.bridge_token)) return 'Enter the Local Print Connector pairing token.'
    if (form.connection_type === 'driver_bridge' && !normalizeBridgeUrl(form.bridge_url)) return 'Enter the Print Bridge URL.'
    if (form.connection_type === 'driver_bridge' && !clean(form.bridge_token)) return 'Enter the Print Bridge pairing token.'
    if (form.connection_type === 'driver_bridge' && form.bridge_transport === 'queue' && !clean(form.bridge_queue)) return 'Enter the installed RAW printer queue name.'
    if (form.connection_type === 'driver_bridge' && form.bridge_transport !== 'queue' && !clean(form.bridge_printer_ip)) return 'Enter the printer IP used by the bridge.'
    if (form.connection_type === 'bluetooth' && !nativeAndroid) return 'Web browsers cannot send Bluetooth Classic SPP RAW TSPL. Use the Android APK.'
    if (form.connection_type === 'bluetooth' && !clean(form.bluetooth_device_name || form.bluetooth_device_id)) return 'Enter the paired Bluetooth printer name or MAC address.'
    if (numberValue(form.label_width_mm, 0) <= 0 || numberValue(form.label_height_mm, 0) <= 0) return 'Enter a valid media size.'
    return ''
  }

  function payload() {
    return {
      outlet_id: outletId,
      purpose: 'food_label',
      profile_name: clean(form.profile_name),
      brand: clean(form.brand),
      model: clean(form.model),
      connection_type: clean(form.connection_type || 'network'),
      command_language: 'tspl',
      ip_address: clean(form.ip_address),
      port: numberValue(form.port, form.network_protocol === 'lpr' ? 515 : 9100),
      bluetooth_mode: 'classic',
      bluetooth_device_name: clean(form.bluetooth_device_name),
      bluetooth_device_id: clean(form.bluetooth_device_id),
      label_width_mm: numberValue(form.label_width_mm, 40),
      label_height_mm: numberValue(form.label_height_mm, 30),
      dpi: numberValue(form.dpi, 203),
      default_copies: numberValue(form.default_copies, 1),
      retry_limit: numberValue(form.retry_limit, 3),
      enabled: Boolean(form.enabled),
      is_default: Boolean(form.is_default),
      station_mode: 'this_device',
      station_device_name: clean(form.station_device_name),
      notes: encodePrinterTransportNotes({ ...form, command_language: 'tspl' }),
    }
  }

  async function save() {
    const problem = validationError()
    if (problem) { setError(problem); return null }
    setSaving(true)
    setError('')
    setMessage('')
    try {
      const next = payload()
      if (next.is_default) {
        await opsClient.entities.PrinterProfile.updateMany(
          { outlet_id: outletId, purpose: 'food_label' },
          { is_default: false },
        )
      }
      const saved = form.id
        ? await opsClient.entities.PrinterProfile.update(form.id, next)
        : await opsClient.entities.PrinterProfile.create(next)
      await loadProfiles(saved.id)
      setMessage('Stable TSPL printer profile saved. This setting is available to all staff in the outlet.')
      return normalizePrinterTransportProfile(saved, outletId)
    } catch (saveError) {
      setError(saveError.message || 'Printer profile could not be saved.')
      return null
    } finally {
      setSaving(false)
    }
  }

  function useOnDevice() {
    if (!form.id) { setError('Save the profile first.'); return }
    const next = savePrinterDeviceBinding(outletId, form.id, form.profile_name)
    setBinding(next)
    setMessage(`This device now uses “${form.profile_name}”.`)
  }

  function followDefault() {
    setBinding(clearPrinterDeviceBinding(outletId))
    setMessage('This device now follows the outlet default printer.')
  }

  async function testConnection() {
    const problem = validationError()
    if (problem) { setError(problem); return }
    setTesting(true)
    setError('')
    setMessage('')
    try {
      if (!nativeAndroid && ['network', 'driver_bridge'].includes(form.connection_type)) {
        const base = normalizeBridgeUrl(form.bridge_url)
        const response = await fetch(`${base}/health`, {
          headers: { 'X-Print-Bridge-Token': clean(form.bridge_token) },
        })
        const data = await response.json().catch(() => null)
        if (!response.ok || data?.ok === false) throw new Error(data?.error || `Local Print Connector failed (${response.status}).`)
        setMessage(`Local Print Connector connected. Ready to send the APK-identical RAW TSPL to ${form.connection_type === 'network' ? `${form.ip_address}:${form.port}` : 'the selected bridge target'}.`)
      } else {
        const result = await testPrinterProfile(form)
        setMessage(`Connected: ${result.printer || routeText}.`)
      }
    } catch (testError) {
      setError(testError.message || 'Printer connection test failed.')
    } finally {
      setTesting(false)
    }
  }

  async function testLabel() {
    const problem = validationError()
    if (problem) { setError(problem); return }
    setTesting(true)
    setError('')
    setMessage('')
    try {
      await printStableLabelHtmlV18(testLabelHtml(form, outletId), { ...form, command_language: 'tspl', enabled: true })
      setMessage(`One Stable TSPL Test Label sent through ${routeText}. No browser page or Raster fallback was used.`)
    } catch (printError) {
      setError(printError.message || 'Stable TSPL Test Label failed.')
    } finally {
      setTesting(false)
    }
  }

  async function remove() {
    if (!form.id || deleting) return
    if (!window.confirm(`Delete “${form.profile_name}”?`)) return
    setDeleting(true)
    setError('')
    try {
      await opsClient.entities.PrinterProfile.delete(form.id)
      if (binding.selected_profile_id === form.id) setBinding(clearPrinterDeviceBinding(outletId))
      await loadProfiles()
      setMessage('Printer profile deleted.')
    } catch (deleteError) {
      setError(deleteError.message || 'Printer profile could not be deleted.')
    } finally {
      setDeleting(false)
    }
  }

  return (
    <div className="chefops-page mx-auto w-full max-w-5xl space-y-4 p-3 pb-32 sm:p-5" data-printer-workspace={SETTINGS_VERSION}>
      <header className="rounded-3xl border border-border bg-card p-4 shadow-sm">
        <div className="flex items-start gap-3">
          <Button asChild variant="outline" size="icon" className="h-10 w-10 shrink-0 rounded-xl"><Link to="/labels"><ArrowLeft className="h-4 w-4" /></Link></Button>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2"><h1 className="text-xl font-bold">标签打印机设置 / Label Printer Settings</h1><Badge>All staff</Badge><Badge>Stable TSPL v18</Badge></div>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">Food Label printing no longer uses browser pages. Android Direct LAN, Web Direct LAN, Bridge and Android Bluetooth all transmit the same RAW TSPL label document.</p>
          </div>
        </div>
      </header>

      {loading ? <div className="flex justify-center py-20"><Loader2 className="h-6 w-6 animate-spin" /></div> : (
        <>
          <section className="rounded-3xl border border-border bg-card p-4 shadow-sm">
            <div className="flex items-center justify-between gap-3"><div><h2 className="font-semibold">Outlet printer profiles</h2><p className="text-xs text-muted-foreground">Outlet: {outletId || 'Not assigned'}</p></div><Button variant="outline" onClick={newProfile}><Plus className="mr-2 h-4 w-4" />New</Button></div>
            <div className="mt-3 flex gap-2 overflow-x-auto pb-1">
              {profiles.map((profile) => <button key={profile.id} type="button" onClick={() => selectProfile(profile)} className={`min-w-56 rounded-2xl border p-3 text-left ${selectedId === profile.id ? 'border-primary bg-primary/10' : 'bg-background'}`}><p className="truncate text-sm font-semibold">{profile.profile_name}</p><p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{printerRouteLabel(profile)}</p><div className="mt-2 flex gap-1">{profile.is_default ? <Badge>Default</Badge> : null}{binding.selected_profile_id === profile.id ? <Badge>This device</Badge> : null}</div></button>)}
            </div>
          </section>

          <section className="rounded-3xl border border-border bg-card p-4 shadow-sm">
            <h2 className="font-semibold">Stable RAW TSPL route</h2>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">System/Browser Print is intentionally removed from Food Labels because it changed page size and split one label across multiple stickers.</p>
            <div className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-3">
              <RouteCard active={form.connection_type === 'network'} icon={Wifi} title="Direct Wi-Fi/LAN" detail={nativeAndroid ? 'Android native TCP/LPR' : 'Web via Local Connector'} onClick={() => chooseConnection('network')} />
              <RouteCard active={form.connection_type === 'driver_bridge'} icon={Server} title="PC/Mac Bridge" detail="RAW queue/TCP/LPR" onClick={() => chooseConnection('driver_bridge')} />
              <RouteCard active={form.connection_type === 'bluetooth'} icon={Bluetooth} title="Bluetooth Classic" detail={nativeAndroid ? 'Android paired SPP' : 'Android APK only'} disabled={!nativeAndroid} onClick={() => chooseConnection('bluetooth')} />
            </div>

            <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label="Profile name"><Input value={form.profile_name} onChange={(event) => update('profile_name', event.target.value)} /></Field>
              <Field label="Printer language"><Input value="TSPL · Stable RAW only" disabled /></Field>
              <Field label="Brand"><Input value={form.brand} onChange={(event) => update('brand', event.target.value)} /></Field>
              <Field label="Model"><Input value={form.model} onChange={(event) => update('model', event.target.value)} /></Field>
            </div>

            {form.connection_type === 'network' ? <div className="mt-4 rounded-2xl border p-4">
              <div className="grid grid-cols-[minmax(0,1fr)_110px] gap-3"><Field label="Printer’s own IP"><Input value={form.ip_address} onChange={(event) => update('ip_address', event.target.value)} placeholder="192.168.1.50" /></Field><Field label="Port"><Input type="number" value={form.port} onChange={(event) => update('port', event.target.value)} /></Field></div>
              <div className="mt-3 grid grid-cols-2 gap-2"><RouteCard active={form.network_protocol === 'raw_tcp'} icon={Wifi} title="Raw TCP" detail="Port 9100" onClick={() => { update('network_protocol', 'raw_tcp'); update('port', 9100) }} /><RouteCard active={form.network_protocol === 'lpr'} icon={Network} title="LPR" detail="Port 515" onClick={() => { update('network_protocol', 'lpr'); update('port', 515) }} /></div>
              {form.network_protocol === 'lpr' ? <div className="mt-3"><Field label="LPR queue"><Input value={form.lpr_queue} onChange={(event) => update('lpr_queue', event.target.value)} /></Field></div> : null}
              {!nativeAndroid ? <div className="mt-4 rounded-2xl border border-blue-200 bg-blue-50 p-3"><p className="text-sm font-semibold text-blue-900">Web Direct LAN connector</p><p className="mt-1 text-xs leading-5 text-blue-800">The browser sends the exact APK RAW TSPL to a small connector on this Windows/macOS computer; the connector opens TCP 9100 to the printer. No print dialog or browser page is used.</p><div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2"><Field label="Local Connector URL"><Input value={form.bridge_url} onChange={(event) => update('bridge_url', event.target.value)} placeholder="http://127.0.0.1:8787" /></Field><Field label="Pairing token"><Input type="password" value={form.bridge_token} onChange={(event) => update('bridge_token', event.target.value)} /></Field></div></div> : null}
            </div> : null}

            {form.connection_type === 'driver_bridge' ? <div className="mt-4 rounded-2xl border p-4"><div className="grid grid-cols-1 gap-3 sm:grid-cols-2"><Field label="Bridge URL"><Input value={form.bridge_url} onChange={(event) => update('bridge_url', event.target.value)} placeholder="http://127.0.0.1:8787" /></Field><Field label="Pairing token"><Input type="password" value={form.bridge_token} onChange={(event) => update('bridge_token', event.target.value)} /></Field></div><div className="mt-3 grid grid-cols-3 gap-2"><RouteCard active={form.bridge_transport === 'queue'} icon={Printer} title="RAW Queue" onClick={() => update('bridge_transport', 'queue')} /><RouteCard active={form.bridge_transport === 'raw_tcp'} icon={Wifi} title="Raw TCP" onClick={() => update('bridge_transport', 'raw_tcp')} /><RouteCard active={form.bridge_transport === 'lpr'} icon={Network} title="LPR" onClick={() => update('bridge_transport', 'lpr')} /></div>{form.bridge_transport === 'queue' ? <div className="mt-3"><Field label="Installed RAW queue name"><Input value={form.bridge_queue} onChange={(event) => update('bridge_queue', event.target.value)} /></Field></div> : <div className="mt-3 grid grid-cols-[minmax(0,1fr)_110px] gap-3"><Field label="Printer IP"><Input value={form.bridge_printer_ip} onChange={(event) => update('bridge_printer_ip', event.target.value)} /></Field><Field label="Port"><Input type="number" value={form.bridge_printer_port} onChange={(event) => update('bridge_printer_port', event.target.value)} /></Field></div>}</div> : null}

            {form.connection_type === 'bluetooth' ? <div className="mt-4 grid grid-cols-1 gap-3 rounded-2xl border p-4 sm:grid-cols-2"><Field label="Paired printer name"><Input value={form.bluetooth_device_name} onChange={(event) => update('bluetooth_device_name', event.target.value)} /></Field><Field label="MAC address"><Input value={form.bluetooth_device_id} onChange={(event) => update('bluetooth_device_id', event.target.value)} /></Field></div> : null}
          </section>

          <section className="rounded-3xl border border-border bg-card p-4 shadow-sm">
            <h2 className="font-semibold">Physical label</h2>
            <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4"><Field label="Width mm"><Input type="number" step="0.1" value={form.label_width_mm} onChange={(event) => update('label_width_mm', event.target.value)} /></Field><Field label="Feed mm"><Input type="number" step="0.1" value={form.label_height_mm} onChange={(event) => update('label_height_mm', event.target.value)} /></Field><Field label="DPI"><Input type="number" value={form.dpi} onChange={(event) => update('dpi', event.target.value)} /></Field><Field label="Gap mm"><Input type="number" step="0.1" value={form.gap_mm} onChange={(event) => update('gap_mm', event.target.value)} /></Field><Field label="X offset mm"><Input type="number" step="0.1" value={form.x_offset_mm} onChange={(event) => update('x_offset_mm', event.target.value)} /></Field><Field label="Y offset mm"><Input type="number" step="0.1" value={form.y_offset_mm} onChange={(event) => update('y_offset_mm', event.target.value)} /></Field><Field label="Darkness"><Input type="number" min="0" max="15" value={form.darkness} onChange={(event) => update('darkness', event.target.value)} /></Field><Field label="Copies"><Input type="number" min="1" value={form.default_copies} onChange={(event) => update('default_copies', event.target.value)} /></Field></div>
            <div className="mt-3 rounded-xl bg-muted/60 p-3 text-xs"><b>Locked result:</b> {form.label_width_mm} × {form.label_height_mm} mm · {Math.round((numberValue(form.label_width_mm, 40) / 25.4) * numberValue(form.dpi, 203))} × {Math.round((numberValue(form.label_height_mm, 30) / 25.4) * numberValue(form.dpi, 203))} dots · no Portrait/Landscape CSS · no Raster.</div>
          </section>

          <section className="rounded-3xl border border-border bg-card p-4 shadow-sm">
            <div className="rounded-2xl bg-muted/50 p-3 text-xs"><Status label="Route" value={routeText} /><Status label="Runtime" value={nativeAndroid ? 'Android native app' : 'Web browser + Local Connector'} /><Status label="Device profile" value={selectedOnDevice ? 'Selected on this device' : 'Not selected'} good={selectedOnDevice} /></div>
            <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4"><Button variant="outline" onClick={testConnection} disabled={testing}>{testing ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Network className="mr-2 h-4 w-4" />}Test route</Button><Button variant="outline" onClick={testLabel} disabled={testing}>{testing ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Printer className="mr-2 h-4 w-4" />}Test label</Button><Button onClick={save} disabled={saving}>{saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}Save</Button><Button variant="outline" onClick={useOnDevice} disabled={!form.id || selectedOnDevice}><Smartphone className="mr-2 h-4 w-4" />Use here</Button></div>
            <div className="mt-2 grid grid-cols-2 gap-2"><Button variant="outline" onClick={followDefault}>Follow outlet default</Button><Button variant="outline" className="text-rose-700" onClick={remove} disabled={!form.id || deleting}>{deleting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Trash2 className="mr-2 h-4 w-4" />}Delete</Button></div>
          </section>

          {error ? <div className="rounded-xl bg-red-50 p-3 text-sm text-red-700">{error}</div> : null}
          {message ? <div className="rounded-xl bg-emerald-50 p-3 text-sm text-emerald-700">{message}</div> : null}
          <Button variant="outline" className="w-full" onClick={() => loadProfiles(form.id)}><RefreshCw className="mr-2 h-4 w-4" />Refresh profiles</Button>
        </>
      )}
    </div>
  )
}

function Field({ label, children }) {
  return <div className="space-y-1.5"><Label>{label}</Label>{children}</div>
}

function Badge({ children }) {
  return <span className="rounded-full bg-primary/10 px-2 py-1 text-[10px] font-semibold text-primary">{children}</span>
}

function Status({ label, value, good = false }) {
  return <div className="flex items-start justify-between gap-3 py-1"><span className="text-muted-foreground">{label}</span><span className={`max-w-[68%] text-right font-medium ${good ? 'text-emerald-700' : ''}`}>{value}</span></div>
}

function RouteCard({ active, icon: Icon, title, detail = '', disabled = false, onClick }) {
  return <button type="button" disabled={disabled} onClick={onClick} className={`flex min-h-24 flex-col items-center justify-center gap-1 rounded-2xl border p-3 text-center disabled:cursor-not-allowed disabled:opacity-40 ${active ? 'border-primary bg-primary/10' : 'bg-background'}`}><Icon className="h-5 w-5" /><span className="text-xs font-semibold">{title}</span>{detail ? <span className="text-[10px] leading-4 text-muted-foreground">{detail}</span> : null}{active ? <CheckCircle2 className="h-4 w-4 text-emerald-600" /> : null}</button>
}
