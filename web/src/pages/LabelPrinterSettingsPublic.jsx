import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  ArrowLeft,
  Bluetooth,
  CheckCircle2,
  CircleAlert,
  Copy,
  Gauge,
  Loader2,
  Network,
  Plus,
  Printer,
  RefreshCw,
  Ruler,
  Save,
  Server,
  Settings2,
  SlidersHorizontal,
  Smartphone,
  Sparkles,
  Trash2,
  UsersRound,
  Wifi,
} from 'lucide-react'

import { opsClient } from '@/api/opsClient'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useAuth } from '@/lib/AuthContext'
import {
  DEFAULT_PRINTER_HARDWARE,
  DEFAULT_PRINTER_LAYOUT,
  PRINTER_PRESETS,
  applyPrinterLayoutToHtml,
  applyPrinterPreset,
  clearLegacyPrinterDraft,
  clearPrinterDeviceBinding,
  formatPrinterHardwareSummary,
  getOrCreatePrinterDeviceId,
  readPrinterDeviceBinding,
  resolvePrinterLayout,
  savePrinterDeviceBinding,
  savePrinterProfilesSnapshot,
} from '@/lib/label-printer-profile'
import {
  calibratePrinterProfile,
  discoverBridgePrinterQueues,
  isNativeAndroidPrinterRuntime,
  testPrinterProfile,
} from '@/lib/native-label-print'
import {
  DEFAULT_PRINTER_TRANSPORT,
  effectiveConnectionType,
  encodePrinterTransportNotes,
  normalizePrinterTransportProfile,
  printerRouteLabel,
} from '@/lib/printer-transport-v12'

const RESPONSIVE_WORKSPACE_VERSION = '4.6.12-all-device-print-v12'

function emptyProfile(outletId = '') {
  return {
    id: '',
    outlet_id: outletId,
    purpose: 'food_label',
    profile_name: 'Food Label Printer',
    brand: '',
    model: '',
    connection_type: 'system_print',
    command_language: 'browser',
    ip_address: '',
    port: 9100,
    bluetooth_mode: 'classic',
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
    is_default: false,
    enabled: true,
    station_mode: 'this_device',
    station_device_name: '',
    user_notes: '',
    notes: '',
    ...DEFAULT_PRINTER_LAYOUT,
    ...DEFAULT_PRINTER_HARDWARE,
    ...DEFAULT_PRINTER_TRANSPORT,
  }
}

function numberValue(value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}

function profileToForm(profile, outletId) {
  return {
    ...emptyProfile(outletId),
    ...normalizePrinterTransportProfile(profile || {}, outletId),
    outlet_id: profile?.outlet_id || outletId || '',
  }
}

function profileRowsForOutlet(profiles, outletId) {
  return (profiles || [])
    .filter((row) => row.outlet_id === outletId && row.purpose === 'food_label' && !row.deleted_at)
    .sort((left, right) => {
      if (Boolean(left.is_default) !== Boolean(right.is_default)) return left.is_default ? -1 : 1
      return String(left.profile_name || '').localeCompare(String(right.profile_name || ''))
    })
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;')
}

function summaryText(layout) {
  const media = layout.media_orientation === 'landscape' ? 'Landscape media' : 'Portrait media'
  const content = layout.content_orientation === 'landscape' ? 'Landscape content' : 'Portrait content'
  const rotation = layout.rotation_degrees ? ` · Rotate ${layout.rotation_degrees}°` : ''
  return `${media} · ${layout.width_mm} × ${layout.height_mm} mm · ${content}${rotation}`
}

function connectionDescription(type) {
  if (type === 'system_print') return 'Windows/macOS/Android installed driver, USB, WSD, BLE or vendor print service.'
  if (type === 'driver_bridge') return 'Phone/tablet sends to a Windows or macOS computer, then its installed queue or LAN route.'
  if (type === 'network') return 'Android app connects directly to the printer’s own Raw TCP or LPR address.'
  return 'Android app connects to a paired Bluetooth Classic printer.'
}

export default function LabelPrinterSettingsPublic() {
  const { user } = useAuth()
  const [outlets, setOutlets] = useState([])
  const [profiles, setProfiles] = useState([])
  const [selectedOutletId, setSelectedOutletId] = useState(user?.outlet_id || '')
  const [selectedProfileId, setSelectedProfileId] = useState('')
  const [form, setForm] = useState(() => emptyProfile(user?.outlet_id || ''))
  const [deviceBinding, setDeviceBinding] = useState(() => readPrinterDeviceBinding(user?.outlet_id || ''))
  const [source, setSource] = useState(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [testing, setTesting] = useState(false)
  const [calibrating, setCalibrating] = useState(false)
  const [loadingQueues, setLoadingQueues] = useState(false)
  const [bridgeQueues, setBridgeQueues] = useState([])
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [diagnostic, setDiagnostic] = useState(null)

  useEffect(() => { void loadAll() }, [])

  const outletProfiles = useMemo(
    () => profileRowsForOutlet(profiles, selectedOutletId),
    [profiles, selectedOutletId],
  )
  const selectedOutlet = useMemo(
    () => outlets.find((row) => row.id === selectedOutletId),
    [outlets, selectedOutletId],
  )
  const resolvedLayout = useMemo(
    () => resolvePrinterLayout(form),
    [
      form.orientation,
      form.label_width_mm,
      form.label_height_mm,
      form.padding_top_mm,
      form.padding_right_mm,
      form.padding_bottom_mm,
      form.padding_left_mm,
    ],
  )
  const effectiveConnection = effectiveConnectionType(form)
  const isManaged = effectiveConnection !== 'system_print'
  const canCalibrate = isManaged && form.command_language !== 'escpos' && form.media_sensor !== 'continuous'
  const selectedOnDevice = deviceBinding.selected_profile_id === form.id && Boolean(form.id)

  async function loadAll() {
    setLoading(true)
    setError('')
    try {
      const [outletRows, profileRows, sourceSummary] = await Promise.all([
        opsClient.entities.Outlet.list('name', 100),
        opsClient.entities.PrinterProfile.filter({ purpose: 'food_label' }, '-is_default,-updated_date', 500),
        opsClient.labels.catalog({ summaryOnly: true }).catch(() => null),
      ])
      const availableOutlets = outletRows?.length
        ? outletRows
        : user?.outlet_id
          ? [{ id: user.outlet_id, name: user.outlet_id }]
          : []
      const normalizedProfiles = (profileRows || []).map((profile) => normalizePrinterTransportProfile(profile))
      const preferredOutlet = selectedOutletId || user?.outlet_id || availableOutlets[0]?.id || ''
      const outletId = availableOutlets.some((row) => row.id === preferredOutlet)
        ? preferredOutlet
        : availableOutlets[0]?.id || ''
      setOutlets(availableOutlets)
      setProfiles(normalizedProfiles)
      setSource(sourceSummary)
      setSelectedOutletId(outletId)
      openInitialProfile(outletId, normalizedProfiles)
      savePrinterProfilesSnapshot(outletId, profileRows || [])
      clearLegacyPrinterDraft(outletId)
    } catch (loadError) {
      setError(loadError.message || 'Label printer settings could not be loaded')
    } finally {
      setLoading(false)
    }
  }

  function openInitialProfile(outletId, rows = profiles) {
    const available = profileRowsForOutlet(rows, outletId)
    const binding = readPrinterDeviceBinding(outletId)
    const selected = available.find((row) => row.id === binding.selected_profile_id)
      || available.find((row) => row.is_default)
      || available[0]
      || null
    setDeviceBinding(binding)
    setSelectedProfileId(selected?.id || '__new__')
    setForm(profileToForm(selected, outletId))
    setBridgeQueues([])
    setMessage('')
    setError('')
    setDiagnostic(null)
  }

  function changeOutlet(outletId) {
    setSelectedOutletId(outletId)
    openInitialProfile(outletId)
  }

  function selectProfile(profile) {
    setSelectedProfileId(profile.id)
    setForm(profileToForm(profile, selectedOutletId))
    setBridgeQueues([])
    setMessage('')
    setError('')
    setDiagnostic(null)
  }

  function createProfile() {
    setSelectedProfileId('__new__')
    setForm({
      ...emptyProfile(selectedOutletId),
      profile_name: `Food Label Printer ${outletProfiles.length + 1}`,
      is_default: outletProfiles.length === 0,
    })
    setBridgeQueues([])
    setMessage('New profile started. Choose the real connection route used by this device.')
    setError('')
    setDiagnostic(null)
  }

  function duplicateProfile() {
    setSelectedProfileId('__new__')
    setForm({ ...form, id: '', profile_name: `${form.profile_name || 'Food Label Printer'} Copy`, is_default: false })
    setBridgeQueues([])
    setMessage('Profile copied. Change its printer or connection, then save it separately.')
    setError('')
    setDiagnostic(null)
  }

  function update(key, value) {
    setForm((current) => ({ ...current, [key]: value }))
    setMessage('')
    setError('')
    setDiagnostic(null)
  }

  function chooseConnection(connectionType) {
    setForm((current) => ({
      ...current,
      connection_type: connectionType,
      command_language: connectionType === 'system_print'
        ? 'browser'
        : current.command_language === 'browser'
          ? 'tspl'
          : current.command_language,
      bluetooth_mode: connectionType === 'bluetooth' ? 'classic' : current.bluetooth_mode,
    }))
    setBridgeQueues([])
    setMessage(connectionDescription(connectionType))
    setError('')
    setDiagnostic(null)
  }

  function chooseProtocol(protocol) {
    setForm((current) => ({
      ...current,
      network_protocol: protocol,
      port: protocol === 'lpr' ? 515 : 9100,
    }))
    setDiagnostic(null)
  }

  function chooseBridgeTransport(transport) {
    setForm((current) => ({
      ...current,
      bridge_transport: transport,
      bridge_printer_port: transport === 'lpr' ? 515 : 9100,
    }))
    setDiagnostic(null)
  }

  function choosePreset(presetId) {
    setForm((current) => applyPrinterPreset(current, presetId))
    setMessage(`Preset applied: ${PRINTER_PRESETS.find((preset) => preset.id === presetId)?.label || presetId}. Confirm the actual printer language and media.`)
    setError('')
    setDiagnostic(null)
  }

  function validateForSave() {
    if (!selectedOutletId) return 'Your account must be assigned to an outlet.'
    if (!String(form.profile_name || '').trim()) return 'Enter a printer profile name.'
    if (numberValue(form.label_width_mm, 0) <= 0 || numberValue(form.label_height_mm, 0) <= 0) return 'Enter a valid physical media size.'
    if (numberValue(form.default_copies, 0) < 1) return 'Default copies must be at least 1.'
    if ([form.padding_top_mm, form.padding_right_mm, form.padding_bottom_mm, form.padding_left_mm].some((value) => numberValue(value, -1) < 0)) return 'Padding cannot be negative.'
    if (form.media_sensor === 'gap' && numberValue(form.gap_mm, -1) < 0) return 'Gap size cannot be negative.'
    if (form.media_sensor === 'black_mark' && numberValue(form.black_mark_mm, 0) <= 0) return 'Enter the black-mark length.'
    if (numberValue(form.darkness, -1) < 0 || numberValue(form.darkness, 16) > 15) return 'Darkness must be between 0 and 15.'
    if (form.connection_type === 'network' && !String(form.ip_address || '').trim()) return 'Enter the printer’s own IP address.'
    if (form.connection_type === 'network' && form.network_protocol === 'lpr' && !String(form.lpr_queue || '').trim()) return 'Enter the LPR queue name.'
    if (form.connection_type === 'bluetooth' && !String(form.bluetooth_device_name || form.bluetooth_device_id || '').trim()) return 'Enter a paired Bluetooth Classic name or MAC address.'
    if (form.connection_type === 'driver_bridge' && !String(form.bridge_url || '').trim()) return 'Enter the Print Bridge computer URL.'
    if (form.connection_type === 'driver_bridge' && !String(form.bridge_token || '').trim()) return 'Enter the Print Bridge pairing token.'
    if (form.connection_type === 'driver_bridge' && form.bridge_transport === 'queue' && !String(form.bridge_queue || '').trim()) return 'Load and select an installed printer queue.'
    if (form.connection_type === 'driver_bridge' && form.bridge_transport !== 'queue' && !String(form.bridge_printer_ip || '').trim()) return 'Enter the printer IP used by the bridge computer.'
    if (isManaged && !['tspl', 'zpl', 'cpcl', 'escpos'].includes(form.command_language)) return 'Choose TSPL, ZPL, CPCL or ESC/POS.'
    return ''
  }

  function payload() {
    return {
      outlet_id: selectedOutletId,
      purpose: 'food_label',
      profile_name: String(form.profile_name || '').trim(),
      brand: String(form.brand || '').trim(),
      model: String(form.model || '').trim(),
      connection_type: String(form.connection_type || 'system_print'),
      command_language: String(form.command_language || 'browser'),
      ip_address: String(form.ip_address || '').trim(),
      port: numberValue(form.port, form.network_protocol === 'lpr' ? 515 : 9100),
      bluetooth_mode: String(form.bluetooth_mode || 'classic'),
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
      notes: encodePrinterTransportNotes(form),
    }
  }

  async function refreshProfiles(preferredId = '') {
    const rows = await opsClient.entities.PrinterProfile.filter({ purpose: 'food_label' }, '-is_default,-updated_date', 500)
    const normalized = (rows || []).map((profile) => normalizePrinterTransportProfile(profile))
    setProfiles(normalized)
    savePrinterProfilesSnapshot(selectedOutletId, rows || [])
    clearLegacyPrinterDraft(selectedOutletId)
    const available = profileRowsForOutlet(normalized, selectedOutletId)
    const selected = available.find((row) => row.id === preferredId)
      || available.find((row) => row.is_default)
      || available[0]
      || null
    setSelectedProfileId(selected?.id || '__new__')
    setForm(profileToForm(selected, selectedOutletId))
    return { rows: normalized, selected }
  }

  async function save() {
    const validationError = validateForSave()
    if (validationError) { setError(validationError); return null }
    setSaving(true)
    setError('')
    setMessage('')
    try {
      const nextPayload = payload()
      if (nextPayload.is_default) {
        await opsClient.entities.PrinterProfile.updateMany(
          { outlet_id: selectedOutletId, purpose: 'food_label' },
          { is_default: false },
        )
      }
      const saved = form.id
        ? await opsClient.entities.PrinterProfile.update(form.id, nextPayload)
        : await opsClient.entities.PrinterProfile.create(nextPayload)
      const refreshed = await refreshProfiles(saved.id)
      const binding = readPrinterDeviceBinding(selectedOutletId)
      if (!binding.selected_profile_id && refreshed.selected?.id) {
        setDeviceBinding(savePrinterDeviceBinding(selectedOutletId, refreshed.selected.id, refreshed.selected.station_device_name || ''))
      }
      setMessage('Printer profile saved for this outlet. Test Connection and Test Label before service use.')
      return refreshed.selected
    } catch (saveError) {
      setError(saveError.message || 'Printer profile could not be saved')
      return null
    } finally {
      setSaving(false)
    }
  }

  async function removeProfile() {
    if (!form.id || deleting) return
    if (!window.confirm(`Delete printer profile “${form.profile_name}”?`)) return
    setDeleting(true)
    setError('')
    try {
      const remaining = outletProfiles.filter((profile) => profile.id !== form.id)
      await opsClient.entities.PrinterProfile.delete(form.id)
      if (form.is_default && remaining.length && !remaining.some((profile) => profile.is_default)) {
        await opsClient.entities.PrinterProfile.update(remaining[0].id, { is_default: true })
      }
      if (deviceBinding.selected_profile_id === form.id) setDeviceBinding(clearPrinterDeviceBinding(selectedOutletId))
      await refreshProfiles(remaining[0]?.id || '')
      setMessage('Printer profile deleted. Other outlet profiles were kept.')
    } catch (deleteError) {
      setError(deleteError.message || 'Printer profile could not be deleted')
    } finally {
      setDeleting(false)
    }
  }

  function useOnThisDevice() {
    if (!form.id) { setError('Save this profile before assigning it to the device.'); return }
    if (!form.enabled) { setError('Enable this profile before assigning it to the device.'); return }
    const binding = savePrinterDeviceBinding(selectedOutletId, form.id, form.station_device_name || form.profile_name)
    setDeviceBinding(binding)
    savePrinterProfilesSnapshot(selectedOutletId, profiles)
    setMessage(`This device now uses “${form.profile_name}”. The selection stays with this device and outlet.`)
    setError('')
  }

  function useOutletDefaultOnDevice() {
    setDeviceBinding(clearPrinterDeviceBinding(selectedOutletId))
    const selected = outletProfiles.find((profile) => profile.is_default) || outletProfiles[0]
    if (selected) selectProfile(selected)
    setMessage('This device now follows the outlet default printer profile.')
  }

  async function loadBridgeQueues() {
    setLoadingQueues(true)
    setDiagnostic(null)
    setError('')
    try {
      const rows = await discoverBridgePrinterQueues({ ...form, bridge_queue: form.bridge_queue || '__discover__' })
      setBridgeQueues(rows)
      if (!rows.length) setDiagnostic({ tone: 'error', text: 'Bridge computer is reachable, but it returned no installed printer queues.' })
      else setDiagnostic({ tone: 'success', text: `Bridge connected. ${rows.length} installed printer queue(s) found.` })
    } catch (queueError) {
      setDiagnostic({ tone: 'error', text: queueError.message || 'Installed printer queues could not be loaded.' })
    } finally {
      setLoadingQueues(false)
    }
  }

  async function testConnection() {
    const validationError = validateForSave()
    if (validationError) { setError(validationError); return }
    setTesting(true)
    setError('')
    setDiagnostic(null)
    try {
      const result = await testPrinterProfile(form)
      const suffix = result.requiresTestLabel ? ' Open Test Label to verify the real driver and paper size.' : ' The route is ready.'
      setDiagnostic({ tone: 'success', text: `Connected: ${result.printer || printerRouteLabel(form)}.${suffix}` })
    } catch (testError) {
      setDiagnostic({ tone: 'error', text: testError.message || 'Printer connection test failed.' })
    } finally {
      setTesting(false)
    }
  }

  async function calibrateMedia() {
    const validationError = validateForSave()
    if (validationError) { setError(validationError); return }
    if (!canCalibrate) {
      setDiagnostic({ tone: 'info', text: 'Calibration requires TSPL, ZPL or CPCL with Gap or Black mark media.' })
      return
    }
    if (!window.confirm('The printer may feed several labels while detecting the sensor. Continue calibration?')) return
    setCalibrating(true)
    setError('')
    setDiagnostic(null)
    try {
      const result = await calibratePrinterProfile(form)
      setDiagnostic({ tone: 'success', text: `Calibration command sent to ${result.printer || form.profile_name}. Wait until the feed cycle stops.` })
    } catch (calibrationError) {
      setDiagnostic({ tone: 'error', text: calibrationError.message || 'Printer media calibration failed.' })
    } finally {
      setCalibrating(false)
    }
  }

  function previewTestLabel() {
    if (!form.id) { setError('Save this profile before printing a test label.'); return }
    if (!form.enabled) { setError('Enable this profile before printing a test label.'); return }
    setDeviceBinding(savePrinterDeviceBinding(selectedOutletId, form.id, form.station_device_name || form.profile_name))
    const width = Math.max(20, numberValue(form.label_width_mm, 40))
    const height = Math.max(15, numberValue(form.label_height_mm, 30))
    const raw = `<!doctype html><html><head><title>Stupiak's Ops Test Label</title><style>
      @page{size:${width}mm ${height}mm;margin:0}*{box-sizing:border-box}body{margin:0;width:${width}mm;height:${height}mm;font-family:Arial,sans-serif;color:#000}.label{width:${width}mm;height:${height}mm;display:flex;flex-direction:column}.title{font-size:9pt;font-weight:900;border-bottom:.3mm solid #000;padding-bottom:.5mm}.meta{font-size:5.5pt;font-weight:800;margin-top:.5mm}.time{display:grid;grid-template-columns:1fr 1fr;gap:.7mm;margin-top:.7mm}.box{border:.2mm solid #000;padding:.5mm;font-size:5pt}.box strong{display:block;font-size:6pt;margin-top:.4mm}.batch{margin-top:auto;text-align:center;font:700 5pt monospace}
    </style></head><body><div class="label"><div class="title">TEST LABEL</div><div class="meta">${escapeHtml(String(form.command_language || form.connection_type || '').toUpperCase())} • ${escapeHtml(selectedOutlet?.name || selectedOutletId)}</div><div class="time"><div class="box">MADE 14:30<strong>29 JUL 2026</strong></div><div class="box">USE BY 14:30<strong>30 JUL 2026</strong></div></div><div class="batch">${escapeHtml(form.profile_name)} · TEST</div></div><script>window.onload=()=>setTimeout(()=>window.print(),80)</script></body></html>`
    const transformed = applyPrinterLayoutToHtml(raw, form)
    const win = window.open('', '_blank', 'width=480,height=640')
    if (!win) { setError('The app blocked the test-label window.'); return }
    win.document.open()
    win.document.write(transformed.html)
    win.document.close()
    setMessage(`Test label sent through “${form.profile_name}”: ${summaryText(transformed.layout)}.`)
  }

  return (
    <div className="chefops-page mx-auto w-full max-w-7xl space-y-4 p-3 pb-36 sm:p-5 sm:pb-32" data-printer-workspace={RESPONSIVE_WORKSPACE_VERSION}>
      <header className="rounded-3xl border border-border bg-card p-4 shadow-sm sm:p-5">
        <div className="flex items-start gap-3">
          <Button asChild variant="outline" size="icon" className="h-10 w-10 shrink-0 rounded-xl"><Link to="/labels"><ArrowLeft className="h-4 w-4" /></Link></Button>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-xl font-heading font-bold sm:text-2xl">标签打印机设置 / Label Printer Settings</h1>
              <Tag tone="success">Outlet shared</Tag>
              <Tag>{isNativeAndroidPrinterRuntime() ? 'Android transport v12' : 'Web / computer driver'}</Tag>
            </div>
            <p className="mt-1 max-w-4xl text-xs leading-5 text-muted-foreground sm:text-sm">
              Choose the real route used by each device. USB, WSD, BLE and vendor-driver printers use System Print or Driver Bridge; only a printer with its own Raw TCP/LPR port uses Direct Wi-Fi/LAN.
            </p>
          </div>
        </div>
        <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
          <HeaderMetric label="Outlet" value={selectedOutlet?.name || selectedOutletId || 'Not assigned'} />
          <HeaderMetric label="Profiles" value={String(outletProfiles.length)} />
          <HeaderMetric label="This device" value={outletProfiles.find((profile) => profile.id === deviceBinding.selected_profile_id)?.profile_name || 'Outlet default'} />
          <HeaderMetric label="Route" value={printerRouteLabel(form)} />
        </div>
      </header>

      {loading ? <div className="flex justify-center py-24"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div> : (
        <>
          <div className="grid gap-4 xl:grid-cols-[minmax(0,1.15fr)_minmax(360px,.85fr)]">
            <div className="space-y-4">
              <Section icon={Server} title="Printer profiles" subtitle="One profile for every physical printer and connection route.">
                <Field label="Outlet"><select className="h-11 w-full rounded-md border border-input bg-background px-3 text-sm" value={selectedOutletId} onChange={(event) => changeOutlet(event.target.value)}>{outlets.map((outlet) => <option key={outlet.id} value={outlet.id}>{outlet.name || outlet.code || outlet.id}</option>)}</select></Field>
                <div className="mt-3 flex gap-2 overflow-x-auto pb-1">
                  {outletProfiles.map((profile) => {
                    const active = selectedProfileId === profile.id
                    const onDevice = deviceBinding.selected_profile_id === profile.id
                    return <button key={profile.id} type="button" onClick={() => selectProfile(profile)} className={`min-w-[250px] rounded-2xl border p-3 text-left ${active ? 'border-primary bg-primary/10' : 'bg-background'}`}>
                      <div className="flex items-start justify-between gap-2"><div className="min-w-0"><p className="truncate text-sm font-semibold">{profile.profile_name}</p><p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{printerRouteLabel(profile)}</p></div>{active ? <CheckCircle2 className="h-4 w-4 shrink-0 text-primary" /> : null}</div>
                      <div className="mt-2 flex flex-wrap gap-1">{profile.is_default ? <Tag>Outlet default</Tag> : null}{onDevice ? <Tag>This device</Tag> : null}{!profile.enabled ? <Tag>Disabled</Tag> : null}</div>
                    </button>
                  })}
                </div>
                {!outletProfiles.length ? <p className="mt-3 rounded-xl border border-dashed p-4 text-sm text-muted-foreground">No printer profile yet. Create the first one for this outlet.</p> : null}
                <div className="mt-3 grid grid-cols-2 gap-2"><Button type="button" variant="outline" onClick={createProfile}><Plus className="mr-2 h-4 w-4" /> New profile</Button><Button type="button" variant="outline" onClick={duplicateProfile} disabled={!form.id}><Copy className="mr-2 h-4 w-4" /> Duplicate</Button></div>
              </Section>

              <Section icon={Printer} title="Printer and connection" subtitle="Select the real route. A computer IP is not a printer IP.">
                <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
                  <ConnectionChoice value="system_print" label="System / Driver" detail="USB · WSD · BLE" icon={Printer} current={form.connection_type} onSelect={chooseConnection} />
                  <ConnectionChoice value="driver_bridge" label="PC/Mac Bridge" detail="Installed queue" icon={Server} current={form.connection_type} onSelect={chooseConnection} />
                  <ConnectionChoice value="network" label="Direct Wi-Fi/LAN" detail="Printer IP only" icon={Network} current={form.connection_type} onSelect={chooseConnection} />
                  <ConnectionChoice value="bluetooth" label="Bluetooth Classic" detail="Android paired" icon={Bluetooth} current={form.connection_type} onSelect={chooseConnection} />
                </div>
                <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs leading-5 text-amber-900">{connectionDescription(form.connection_type)}</div>

                <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <Field label="Profile name"><Input value={form.profile_name} onChange={(event) => update('profile_name', event.target.value)} /></Field>
                  <Field label="Printer language"><select className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm" value={form.command_language} disabled={form.connection_type === 'system_print'} onChange={(event) => update('command_language', event.target.value)}><option value="browser">Driver / browser rendering</option><option value="tspl">TSPL</option><option value="zpl">ZPL</option><option value="cpcl">CPCL</option><option value="escpos">ESC/POS</option></select></Field>
                  <Field label="Brand"><Input value={form.brand} onChange={(event) => update('brand', event.target.value)} placeholder="Optional" /></Field>
                  <Field label="Model"><Input value={form.model} onChange={(event) => update('model', event.target.value)} placeholder="Optional" /></Field>
                </div>

                {form.connection_type === 'network' ? <div className="mt-4 space-y-3 rounded-2xl border p-3">
                  <div className="grid grid-cols-2 gap-2"><ConnectionChoice value="raw_tcp" label="Raw TCP" detail="Usually 9100" icon={Wifi} current={form.network_protocol} onSelect={chooseProtocol} /><ConnectionChoice value="lpr" label="LPR" detail="Usually 515" icon={Network} current={form.network_protocol} onSelect={chooseProtocol} /></div>
                  <div className="grid grid-cols-[minmax(0,1fr)_110px] gap-3"><Field label="Printer’s own IP"><Input value={form.ip_address} onChange={(event) => update('ip_address', event.target.value)} placeholder="192.168.1.50" inputMode="decimal" /></Field><Field label="Port"><Input type="number" min="1" max="65535" value={form.port} onChange={(event) => update('port', event.target.value)} /></Field></div>
                  {form.network_protocol === 'lpr' ? <Field label="LPR queue"><Input value={form.lpr_queue} onChange={(event) => update('lpr_queue', event.target.value)} placeholder="lp" /></Field> : null}
                  <p className="text-xs text-muted-foreground">Use this only when the printer itself accepts Raw TCP/LPR. Do not enter the Windows computer IP here.</p>
                </div> : null}

                {form.connection_type === 'driver_bridge' ? <div className="mt-4 space-y-3 rounded-2xl border p-3">
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2"><Field label="Bridge computer URL"><Input value={form.bridge_url} onChange={(event) => update('bridge_url', event.target.value)} placeholder="http://192.168.1.20:8787" /></Field><Field label="Pairing token"><Input type="password" value={form.bridge_token} onChange={(event) => update('bridge_token', event.target.value)} placeholder="Shown by bridge installer" /></Field></div>
                  <div className="grid grid-cols-3 gap-2"><ConnectionChoice value="queue" label="Installed Queue" detail="Windows/CUPS" icon={Printer} current={form.bridge_transport} onSelect={chooseBridgeTransport} /><ConnectionChoice value="raw_tcp" label="Bridge Raw TCP" detail="PC to printer" icon={Wifi} current={form.bridge_transport} onSelect={chooseBridgeTransport} /><ConnectionChoice value="lpr" label="Bridge LPR" detail="PC to printer" icon={Network} current={form.bridge_transport} onSelect={chooseBridgeTransport} /></div>
                  {form.bridge_transport === 'queue' ? <div className="space-y-2"><div className="flex gap-2"><Button type="button" variant="outline" className="shrink-0" onClick={loadBridgeQueues} disabled={loadingQueues}>{loadingQueues ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />} Load queues</Button><select className="h-10 min-w-0 flex-1 rounded-md border border-input bg-background px-3 text-sm" value={form.bridge_queue} onChange={(event) => update('bridge_queue', event.target.value)}><option value="">Select installed printer</option>{bridgeQueues.map((queue) => <option key={queue.name} value={queue.name}>{queue.name}{queue.offline ? ' · Offline' : ''}{queue.driver ? ` · ${queue.driver}` : ''}</option>)}</select></div><p className="text-xs text-muted-foreground">Works with a Windows/macOS LAN, USB or shared printer queue. The bridge computer must stay on.</p></div> : <div className="grid grid-cols-[minmax(0,1fr)_110px] gap-3"><Field label="Printer IP used by bridge"><Input value={form.bridge_printer_ip} onChange={(event) => update('bridge_printer_ip', event.target.value)} placeholder="192.168.1.50" /></Field><Field label="Port"><Input type="number" min="1" max="65535" value={form.bridge_printer_port} onChange={(event) => update('bridge_printer_port', event.target.value)} /></Field>{form.bridge_transport === 'lpr' ? <Field label="LPR queue" className="col-span-2"><Input value={form.bridge_lpr_queue} onChange={(event) => update('bridge_lpr_queue', event.target.value)} placeholder="lp" /></Field> : null}</div>}
                </div> : null}

                {form.connection_type === 'bluetooth' ? <div className="mt-4 space-y-3 rounded-2xl border p-3"><div className="grid grid-cols-1 gap-3 sm:grid-cols-2"><Field label="Paired device name"><Input value={form.bluetooth_device_name} onChange={(event) => update('bluetooth_device_name', event.target.value)} placeholder="Printer name" /></Field><Field label="MAC address"><Input value={form.bluetooth_device_id} onChange={(event) => update('bluetooth_device_id', event.target.value)} placeholder="AA:BB:CC:DD:EE:FF" /></Field></div><p className="text-xs text-muted-foreground">Pair in Android Settings first. BLE/vendor-driver printers use System / Driver instead of raw Bluetooth.</p></div> : null}

                <div className="mt-4 overflow-hidden rounded-xl border border-border"><CheckRow label="Outlet default profile" checked={form.is_default} onChange={(value) => update('is_default', value)} /><CheckRow label="Profile enabled" checked={form.enabled} onChange={(value) => update('enabled', value)} /></div>
              </Section>

              <Section icon={Sparkles} title="Quick printer preset" subtitle="Preset changes language and tuning only; connection route stays separate.">
                <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">{PRINTER_PRESETS.map((preset) => <button key={preset.id} type="button" onClick={() => choosePreset(preset.id)} className={`rounded-2xl border p-3 text-left ${form.preset_id === preset.id ? 'border-primary bg-primary/10' : 'bg-background'}`}><p className="text-sm font-semibold">{preset.label}</p><p className="mt-1 text-xs leading-4 text-muted-foreground">{preset.description}</p></button>)}</div>
              </Section>
            </div>

            <div className="space-y-4 xl:sticky xl:top-4 xl:self-start">
              <Section icon={Ruler} title="Physical media and content" subtitle="Media dimensions never swap. Portrait/Landscape rotates content only.">
                <Field label="Content preference"><select className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm" value={form.orientation} onChange={(event) => update('orientation', event.target.value)}><option value="auto">Auto · follow physical media</option><option value="portrait">Portrait content</option><option value="landscape">Landscape content</option></select></Field>
                <div className="mt-3 grid grid-cols-2 gap-3"><Field label="Media width (mm)"><Input type="number" min="1" step="0.1" value={form.label_width_mm} onChange={(event) => update('label_width_mm', event.target.value)} /></Field><Field label="Feed length (mm)"><Input type="number" min="1" step="0.1" value={form.label_height_mm} onChange={(event) => update('label_height_mm', event.target.value)} /></Field><Field label="DPI"><Input type="number" min="72" value={form.dpi} onChange={(event) => update('dpi', event.target.value)} /></Field><Field label="Copies"><Input type="number" min="1" max="100" value={form.default_copies} onChange={(event) => update('default_copies', event.target.value)} /></Field></div>
                <div className="mt-3 rounded-xl bg-muted/60 p-3 text-xs font-medium">{summaryText(resolvedLayout)}</div>
                <p className="mt-2 text-xs leading-5 text-muted-foreground">40×30 mm always stays physically 40×30 mm. Portrait rotates the complete content 90° when required.</p>
              </Section>

              <Section icon={Gauge} title="Media sensor and tuning" subtitle={formatPrinterHardwareSummary(form)}>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2"><Field label="Media sensor"><select className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm" value={form.media_sensor} onChange={(event) => update('media_sensor', event.target.value)}><option value="gap">Gap</option><option value="black_mark">Black mark</option><option value="continuous">Continuous</option></select></Field><Field label="Connection timeout (ms)"><Input type="number" min="1000" max="30000" step="500" value={form.connection_timeout_ms} onChange={(event) => update('connection_timeout_ms', event.target.value)} /></Field></div>
                {form.media_sensor === 'gap' ? <div className="mt-3 grid grid-cols-2 gap-3"><Field label="Gap (mm)"><Input type="number" min="0" step="0.1" value={form.gap_mm} onChange={(event) => update('gap_mm', event.target.value)} /></Field><Field label="Gap offset (mm)"><Input type="number" step="0.1" value={form.gap_offset_mm} onChange={(event) => update('gap_offset_mm', event.target.value)} /></Field></div> : null}
                {form.media_sensor === 'black_mark' ? <div className="mt-3 grid grid-cols-2 gap-3"><Field label="Black mark (mm)"><Input type="number" min="0.1" step="0.1" value={form.black_mark_mm} onChange={(event) => update('black_mark_mm', event.target.value)} /></Field><Field label="Mark offset (mm)"><Input type="number" step="0.1" value={form.black_mark_offset_mm} onChange={(event) => update('black_mark_offset_mm', event.target.value)} /></Field></div> : null}
                <div className="mt-3 grid grid-cols-2 gap-3"><Field label="Speed (mm/s)"><Input type="number" min="10" max="305" value={form.print_speed_mm_s} onChange={(event) => update('print_speed_mm_s', event.target.value)} /></Field><Field label="Darkness 0–15"><Input type="number" min="0" max="15" value={form.darkness} onChange={(event) => update('darkness', event.target.value)} /></Field><Field label="X offset (mm)"><Input type="number" step="0.1" value={form.x_offset_mm} onChange={(event) => update('x_offset_mm', event.target.value)} /></Field><Field label="Y offset (mm)"><Input type="number" step="0.1" value={form.y_offset_mm} onChange={(event) => update('y_offset_mm', event.target.value)} /></Field></div>
              </Section>

              <Section icon={SlidersHorizontal} title="Live route summary" subtitle="Every button returns a real result or a visible error.">
                <div className="space-y-2 rounded-xl bg-muted/50 p-3 text-xs"><Status label="Connection" value={printerRouteLabel(form)} /><Status label="Runtime" value={isNativeAndroidPrinterRuntime() ? 'Android app' : 'Web / desktop browser'} /><Status label="Language" value={String(form.command_language || 'browser').toUpperCase()} /><Status label="Device binding" value={selectedOnDevice ? 'This profile' : 'Not selected on this device'} good={selectedOnDevice} /></div>
                {diagnostic ? <div className={`mt-3 rounded-xl p-3 text-sm ${diagnostic.tone === 'success' ? 'bg-emerald-500/10 text-emerald-700' : diagnostic.tone === 'info' ? 'bg-blue-500/10 text-blue-700' : 'bg-destructive/10 text-destructive'}`}>{diagnostic.text}</div> : null}
                <div className="mt-3 grid grid-cols-2 gap-2"><Button type="button" variant="outline" onClick={testConnection} disabled={testing}>{testing ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Network className="mr-2 h-4 w-4" />} Test connection</Button><Button type="button" variant="outline" onClick={calibrateMedia} disabled={calibrating || !canCalibrate}>{calibrating ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />} Calibrate</Button><Button type="button" variant="outline" onClick={previewTestLabel}><Printer className="mr-2 h-4 w-4" /> Test label</Button><Button type="button" onClick={save} disabled={saving}>{saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />} Save profile</Button></div>
              </Section>

              <Section icon={Smartphone} title="This device" subtitle="Binding is Device + Outlet, never employee account.">
                <div className="space-y-2 rounded-xl bg-muted/50 p-3 text-xs"><Status label="Device ID" value={getOrCreatePrinterDeviceId().slice(0, 18)} /><Status label="Selected profile" value={outletProfiles.find((profile) => profile.id === deviceBinding.selected_profile_id)?.profile_name || 'Follow outlet default'} /><Status label="Binding" value="Device + outlet" good /></div>
                <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2"><Button type="button" onClick={useOnThisDevice} disabled={!form.id || selectedOnDevice}><Smartphone className="mr-2 h-4 w-4" /> Use on this device</Button><Button type="button" variant="outline" onClick={useOutletDefaultOnDevice}>Follow outlet default</Button></div>
              </Section>
            </div>
          </div>

          {error ? <div className="rounded-xl bg-destructive/10 p-3 text-sm text-destructive">{error}</div> : null}
          {message ? <div className="rounded-xl bg-emerald-500/10 p-3 text-sm text-emerald-700">{message}</div> : null}
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2"><Button type="button" variant="outline" onClick={loadAll}><RefreshCw className="mr-2 h-4 w-4" /> Refresh profiles</Button><Button type="button" variant="outline" className="border-rose-300 text-rose-700" onClick={removeProfile} disabled={!form.id || deleting}>{deleting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Trash2 className="mr-2 h-4 w-4" />} Delete selected profile</Button></div>
          <Section icon={UsersRound} title="Label rules source" subtitle="Printer transport does not change product or expiry rules.">{source ? <div className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-4"><Status label="Status" value="Connected" good /><Status label="Products" value={source.summary?.productCount ?? 0} /><Status label="Expiry rules" value={source.summary?.ruleCount ?? 0} /><Status label="Source" value={source.source?.productSheet || 'ProductMaster'} /></div> : <p className="text-sm text-destructive">The label rules source could not be verified.</p>}</Section>
        </>
      )}
    </div>
  )
}

function Section({ icon: Icon, title, subtitle = '', children }) {
  return <section className="rounded-3xl border border-border bg-card p-4 shadow-sm"><div className="mb-3 flex items-start gap-2"><span className="rounded-xl bg-primary/10 p-2 text-primary"><Icon className="h-4 w-4" /></span><div><h2 className="text-sm font-semibold">{title}</h2>{subtitle ? <p className="mt-0.5 text-xs leading-5 text-muted-foreground">{subtitle}</p> : null}</div></div>{children}</section>
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

function Tag({ children, tone = 'default' }) {
  return <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${tone === 'success' ? 'bg-emerald-100 text-emerald-700' : 'bg-muted text-muted-foreground'}`}>{children}</span>
}

function HeaderMetric({ label, value }) {
  return <div className="min-w-0 rounded-2xl bg-muted/55 p-3"><p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</p><p className="mt-1 truncate text-xs font-semibold sm:text-sm">{value}</p></div>
}

function ConnectionChoice({ value, label, detail, icon: Icon, current, onSelect }) {
  const active = current === value
  return <button type="button" onClick={() => onSelect(value)} className={`flex min-h-24 flex-col items-center justify-center gap-1 rounded-2xl border p-2 text-center transition ${active ? 'border-primary bg-primary/10 text-foreground' : 'border-border bg-background text-muted-foreground active:bg-muted'}`}><Icon className="h-5 w-5" /><span className="text-xs font-semibold">{label}</span>{detail ? <span className="text-[10px] leading-4 opacity-80">{detail}</span> : null}{active ? <CheckCircle2 className="h-4 w-4 text-emerald-600" /> : null}</button>
}
