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
  Move,
  Network,
  Plus,
  Printer,
  Radio,
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
  encodePrinterProfileNotes,
  formatPrinterHardwareSummary,
  getOrCreatePrinterDeviceId,
  normalizePrinterProfile,
  readPrinterDeviceBinding,
  resolvePrinterLayout,
  savePrinterDeviceBinding,
  savePrinterProfilesSnapshot,
} from '@/lib/label-printer-profile'
import {
  calibrateDirectPrinterProfile,
  testDirectPrinterProfile,
} from '@/lib/native-label-print'

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
  }
}

function numberValue(value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}

function profileToForm(profile, outletId) {
  return {
    ...emptyProfile(outletId),
    ...normalizePrinterProfile(profile || {}, outletId),
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
  const orientation = layout.media_orientation === 'landscape' ? 'Landscape media' : 'Portrait media'
  return `${orientation} · ${layout.width_mm} × ${layout.height_mm} mm · Padding ${layout.padding_top_mm}/${layout.padding_right_mm}/${layout.padding_bottom_mm}/${layout.padding_left_mm} mm`
}

function connectionLabel(profile) {
  if (profile.connection_type === 'network') {
    return profile.network_protocol === 'lpr'
      ? `LPR · ${profile.ip_address || 'No IP'}:${profile.port || 515}`
      : `Raw TCP · ${profile.ip_address || 'No IP'}:${profile.port || 9100}`
  }
  if (profile.connection_type === 'bluetooth') {
    return `Bluetooth · ${profile.bluetooth_device_name || profile.bluetooth_device_id || 'Not paired'}`
  }
  return 'Android / system driver'
}

function isNativeAndroid() {
  const capacitor = window.Capacitor
  return Boolean(
    (capacitor?.isNativePlatform?.() && capacitor?.getPlatform?.() === 'android')
    || window.location.origin === 'https://localhost'
    || window.location.origin === 'capacitor://localhost'
  )
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
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [diagnostic, setDiagnostic] = useState(null)

  useEffect(() => {
    void loadAll()
  }, [])

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

  const isDirect = form.connection_type === 'network' || form.connection_type === 'bluetooth'
  const canCalibrate = isDirect && form.command_language !== 'escpos' && form.media_sensor !== 'continuous'
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
      const normalizedProfiles = (profileRows || []).map((profile) => normalizePrinterProfile(profile))
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
    setMessage('New profile started. Choose a preset, connection and media before saving.')
    setError('')
    setDiagnostic(null)
  }

  function duplicateProfile() {
    setSelectedProfileId('__new__')
    setForm({
      ...form,
      id: '',
      profile_name: `${form.profile_name || 'Food Label Printer'} Copy`,
      is_default: false,
    })
    setMessage('Profile copied. Change the connection or printer model, then save it as a separate profile.')
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
    setForm((current) => {
      if (connectionType === 'system_print') {
        return { ...current, connection_type: connectionType, command_language: 'browser' }
      }
      return {
        ...current,
        connection_type: connectionType,
        command_language: current.command_language === 'browser' ? 'tspl' : current.command_language,
        bluetooth_mode: 'classic',
      }
    })
    setMessage('')
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

  function choosePreset(presetId) {
    setForm((current) => applyPrinterPreset(current, presetId))
    setMessage(`Preset applied: ${PRINTER_PRESETS.find((preset) => preset.id === presetId)?.label || presetId}. Check the connection and media size before saving.`)
    setError('')
    setDiagnostic(null)
  }

  function validate() {
    if (!selectedOutletId) return 'Your account must be assigned to an outlet.'
    if (!String(form.profile_name || '').trim()) return 'Enter a printer profile name.'
    if (numberValue(form.label_width_mm, 0) <= 0 || numberValue(form.label_height_mm, 0) <= 0) return 'Enter a valid physical media size.'
    if (numberValue(form.default_copies, 0) < 1) return 'Default copies must be at least 1.'
    if ([form.padding_top_mm, form.padding_right_mm, form.padding_bottom_mm, form.padding_left_mm].some((value) => numberValue(value, -1) < 0)) return 'Padding cannot be negative.'
    if (form.media_sensor === 'gap' && numberValue(form.gap_mm, -1) < 0) return 'Gap size cannot be negative.'
    if (form.media_sensor === 'black_mark' && numberValue(form.black_mark_mm, 0) <= 0) return 'Enter the black-mark length.'
    if (numberValue(form.print_speed_mm_s, 0) < 10) return 'Print speed must be at least 10 mm/s.'
    if (numberValue(form.darkness, -1) < 0 || numberValue(form.darkness, 16) > 15) return 'Darkness must be between 0 and 15.'
    if (form.connection_type === 'network' && !String(form.ip_address || '').trim()) return 'Enter the printer IP address.'
    if (form.connection_type === 'network' && form.network_protocol === 'lpr' && !String(form.lpr_queue || '').trim()) return 'Enter the LPR queue name.'
    if (form.connection_type === 'bluetooth' && !String(form.bluetooth_device_name || form.bluetooth_device_id || '').trim()) return 'Enter a paired Bluetooth device name or MAC address.'
    if (isDirect && !['tspl', 'zpl', 'cpcl', 'escpos'].includes(form.command_language)) return 'Choose a direct printer command language.'
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
      bluetooth_mode: 'classic',
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
      notes: encodePrinterProfileNotes(form),
    }
  }

  async function refreshProfiles(preferredId = '') {
    const rows = await opsClient.entities.PrinterProfile.filter(
      { purpose: 'food_label' },
      '-is_default,-updated_date',
      500,
    )
    const normalized = (rows || []).map((profile) => normalizePrinterProfile(profile))
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
    const validationError = validate()
    if (validationError) {
      setError(validationError)
      return null
    }

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
        setDeviceBinding(savePrinterDeviceBinding(
          selectedOutletId,
          refreshed.selected.id,
          refreshed.selected.station_device_name || '',
        ))
      }
      setMessage('Printer profile saved for this outlet.')
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
      if (deviceBinding.selected_profile_id === form.id) {
        setDeviceBinding(clearPrinterDeviceBinding(selectedOutletId))
      }

      await refreshProfiles(remaining[0]?.id || '')
      setMessage('Printer profile deleted. Other outlet profiles were kept.')
    } catch (deleteError) {
      setError(deleteError.message || 'Printer profile could not be deleted')
    } finally {
      setDeleting(false)
    }
  }

  function useOnThisDevice() {
    if (!form.id) {
      setError('Save this profile before assigning it to the device.')
      return
    }
    if (!form.enabled) {
      setError('Enable this profile before assigning it to the device.')
      return
    }
    const binding = savePrinterDeviceBinding(
      selectedOutletId,
      form.id,
      form.station_device_name || form.profile_name,
    )
    setDeviceBinding(binding)
    savePrinterProfilesSnapshot(selectedOutletId, profiles)
    setMessage(`This device now uses “${form.profile_name}”. The selection stays with this device and outlet.`)
    setError('')
  }

  function useOutletDefaultOnDevice() {
    const binding = clearPrinterDeviceBinding(selectedOutletId)
    setDeviceBinding(binding)
    const selected = outletProfiles.find((profile) => profile.is_default) || outletProfiles[0]
    if (selected) selectProfile(selected)
    setMessage('This device now follows the outlet default printer profile.')
  }

  async function testConnection() {
    const validationError = validate()
    if (validationError) {
      setError(validationError)
      return
    }
    if (!isDirect) {
      setDiagnostic({ tone: 'info', text: 'System Print uses the Android or browser driver. Open a test label to verify that driver.' })
      return
    }
    setTesting(true)
    setError('')
    setDiagnostic(null)
    try {
      const result = await testDirectPrinterProfile(form)
      setDiagnostic({ tone: 'success', text: `Connected to ${result.printer || form.profile_name}. The transport is ready.` })
    } catch (testError) {
      setDiagnostic({ tone: 'error', text: testError.message || 'Printer connection test failed.' })
    } finally {
      setTesting(false)
    }
  }

  async function calibrateMedia() {
    const validationError = validate()
    if (validationError) {
      setError(validationError)
      return
    }
    if (!canCalibrate) {
      setDiagnostic({ tone: 'info', text: 'Calibration requires TSPL, ZPL or CPCL with Gap or Black mark media.' })
      return
    }
    if (!window.confirm('The printer may feed several labels while detecting the sensor. Continue calibration?')) return
    setCalibrating(true)
    setError('')
    setDiagnostic(null)
    try {
      const result = await calibrateDirectPrinterProfile(form)
      setDiagnostic({ tone: 'success', text: `Calibration command sent to ${result.printer || form.profile_name}. Wait for the feed cycle to stop.` })
    } catch (calibrationError) {
      setDiagnostic({ tone: 'error', text: calibrationError.message || 'Printer media calibration failed.' })
    } finally {
      setCalibrating(false)
    }
  }

  function previewTestLabel() {
    if (!form.id) {
      setError('Save this profile before printing a test label.')
      return
    }
    if (!form.enabled) {
      setError('Enable this profile before printing a test label.')
      return
    }

    const binding = savePrinterDeviceBinding(
      selectedOutletId,
      form.id,
      form.station_device_name || form.profile_name,
    )
    setDeviceBinding(binding)

    const width = Math.max(20, numberValue(form.label_width_mm, 40))
    const height = Math.max(15, numberValue(form.label_height_mm, 30))
    const raw = `<!doctype html><html><head><title>Stupiak's Ops Test Label</title><style>
      @page{size:${width}mm ${height}mm;margin:0}*{box-sizing:border-box}body{margin:0;width:${width}mm;height:${height}mm;font-family:Arial,sans-serif;color:#000}.label{width:${width}mm;height:${height}mm;display:flex;flex-direction:column}.title{font-size:9pt;font-weight:900;border-bottom:.3mm solid #000;padding-bottom:.5mm}.meta{font-size:5.5pt;font-weight:800;margin-top:.5mm}.time{display:grid;grid-template-columns:1fr 1fr;gap:.7mm;margin-top:.7mm}.box{border:.2mm solid #000;padding:.5mm;font-size:5pt}.box strong{display:block;font-size:6pt;margin-top:.4mm}.batch{margin-top:auto;text-align:center;font:700 5pt monospace}
    </style></head><body><div class="label"><div class="title">TEST LABEL</div><div class="meta">${escapeHtml(String(form.command_language || form.connection_type || '').toUpperCase())} • ${escapeHtml(selectedOutlet?.name || selectedOutletId)}</div><div class="time"><div class="box">MADE 14:30<strong>28 JUL 2026</strong></div><div class="box">USE BY 14:30<strong>29 JUL 2026</strong></div></div><div class="batch">${escapeHtml(form.profile_name)} · TEST</div></div><script>window.onload=()=>setTimeout(()=>window.print(),80)</script></body></html>`
    const transformed = applyPrinterLayoutToHtml(raw, form)
    const win = window.open('', '_blank', 'width=480,height=640')
    if (!win) {
      setError('The app blocked the test-label window.')
      return
    }
    win.document.open()
    win.document.write(transformed.html)
    win.document.close()
    setMessage(`Test label prepared with “${form.profile_name}”: ${summaryText(transformed.layout)}.`)
  }

  return (
    <div className="chefops-page mx-auto w-full max-w-6xl space-y-4 p-3 pb-36 sm:p-5 sm:pb-32">
      <header className="rounded-3xl border border-border bg-card p-4 shadow-sm sm:p-5">
        <div className="flex items-start gap-3">
          <Button asChild variant="outline" size="icon" className="h-10 w-10 shrink-0 rounded-xl">
            <Link to="/labels"><ArrowLeft className="h-4 w-4" /></Link>
          </Button>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-xl font-heading font-bold sm:text-2xl">Label printer settings</h1>
              <Tag tone="success">Outlet shared</Tag>
              <Tag>{isNativeAndroid() ? 'Android controls ready' : 'Web / system print'}</Tag>
            </div>
            <p className="mt-1 max-w-3xl text-xs leading-5 text-muted-foreground sm:text-sm">
              Add different printer models and connections without changing label data. The selected profile remains bound to this device and outlet, not the employee account.
            </p>
          </div>
        </div>

        <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
          <HeaderMetric label="Outlet" value={selectedOutlet?.name || selectedOutletId || 'Not assigned'} />
          <HeaderMetric label="Profiles" value={String(outletProfiles.length)} />
          <HeaderMetric label="This device" value={outletProfiles.find((profile) => profile.id === deviceBinding.selected_profile_id)?.profile_name || 'Outlet default'} />
          <HeaderMetric label="Label rules" value={source ? `${source.summary?.ruleCount ?? 0} active` : 'Unavailable'} />
        </div>
      </header>

      {loading ? (
        <div className="flex justify-center py-24"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
      ) : (
        <>
          <Section icon={Server} title="Printer profiles" subtitle="Choose an outlet profile or create a separate profile for every printer and connection.">
            <div className="grid gap-3 lg:grid-cols-[minmax(0,260px)_minmax(0,1fr)]">
              <Field label="Outlet">
                <select className="h-11 w-full rounded-xl border border-input bg-background px-3 text-sm" value={selectedOutletId} onChange={(event) => changeOutlet(event.target.value)}>
                  {outlets.map((outlet) => <option key={outlet.id} value={outlet.id}>{outlet.name || outlet.code || outlet.id}</option>)}
                </select>
              </Field>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                <Button type="button" variant="outline" onClick={createProfile}><Plus className="mr-2 h-4 w-4" />New profile</Button>
                <Button type="button" variant="outline" onClick={duplicateProfile} disabled={!form.id}><Copy className="mr-2 h-4 w-4" />Duplicate</Button>
                <Button type="button" variant="outline" onClick={loadAll}><RefreshCw className="mr-2 h-4 w-4" />Refresh</Button>
              </div>
            </div>

            <div className="mt-4 grid grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-3">
              {outletProfiles.map((profile) => {
                const active = selectedProfileId === profile.id
                const onDevice = deviceBinding.selected_profile_id === profile.id
                return (
                  <button key={profile.id} type="button" onClick={() => selectProfile(profile)} className={`rounded-2xl border p-3.5 text-left transition ${active ? 'border-primary bg-primary/10 shadow-sm' : 'border-border bg-background active:bg-muted'}`}>
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-semibold">{profile.profile_name}</p>
                        <p className="mt-1 truncate text-xs text-muted-foreground">{profile.brand || profile.model ? `${profile.brand || ''} ${profile.model || ''}`.trim() : connectionLabel(profile)}</p>
                      </div>
                      {active ? <CheckCircle2 className="h-4 w-4 shrink-0 text-primary" /> : <Printer className="h-4 w-4 shrink-0 text-muted-foreground" />}
                    </div>
                    <p className="mt-2 line-clamp-2 text-[11px] leading-4 text-muted-foreground">{connectionLabel(profile)} · {profile.command_language.toUpperCase()} · {profile.label_width_mm}×{profile.label_height_mm} mm</p>
                    <div className="mt-2 flex flex-wrap gap-1">
                      {profile.is_default ? <Tag>Outlet default</Tag> : null}
                      {onDevice ? <Tag tone="success">This device</Tag> : null}
                      {!profile.enabled ? <Tag tone="warning">Disabled</Tag> : null}
                    </div>
                  </button>
                )
              })}
            </div>

            {!outletProfiles.length ? <p className="mt-3 rounded-2xl border border-dashed p-5 text-sm text-muted-foreground">No printer profile yet. Create the first profile and choose the closest preset.</p> : null}
          </Section>

          <Section icon={Sparkles} title="Quick printer preset" subtitle="Start from a safe command-language preset, then enter the real connection and media measurements.">
            <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
              {PRINTER_PRESETS.map((preset) => {
                const active = form.preset_id === preset.id
                return (
                  <button key={preset.id} type="button" onClick={() => choosePreset(preset.id)} className={`rounded-2xl border p-3 text-left transition ${active ? 'border-primary bg-primary/10' : 'border-border bg-background active:bg-muted'}`}>
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-sm font-semibold">{preset.label}</p>
                      {active ? <CheckCircle2 className="h-4 w-4 text-primary" /> : null}
                    </div>
                    <p className="mt-1 text-xs leading-4 text-muted-foreground">{preset.description}</p>
                  </button>
                )
              })}
            </div>
          </Section>

          <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1.05fr)_minmax(360px,.95fr)]">
            <div className="space-y-4">
              <Section icon={Printer} title="Printer and connection" subtitle="Name the printer, select how this device reaches it, and choose the command language.">
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <Field label="Profile name"><Input value={form.profile_name} onChange={(event) => update('profile_name', event.target.value)} placeholder="Cashier label printer" /></Field>
                  <Field label="Station name"><Input value={form.station_device_name} onChange={(event) => update('station_device_name', event.target.value)} placeholder="Cashier counter" /></Field>
                  <Field label="Printer brand"><Input value={form.brand} onChange={(event) => update('brand', event.target.value)} placeholder="Optional" /></Field>
                  <Field label="Printer model"><Input value={form.model} onChange={(event) => update('model', event.target.value)} placeholder="Optional" /></Field>
                </div>

                <div className="mt-4 grid grid-cols-3 gap-2">
                  <ConnectionChoice value="system_print" label="System driver" icon={Printer} current={form.connection_type} onSelect={chooseConnection} />
                  <ConnectionChoice value="network" label="Wi-Fi / LAN" icon={Wifi} current={form.connection_type} onSelect={chooseConnection} />
                  <ConnectionChoice value="bluetooth" label="Bluetooth Classic" icon={Bluetooth} current={form.connection_type} onSelect={chooseConnection} />
                </div>

                {form.connection_type === 'network' ? (
                  <div className="mt-4 rounded-2xl border border-border bg-muted/20 p-3.5">
                    <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Network transport</p>
                    <div className="mt-3 grid grid-cols-2 gap-2">
                      <SegmentChoice active={form.network_protocol === 'raw_tcp'} label="Raw TCP / 9100" onClick={() => chooseProtocol('raw_tcp')} />
                      <SegmentChoice active={form.network_protocol === 'lpr'} label="LPR / 515" onClick={() => chooseProtocol('lpr')} />
                    </div>
                    <div className="mt-3 grid grid-cols-[minmax(0,1fr)_100px] gap-3">
                      <Field label="Printer IP"><Input value={form.ip_address} onChange={(event) => update('ip_address', event.target.value)} placeholder="192.168.1.50" inputMode="decimal" /></Field>
                      <Field label="Port"><Input type="number" min="1" max="65535" value={form.port} onChange={(event) => update('port', event.target.value)} /></Field>
                    </div>
                    {form.network_protocol === 'lpr' ? <Field label="LPR queue" className="mt-3" hint="Usually lp, raw, PASSTHRU or the queue configured by the printer."><Input value={form.lpr_queue} onChange={(event) => update('lpr_queue', event.target.value)} placeholder="lp" /></Field> : null}
                  </div>
                ) : null}

                {form.connection_type === 'bluetooth' ? (
                  <div className="mt-4 rounded-2xl border border-border bg-muted/20 p-3.5">
                    <div className="flex items-start gap-2 rounded-xl bg-background p-3 text-xs leading-5 text-muted-foreground">
                      <Bluetooth className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                      Pair the printer in Android Bluetooth settings first. Direct printing uses Bluetooth Classic / SPP; BLE and vendor-only Bluetooth should use System Print.
                    </div>
                    <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
                      <Field label="Paired device name"><Input value={form.bluetooth_device_name} onChange={(event) => update('bluetooth_device_name', event.target.value)} placeholder="Printer name" /></Field>
                      <Field label="MAC address"><Input value={form.bluetooth_device_id} onChange={(event) => update('bluetooth_device_id', event.target.value)} placeholder="AA:BB:CC:DD:EE:FF" /></Field>
                    </div>
                  </div>
                ) : null}

                <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <Field label="Command language" hint={form.connection_type === 'system_print' ? 'System Print uses the Android/browser driver.' : 'Choose the language supported by the printer firmware.'}>
                    <select className="h-11 w-full rounded-xl border border-input bg-background px-3 text-sm" value={form.command_language} disabled={form.connection_type === 'system_print'} onChange={(event) => update('command_language', event.target.value)}>
                      <option value="browser">Browser / system</option>
                      <option value="tspl">TSPL</option>
                      <option value="zpl">ZPL</option>
                      <option value="cpcl">CPCL</option>
                      <option value="escpos">ESC/POS raster</option>
                    </select>
                  </Field>
                  <Field label="Connection timeout (ms)"><Input type="number" min="1000" max="30000" step="500" value={form.connection_timeout_ms} onChange={(event) => update('connection_timeout_ms', event.target.value)} /></Field>
                </div>

                <div className="mt-4 grid grid-cols-2 gap-2">
                  <Button type="button" variant="outline" onClick={testConnection} disabled={testing}>
                    {testing ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Radio className="mr-2 h-4 w-4" />}Test connection
                  </Button>
                  <Button type="button" variant="outline" onClick={calibrateMedia} disabled={calibrating || !canCalibrate}>
                    {calibrating ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}Calibrate media
                  </Button>
                </div>

                {diagnostic ? <Diagnostic tone={diagnostic.tone}>{diagnostic.text}</Diagnostic> : null}
              </Section>

              <Section icon={Ruler} title="Physical media and sensor" subtitle="These values control the actual roll. Width never swaps with feed length.">
                <div className="rounded-2xl border border-amber-200 bg-amber-50 p-3.5 text-xs leading-5 text-amber-900">
                  <p className="font-semibold">Direct Wi-Fi / Bluetooth printing bypasses the Android driver paper size.</p>
                  <p className="mt-1">Media width is across the print head. Feed length is one label from sensor gap to sensor gap. Your current roll is 40 × 30 mm.</p>
                </div>

                <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
                  <Field label="Media width (mm)"><Input type="number" min="1" step="0.1" value={form.label_width_mm} onChange={(event) => update('label_width_mm', event.target.value)} /></Field>
                  <Field label="Feed length (mm)"><Input type="number" min="1" step="0.1" value={form.label_height_mm} onChange={(event) => update('label_height_mm', event.target.value)} /></Field>
                  <Field label="DPI"><Input type="number" min="72" max="1200" value={form.dpi} onChange={(event) => update('dpi', event.target.value)} /></Field>
                  <Field label="Copies"><Input type="number" min="1" max="100" value={form.default_copies} onChange={(event) => update('default_copies', event.target.value)} /></Field>
                </div>

                <p className="mt-4 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Media sensor</p>
                <div className="mt-2 grid grid-cols-3 gap-2">
                  <SegmentChoice active={form.media_sensor === 'gap'} label="Gap" onClick={() => update('media_sensor', 'gap')} />
                  <SegmentChoice active={form.media_sensor === 'black_mark'} label="Black mark" onClick={() => update('media_sensor', 'black_mark')} />
                  <SegmentChoice active={form.media_sensor === 'continuous'} label="Continuous" onClick={() => update('media_sensor', 'continuous')} />
                </div>

                {form.media_sensor === 'gap' ? (
                  <div className="mt-3 grid grid-cols-2 gap-3">
                    <Field label="Gap size (mm)"><Input type="number" min="0" max="20" step="0.1" value={form.gap_mm} onChange={(event) => update('gap_mm', event.target.value)} /></Field>
                    <Field label="Gap offset (mm)"><Input type="number" min="-20" max="20" step="0.1" value={form.gap_offset_mm} onChange={(event) => update('gap_offset_mm', event.target.value)} /></Field>
                  </div>
                ) : null}

                {form.media_sensor === 'black_mark' ? (
                  <div className="mt-3 grid grid-cols-2 gap-3">
                    <Field label="Mark length (mm)"><Input type="number" min="0.1" max="20" step="0.1" value={form.black_mark_mm} onChange={(event) => update('black_mark_mm', event.target.value)} /></Field>
                    <Field label="Mark offset (mm)"><Input type="number" min="-20" max="20" step="0.1" value={form.black_mark_offset_mm} onChange={(event) => update('black_mark_offset_mm', event.target.value)} /></Field>
                  </div>
                ) : null}
              </Section>

              <Section icon={SlidersHorizontal} title="Print quality and alignment" subtitle="Tune darkness and speed for the material, then use origin offsets for final positioning.">
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                  <Field label="Speed (mm/s)"><Input type="number" min="10" max="305" step="1" value={form.print_speed_mm_s} onChange={(event) => update('print_speed_mm_s', event.target.value)} /></Field>
                  <Field label="Darkness (0–15)"><Input type="number" min="0" max="15" step="1" value={form.darkness} onChange={(event) => update('darkness', event.target.value)} /></Field>
                  <Field label="X offset (mm)"><Input type="number" min="-20" max="20" step="0.1" value={form.x_offset_mm} onChange={(event) => update('x_offset_mm', event.target.value)} /></Field>
                  <Field label="Y offset (mm)"><Input type="number" min="-20" max="20" step="0.1" value={form.y_offset_mm} onChange={(event) => update('y_offset_mm', event.target.value)} /></Field>
                </div>

                <Field label="Content preference" className="mt-4" hint="This preference never changes the physical media width or feed length.">
                  <select className="h-11 w-full rounded-xl border border-input bg-background px-3 text-sm" value={form.orientation} onChange={(event) => update('orientation', event.target.value)}>
                    <option value="auto">Auto — keep physical media size</option>
                    <option value="portrait">Portrait content — media stays fixed</option>
                    <option value="landscape">Landscape content — media stays fixed</option>
                  </select>
                </Field>

                <p className="mt-4 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Four-side content padding (mm)</p>
                <div className="mt-2 grid grid-cols-2 gap-3 sm:grid-cols-4">
                  <Field label="Top"><Input type="number" min="0" step="0.05" value={form.padding_top_mm} onChange={(event) => update('padding_top_mm', event.target.value)} /></Field>
                  <Field label="Right"><Input type="number" min="0" step="0.05" value={form.padding_right_mm} onChange={(event) => update('padding_right_mm', event.target.value)} /></Field>
                  <Field label="Bottom"><Input type="number" min="0" step="0.05" value={form.padding_bottom_mm} onChange={(event) => update('padding_bottom_mm', event.target.value)} /></Field>
                  <Field label="Left"><Input type="number" min="0" step="0.05" value={form.padding_left_mm} onChange={(event) => update('padding_left_mm', event.target.value)} /></Field>
                </div>
              </Section>

              <details className="rounded-3xl border border-border bg-card p-4 sm:p-5">
                <summary className="flex cursor-pointer list-none items-center gap-2 text-sm font-semibold"><Settings2 className="h-4 w-4 text-primary" />Advanced behavior and notes</summary>
                <div className="mt-4 space-y-4">
                  <div className="overflow-hidden rounded-2xl border border-border">
                    <CheckRow label="Outlet default profile" checked={form.is_default} onChange={(value) => update('is_default', value)} />
                    <CheckRow label="Profile enabled" checked={form.enabled} onChange={(value) => update('enabled', value)} />
                    <CheckRow label="Auto print after label creation" checked={form.auto_print} onChange={(value) => update('auto_print', value)} />
                    <CheckRow label="Keep printer connection ready" checked={form.standby_enabled} onChange={(value) => update('standby_enabled', value)} />
                    <CheckRow label="Reconnect automatically" checked={form.auto_reconnect} onChange={(value) => update('auto_reconnect', value)} />
                    <CheckRow label="Queue labels while offline" checked={form.queue_when_offline} onChange={(value) => update('queue_when_offline', value)} />
                  </div>
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <Field label="Retry limit"><Input type="number" min="0" max="20" value={form.retry_limit} onChange={(event) => update('retry_limit', event.target.value)} /></Field>
                    <Field label="Station mode">
                      <select className="h-11 w-full rounded-xl border border-input bg-background px-3 text-sm" value={form.station_mode} onChange={(event) => update('station_mode', event.target.value)}>
                        <option value="this_device">This device</option>
                        <option value="shared_station">Shared print station</option>
                        <option value="outlet_default">Outlet default station</option>
                      </select>
                    </Field>
                  </div>
                  <Field label="Notes"><Input value={form.user_notes} onChange={(event) => update('user_notes', event.target.value)} placeholder="Paper type, location or maintenance note" /></Field>
                  <Button type="button" variant="outline" className="w-full border-rose-300 text-rose-700" onClick={removeProfile} disabled={!form.id || deleting}>
                    {deleting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Trash2 className="mr-2 h-4 w-4" />}Delete selected profile
                  </Button>
                </div>
              </details>
            </div>

            <div className="space-y-4 lg:sticky lg:top-4">
              <Section icon={Gauge} title="Live output summary" subtitle="Review physical media, sensor and transport before saving or printing.">
                <MediaPreview profile={form} layout={resolvedLayout} />
                <div className="mt-4 space-y-2 rounded-2xl bg-muted/50 p-3 text-xs">
                  <Status label="Physical media" value={`${resolvedLayout.width_mm} × ${resolvedLayout.height_mm} mm`} good />
                  <Status label="Connection" value={connectionLabel(form)} />
                  <Status label="Language" value={String(form.command_language || 'browser').toUpperCase()} />
                  <Status label="Sensor" value={form.media_sensor === 'black_mark' ? `Black mark · ${form.black_mark_mm} mm` : form.media_sensor === 'continuous' ? 'Continuous' : `Gap · ${form.gap_mm} mm`} />
                  <Status label="Quality" value={`${form.print_speed_mm_s} mm/s · darkness ${form.darkness}/15`} />
                  <Status label="Origin offset" value={`${form.x_offset_mm}/${form.y_offset_mm} mm`} />
                </div>
                <p className="mt-3 rounded-xl border border-border bg-background p-3 text-xs leading-5 text-muted-foreground">{formatPrinterHardwareSummary(form)}</p>
              </Section>

              <Section icon={Smartphone} title="Use on this device" subtitle="The profile selection stays with this phone/tablet and outlet.">
                <div className="space-y-2 rounded-2xl bg-muted/50 p-3 text-xs">
                  <Status label="Device ID" value={getOrCreatePrinterDeviceId().slice(0, 18)} />
                  <Status label="Selected profile" value={outletProfiles.find((profile) => profile.id === deviceBinding.selected_profile_id)?.profile_name || 'Follow outlet default'} good={selectedOnDevice} />
                  <Status label="Binding" value="Device + outlet" good />
                  <Status label="Profile status" value={form.enabled ? 'Enabled' : 'Disabled'} good={form.enabled} />
                </div>
                <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2">
                  <Button type="button" onClick={useOnThisDevice} disabled={!form.id || selectedOnDevice}><Smartphone className="mr-2 h-4 w-4" />Use this profile</Button>
                  <Button type="button" variant="outline" onClick={useOutletDefaultOnDevice}>Follow outlet default</Button>
                </div>
              </Section>

              <div className="flex items-start gap-3 rounded-2xl border border-primary/20 bg-primary/5 p-3.5 text-xs leading-5">
                <UsersRound className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                <p><span className="font-semibold">Staff access is outlet-scoped.</span> Team members can maintain shared profiles only for the outlet assigned to their account.</p>
              </div>
            </div>
          </div>

          {error ? <Diagnostic tone="error">{error}</Diagnostic> : null}
          {message ? <Diagnostic tone="success">{message}</Diagnostic> : null}

          <div className="fixed inset-x-0 bottom-[calc(var(--chefops-mobile-nav-height,4.5rem)+env(safe-area-inset-bottom))] z-30 mx-auto w-full max-w-6xl px-3 sm:static sm:px-0">
            <div className="grid grid-cols-2 gap-2 rounded-2xl border border-border bg-background/95 p-3 shadow-xl backdrop-blur sm:grid-cols-4 sm:rounded-3xl">
              <Button type="button" variant="outline" onClick={testConnection} disabled={testing}>
                {testing ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Network className="mr-2 h-4 w-4" />}Connection
              </Button>
              <Button type="button" variant="outline" onClick={calibrateMedia} disabled={calibrating || !canCalibrate}>
                {calibrating ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}Calibrate
              </Button>
              <Button type="button" variant="outline" onClick={previewTestLabel} disabled={!form.id}><Printer className="mr-2 h-4 w-4" />Test label</Button>
              <Button type="button" onClick={save} disabled={saving}>{saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}Save profile</Button>
            </div>
          </div>
        </>
      )}
    </div>
  )
}

function Section({ icon: Icon, title, subtitle, children }) {
  return (
    <section className="rounded-3xl border border-border bg-card p-4 shadow-sm sm:p-5">
      <div className="mb-4 flex items-start gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary"><Icon className="h-4 w-4" /></div>
        <div className="min-w-0">
          <h2 className="text-sm font-semibold sm:text-base">{title}</h2>
          {subtitle ? <p className="mt-0.5 text-xs leading-5 text-muted-foreground">{subtitle}</p> : null}
        </div>
      </div>
      {children}
    </section>
  )
}

function Field({ label, hint = '', className = '', children }) {
  return (
    <div className={`space-y-1.5 ${className}`}>
      <Label>{label}</Label>
      {children}
      {hint ? <p className="text-[11px] leading-4 text-muted-foreground">{hint}</p> : null}
    </div>
  )
}

function CheckRow({ label, checked, onChange }) {
  return <label className="flex cursor-pointer items-center justify-between gap-3 border-b border-border p-3.5 last:border-b-0"><span className="text-sm font-medium">{label}</span><input type="checkbox" checked={Boolean(checked)} onChange={(event) => onChange(event.target.checked)} className="h-5 w-5 accent-[hsl(var(--primary))]" /></label>
}

function Status({ label, value, good = false }) {
  return <div className="flex items-start justify-between gap-3"><span className="text-muted-foreground">{label}</span><span className={`max-w-[62%] text-right font-medium ${good ? 'text-emerald-600' : ''}`}>{value}</span></div>
}

function Tag({ children, tone = 'neutral' }) {
  const style = tone === 'success'
    ? 'bg-emerald-500/10 text-emerald-700'
    : tone === 'warning'
      ? 'bg-amber-500/10 text-amber-700'
      : 'bg-muted text-muted-foreground'
  return <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${style}`}>{children}</span>
}

function ConnectionChoice({ value, label, icon: Icon, current, onSelect }) {
  const active = current === value
  return (
    <button type="button" onClick={() => onSelect(value)} className={`flex min-h-24 min-w-0 flex-col items-center justify-center gap-1.5 rounded-2xl border p-2 text-center transition ${active ? 'border-primary bg-primary/10 text-foreground shadow-sm' : 'border-border bg-background text-muted-foreground active:bg-muted'}`}>
      <Icon className="h-5 w-5" />
      <span className="text-[10px] font-semibold leading-tight sm:text-xs">{label}</span>
      {active ? <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" /> : null}
    </button>
  )
}

function SegmentChoice({ active, label, onClick }) {
  return <button type="button" onClick={onClick} className={`min-h-11 rounded-xl border px-3 text-xs font-semibold transition ${active ? 'border-primary bg-primary/10 text-foreground' : 'border-border bg-background text-muted-foreground active:bg-muted'}`}>{label}</button>
}

function HeaderMetric({ label, value }) {
  return <div className="min-w-0 rounded-2xl bg-muted/50 p-3"><p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</p><p className="mt-1 truncate text-xs font-semibold sm:text-sm">{value}</p></div>
}

function Diagnostic({ tone, children }) {
  const error = tone === 'error'
  const success = tone === 'success'
  const style = error
    ? 'border-rose-200 bg-rose-50 text-rose-800'
    : success
      ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
      : 'border-blue-200 bg-blue-50 text-blue-800'
  const Icon = error ? CircleAlert : success ? CheckCircle2 : Radio
  return <div className={`mt-3 flex items-start gap-2 rounded-2xl border p-3 text-xs leading-5 ${style}`}><Icon className="mt-0.5 h-4 w-4 shrink-0" /><p>{children}</p></div>
}

function MediaPreview({ profile, layout }) {
  const width = Math.max(1, Number(layout.width_mm || 40))
  const height = Math.max(1, Number(layout.height_mm || 30))
  const top = Math.min(30, Math.max(0, (Number(layout.padding_top_mm || 0) / height) * 100))
  const right = Math.min(30, Math.max(0, (Number(layout.padding_right_mm || 0) / width) * 100))
  const bottom = Math.min(30, Math.max(0, (Number(layout.padding_bottom_mm || 0) / height) * 100))
  const left = Math.min(30, Math.max(0, (Number(layout.padding_left_mm || 0) / width) * 100))
  const x = Math.max(-35, Math.min(35, (Number(profile.x_offset_mm || 0) / width) * 100))
  const y = Math.max(-35, Math.min(35, (Number(profile.y_offset_mm || 0) / height) * 100))

  return (
    <div className="rounded-2xl border border-border bg-muted/30 p-4">
      <div className="mx-auto flex w-full max-w-sm items-center justify-center">
        <div className="relative w-full overflow-hidden rounded-xl border-2 border-foreground/70 bg-white shadow-sm" style={{ aspectRatio: `${width} / ${height}` }}>
          <div className="absolute rounded-lg border border-dashed border-primary/70 bg-primary/5" style={{ top: `${top}%`, right: `${right}%`, bottom: `${bottom}%`, left: `${left}%`, transform: `translate(${x}%, ${y}%)` }}>
            <div className="flex h-full flex-col justify-between p-2 text-[9px] font-bold text-black sm:text-[10px]">
              <span>STUPIAK TEST</span>
              <span className="self-center rounded border border-black px-1">40×30</span>
              <span className="self-end">LABEL</span>
            </div>
          </div>
          <div className="absolute bottom-1 left-1 rounded bg-black/75 px-1.5 py-0.5 text-[8px] font-semibold text-white">Feed ↓</div>
        </div>
      </div>
      <div className="mt-3 flex flex-wrap justify-center gap-2 text-[10px] text-muted-foreground">
        <span className="rounded-full bg-background px-2 py-1"><Ruler className="mr-1 inline h-3 w-3" />{width} × {height} mm</span>
        <span className="rounded-full bg-background px-2 py-1"><Move className="mr-1 inline h-3 w-3" />Offset {profile.x_offset_mm}/{profile.y_offset_mm}</span>
        <span className="rounded-full bg-background px-2 py-1"><Gauge className="mr-1 inline h-3 w-3" />{profile.dpi} dpi</span>
      </div>
    </div>
  )
}
