import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  ArrowLeft,
  Bluetooth,
  CheckCircle2,
  Copy,
  Loader2,
  Network,
  Plus,
  Printer,
  Save,
  Server,
  Settings2,
  Smartphone,
  Trash2,
  UsersRound,
} from 'lucide-react'

import { opsClient } from '@/api/opsClient'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useAuth } from '@/lib/AuthContext'
import {
  DEFAULT_PRINTER_LAYOUT,
  applyPrinterLayoutToHtml,
  clearLegacyPrinterDraft,
  clearPrinterDeviceBinding,
  encodePrinterProfileNotes,
  getOrCreatePrinterDeviceId,
  normalizePrinterProfile,
  readPrinterDeviceBinding,
  resolvePrinterLayout,
  savePrinterDeviceBinding,
  savePrinterProfilesSnapshot,
} from '@/lib/label-printer-profile'

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
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')

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
  }

  function createProfile() {
    setSelectedProfileId('__new__')
    setForm({
      ...emptyProfile(selectedOutletId),
      profile_name: `Food Label Printer ${outletProfiles.length + 1}`,
      is_default: outletProfiles.length === 0,
    })
    setMessage('New profile started. Save it before assigning it to this device.')
    setError('')
  }

  function duplicateProfile() {
    setSelectedProfileId('__new__')
    setForm({
      ...form,
      id: '',
      profile_name: `${form.profile_name || 'Food Label Printer'} Copy`,
      is_default: false,
    })
    setMessage('Profile copied. Save to create the separate profile.')
    setError('')
  }

  function update(key, value) {
    setForm((current) => ({ ...current, [key]: value }))
    setMessage('')
    setError('')
  }

  function validate() {
    if (!selectedOutletId) return 'Your account must be assigned to an outlet.'
    if (!String(form.profile_name || '').trim()) return 'Enter a printer profile name.'
    if (numberValue(form.label_width_mm, 0) <= 0 || numberValue(form.label_height_mm, 0) <= 0) return 'Enter a valid label size.'
    if (numberValue(form.default_copies, 0) < 1) return 'Default copies must be at least 1.'
    if ([form.padding_top_mm, form.padding_right_mm, form.padding_bottom_mm, form.padding_left_mm].some((value) => numberValue(value, -1) < 0)) return 'Padding cannot be negative.'
    if (form.connection_type === 'network' && !String(form.ip_address || '').trim()) return 'Enter the printer IP address.'
    if (form.connection_type === 'bluetooth' && !String(form.bluetooth_device_name || form.bluetooth_device_id || '').trim()) return 'Enter a Bluetooth device name or ID.'
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
      port: numberValue(form.port, 9100),
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
      return
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
    } catch (saveError) {
      setError(saveError.message || 'Printer profile could not be saved')
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
    setMessage(`This device now uses “${form.profile_name}”. The selection stays with this device, not the employee account.`)
    setError('')
  }

  function useOutletDefaultOnDevice() {
    const binding = clearPrinterDeviceBinding(selectedOutletId)
    setDeviceBinding(binding)
    const selected = outletProfiles.find((profile) => profile.is_default) || outletProfiles[0]
    if (selected) selectProfile(selected)
    setMessage('This device now follows the outlet default printer profile.')
  }

  function previewTestLabel() {
    if (!form.id) {
      setError('Save this profile before printing a test label.')
      return
    }
    const width = Math.max(20, numberValue(form.label_width_mm, 40))
    const height = Math.max(15, numberValue(form.label_height_mm, 30))
    const raw = `<!doctype html><html><head><title>Stupiak's Ops Test Label</title><style>
      @page{size:${width}mm ${height}mm;margin:0}*{box-sizing:border-box}body{margin:0;width:${width}mm;height:${height}mm;font-family:Arial,sans-serif;color:#000}.label{width:${width}mm;height:${height}mm;display:flex;flex-direction:column}.title{font-size:9pt;font-weight:900;border-bottom:.3mm solid #000;padding-bottom:.5mm}.meta{font-size:5.5pt;font-weight:800;margin-top:.5mm}.time{display:grid;grid-template-columns:1fr 1fr;gap:.7mm;margin-top:.7mm}.box{border:.2mm solid #000;padding:.5mm;font-size:5pt}.box strong{display:block;font-size:6pt;margin-top:.4mm}.batch{margin-top:auto;text-align:center;font:700 5pt monospace}
    </style></head><body><div class="label"><div class="title">TEST LABEL</div><div class="meta">${escapeHtml(String(form.connection_type || '').toUpperCase())} • ${escapeHtml(selectedOutlet?.name || selectedOutletId)}</div><div class="time"><div class="box">MADE 14:30<strong>28 JUL 2026</strong></div><div class="box">USE BY 14:30<strong>29 JUL 2026</strong></div></div><div class="batch">${escapeHtml(form.profile_name)} · TEST</div></div><script>window.onload=()=>setTimeout(()=>window.print(),80)</script></body></html>`
    const transformed = applyPrinterLayoutToHtml(raw, form)
    const win = window.open('', '_blank', 'width=480,height=640')
    if (!win) {
      setError('The app blocked the test-label window.')
      return
    }
    win.document.open()
    win.document.write(transformed.html)
    win.document.close()
    setMessage(`Test label prepared: ${summaryText(transformed.layout)}.`)
  }

  return (
    <div className="chefops-page mx-auto w-full max-w-5xl space-y-4 p-4 pb-28">
      <div className="flex items-start gap-3">
        <Button asChild variant="outline" size="icon" className="h-10 w-10 shrink-0">
          <Link to="/labels"><ArrowLeft className="h-4 w-4" /></Link>
        </Button>
        <div className="min-w-0 flex-1">
          <h1 className="text-xl font-heading font-bold">Label printer settings</h1>
          <p className="mt-0.5 text-xs leading-5 text-muted-foreground">Available to every signed-in team member for their assigned outlet.</p>
        </div>
      </div>

      <div className="flex items-start gap-3 rounded-2xl border border-primary/20 bg-primary/5 p-3.5 text-xs leading-5">
        <UsersRound className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
        <p><span className="font-semibold">Outlet-shared settings.</span> Profile changes are shared with the outlet. The selected profile on this phone remains bound to this device and outlet, not to the employee account.</p>
      </div>

      {loading ? (
        <div className="flex justify-center py-20"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
      ) : (
        <>
          <Section icon={Server} title="1. Choose outlet and profile">
            <Field label="Outlet">
              <select className="h-11 w-full rounded-xl border border-input bg-background px-3 text-sm" value={selectedOutletId} onChange={(event) => changeOutlet(event.target.value)}>
                {outlets.map((outlet) => <option key={outlet.id} value={outlet.id}>{outlet.name || outlet.code || outlet.id}</option>)}
              </select>
            </Field>

            <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {outletProfiles.map((profile) => {
                const active = selectedProfileId === profile.id
                const onDevice = deviceBinding.selected_profile_id === profile.id
                return (
                  <button key={profile.id} type="button" onClick={() => selectProfile(profile)} className={`rounded-2xl border p-3 text-left transition ${active ? 'border-primary bg-primary/10' : 'bg-background active:bg-muted'}`}>
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-semibold">{profile.profile_name}</p>
                        <p className="mt-1 truncate text-xs text-muted-foreground">{profile.brand || profile.model ? `${profile.brand || ''} ${profile.model || ''}`.trim() : profile.connection_type}</p>
                      </div>
                      {active ? <CheckCircle2 className="h-4 w-4 shrink-0 text-primary" /> : null}
                    </div>
                    <div className="mt-2 flex flex-wrap gap-1">
                      {profile.is_default ? <Tag>Outlet default</Tag> : null}
                      {onDevice ? <Tag>This device</Tag> : null}
                      {!profile.enabled ? <Tag>Disabled</Tag> : null}
                    </div>
                  </button>
                )
              })}
            </div>

            {!outletProfiles.length ? <p className="mt-3 rounded-2xl border border-dashed p-4 text-sm text-muted-foreground">No printer profile yet. Create the first one for this outlet.</p> : null}

            <div className="mt-3 grid grid-cols-2 gap-2">
              <Button type="button" variant="outline" onClick={createProfile}><Plus className="mr-2 h-4 w-4" />New</Button>
              <Button type="button" variant="outline" onClick={duplicateProfile} disabled={!form.id}><Copy className="mr-2 h-4 w-4" />Duplicate</Button>
            </div>
          </Section>

          <div className="grid gap-4 lg:grid-cols-2">
            <Section icon={Printer} title="2. Printer and connection">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
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

              <div className="mt-3 grid grid-cols-3 gap-2">
                <ConnectionChoice value="system_print" label="System" icon={Printer} current={form.connection_type} onSelect={(value) => update('connection_type', value)} />
                <ConnectionChoice value="network" label="Wi-Fi / LAN" icon={Network} current={form.connection_type} onSelect={(value) => update('connection_type', value)} />
                <ConnectionChoice value="bluetooth" label="Bluetooth" icon={Bluetooth} current={form.connection_type} onSelect={(value) => update('connection_type', value)} />
              </div>

              {form.connection_type === 'network' ? (
                <div className="mt-3 grid grid-cols-[minmax(0,1fr)_100px] gap-3">
                  <Field label="Printer IP"><Input value={form.ip_address} onChange={(event) => update('ip_address', event.target.value)} placeholder="192.168.1.50" inputMode="decimal" /></Field>
                  <Field label="Port"><Input type="number" min="1" max="65535" value={form.port} onChange={(event) => update('port', event.target.value)} /></Field>
                </div>
              ) : null}

              {form.connection_type === 'bluetooth' ? (
                <div className="mt-3 space-y-3">
                  <Field label="Bluetooth mode">
                    <select className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm" value={form.bluetooth_mode} onChange={(event) => update('bluetooth_mode', event.target.value)}>
                      <option value="classic">Bluetooth Classic</option>
                      <option value="system">Android paired printer</option>
                      <option value="ble">Bluetooth Low Energy</option>
                    </select>
                  </Field>
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <Field label="Device name"><Input value={form.bluetooth_device_name} onChange={(event) => update('bluetooth_device_name', event.target.value)} placeholder="Printer name" /></Field>
                    <Field label="Device ID / MAC"><Input value={form.bluetooth_device_id} onChange={(event) => update('bluetooth_device_id', event.target.value)} placeholder="Optional" /></Field>
                  </div>
                </div>
              ) : null}

              <div className="mt-3 overflow-hidden rounded-xl border border-border">
                <CheckRow label="Outlet default profile" checked={form.is_default} onChange={(value) => update('is_default', value)} />
                <CheckRow label="Profile enabled" checked={form.enabled} onChange={(value) => update('enabled', value)} />
              </div>
            </Section>

            <Section icon={Settings2} title="3. Physical label media">
              <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs leading-5 text-amber-900">
                <p className="font-semibold">Direct Wi-Fi / Bluetooth printing does not use the Android printer driver paper size.</p>
                <p className="mt-1">Width is the label width across the print head. Feed length is one label from gap to gap. For this roll use 40 mm × 30 mm. Orientation never swaps these physical values.</p>
              </div>

              <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-2">
                <Field label="Media width (mm)"><Input type="number" min="1" step="0.1" value={form.label_width_mm} onChange={(event) => update('label_width_mm', event.target.value)} /></Field>
                <Field label="Feed length (mm)"><Input type="number" min="1" step="0.1" value={form.label_height_mm} onChange={(event) => update('label_height_mm', event.target.value)} /></Field>
                <Field label="DPI"><Input type="number" min="72" value={form.dpi} onChange={(event) => update('dpi', event.target.value)} /></Field>
                <Field label="Copies"><Input type="number" min="1" max="100" value={form.default_copies} onChange={(event) => update('default_copies', event.target.value)} /></Field>
              </div>

              <Field label="Content preference" className="mt-3">
                <select className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm" value={form.orientation} onChange={(event) => update('orientation', event.target.value)}>
                  <option value="auto">Auto — keep physical media size</option>
                  <option value="portrait">Portrait content — media stays fixed</option>
                  <option value="landscape">Landscape content — media stays fixed</option>
                </select>
              </Field>

              <p className="mt-4 text-xs font-semibold">Four-side padding (mm)</p>
              <div className="mt-2 grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-2">
                <Field label="Top"><Input type="number" min="0" step="0.05" value={form.padding_top_mm} onChange={(event) => update('padding_top_mm', event.target.value)} /></Field>
                <Field label="Right"><Input type="number" min="0" step="0.05" value={form.padding_right_mm} onChange={(event) => update('padding_right_mm', event.target.value)} /></Field>
                <Field label="Bottom"><Input type="number" min="0" step="0.05" value={form.padding_bottom_mm} onChange={(event) => update('padding_bottom_mm', event.target.value)} /></Field>
                <Field label="Left"><Input type="number" min="0" step="0.05" value={form.padding_left_mm} onChange={(event) => update('padding_left_mm', event.target.value)} /></Field>
              </div>

              <div className="mt-3 rounded-xl bg-muted/60 p-3 text-xs font-medium">Output: {summaryText(resolvedLayout)}</div>
            </Section>
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <Section icon={Settings2} title="4. Print behavior">
              <div className="overflow-hidden rounded-xl border border-border">
                <CheckRow label="Auto print after label creation" checked={form.auto_print} onChange={(value) => update('auto_print', value)} />
                <CheckRow label="Keep printer connection ready" checked={form.standby_enabled} onChange={(value) => update('standby_enabled', value)} />
                <CheckRow label="Reconnect automatically" checked={form.auto_reconnect} onChange={(value) => update('auto_reconnect', value)} />
                <CheckRow label="Queue labels while offline" checked={form.queue_when_offline} onChange={(value) => update('queue_when_offline', value)} />
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
              <Field label="Station device name" className="mt-3"><Input value={form.station_device_name} onChange={(event) => update('station_device_name', event.target.value)} placeholder="Kitchen label station" /></Field>
              <Field label="Notes" className="mt-3"><Input value={form.user_notes} onChange={(event) => update('user_notes', event.target.value)} placeholder="Optional" /></Field>
            </Section>

            <Section icon={Smartphone} title="5. Use on this device">
              <div className="space-y-2 rounded-xl bg-muted/50 p-3 text-xs">
                <Status label="Device ID" value={getOrCreatePrinterDeviceId().slice(0, 18)} />
                <Status label="Selected profile" value={outletProfiles.find((profile) => profile.id === deviceBinding.selected_profile_id)?.profile_name || 'Follow outlet default'} />
                <Status label="Binding" value="Device + outlet" good />
                <Status label="Label rules" value={source ? `${source.summary?.productCount ?? 0} products · ${source.summary?.ruleCount ?? 0} rules` : 'Unavailable'} />
              </div>
              <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
                <Button type="button" onClick={useOnThisDevice} disabled={!form.id || deviceBinding.selected_profile_id === form.id}><Smartphone className="mr-2 h-4 w-4" />Use this profile</Button>
                <Button type="button" variant="outline" onClick={useOutletDefaultOnDevice}>Follow outlet default</Button>
              </div>
            </Section>
          </div>

          {error ? <div className="rounded-xl bg-destructive/10 p-3 text-sm text-destructive">{error}</div> : null}
          {message ? <div className="rounded-xl bg-emerald-500/10 p-3 text-sm text-emerald-700">{message}</div> : null}

          <div className="grid grid-cols-2 gap-2 rounded-2xl border border-border bg-background p-3 shadow-sm">
            <Button type="button" variant="outline" onClick={previewTestLabel}><Printer className="mr-2 h-4 w-4" />Test label</Button>
            <Button type="button" onClick={save} disabled={saving}>{saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}Save profile</Button>
            <Button type="button" variant="outline" className="col-span-2 border-rose-300 text-rose-700" onClick={removeProfile} disabled={!form.id || deleting}>
              {deleting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Trash2 className="mr-2 h-4 w-4" />}Delete selected profile
            </Button>
          </div>
        </>
      )}
    </div>
  )
}

function Section({ icon: Icon, title, children }) {
  return <section className="rounded-2xl border border-border bg-card p-4 sm:p-5"><div className="mb-3 flex items-center gap-2"><Icon className="h-4 w-4 text-primary" /><h2 className="text-sm font-semibold">{title}</h2></div>{children}</section>
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

function Tag({ children }) {
  return <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-semibold text-muted-foreground">{children}</span>
}

function ConnectionChoice({ value, label, icon: Icon, current, onSelect }) {
  const active = current === value
  return (
    <button type="button" onClick={() => onSelect(value)} className={`flex min-h-20 min-w-0 flex-col items-center justify-center gap-1.5 rounded-xl border p-2 text-center transition ${active ? 'border-primary bg-primary/10 text-foreground' : 'border-border bg-background text-muted-foreground active:bg-muted'}`}>
      <Icon className="h-5 w-5" />
      <span className="text-[10px] font-semibold leading-tight sm:text-xs">{label}</span>
      {active ? <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" /> : null}
    </button>
  )
}
