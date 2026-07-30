import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  ArrowLeft,
  CheckCircle2,
  Loader2,
  Monitor,
  Printer,
  RefreshCw,
  Save,
  Wifi,
} from 'lucide-react'

import { opsClient } from '@/api/opsClient'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useAuth } from '@/lib/AuthContext'
import {
  readPrinterDeviceBinding,
  savePrinterDeviceBinding,
  savePrinterProfilesSnapshot,
} from '@/lib/label-printer-profile'
import {
  describeConnectorFailure,
  fetchLocalConnector,
  localConnectorTarget,
  readWebPrinterDevice,
  saveWebPrinterDevice,
  stablePrinterProfile,
  webPrinterRouteLabel,
} from '@/lib/device-printer-v20'
import { encodePrinterTransportNotes, normalizePrinterTransportProfile } from '@/lib/printer-transport-v12'
import { isNativeAndroidPrinterRuntime, testPrinterProfile } from '@/lib/native-label-print'
import { printStableLabelHtmlV20 } from '@/lib/stable-label-print-v20'

const SETTINGS_VERSION = '4.6.20-two-route-printer-v22'

function clean(value = '') {
  return String(value ?? '').trim()
}

function testLabelHtml(outletId) {
  return `<!doctype html><html><head><title>Stupiak's Ops Stable TSPL Test</title><style>@page{size:40mm 30mm;margin:0}</style></head><body><div class="label"><div class="title">TEST LABEL</div><div class="meta">STABLE APK CORE - ${clean(outletId)}</div><div class="time"><div class="box">MADE 12:30<strong>30 JUL 2026</strong></div><div class="box">USE BY 12:30<strong>31 JUL 2026</strong></div></div><div class="batch">STUPIAK OPS TEST</div></div></body></html>`
}

function openNativeTestLabel(outletId) {
  const opened = window.open('', '_blank', 'width=480,height=640')
  if (!opened) throw new Error('The app could not open the label job.')
  opened.document.open()
  opened.document.write(testLabelHtml(outletId))
  opened.document.close()
}

export default function LabelPrinterSettingsSimpleV20() {
  const { user } = useAuth()
  const outletId = clean(user?.outlet_id)
  const nativeAndroid = isNativeAndroidPrinterRuntime()
  const [sharedProfile, setSharedProfile] = useState(null)
  const [route, setRoute] = useState('raw_tcp')
  const [ipAddress, setIpAddress] = useState('')
  const [queueName, setQueueName] = useState('')
  const [queues, setQueues] = useState([])
  const [status, setStatus] = useState('idle')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [loadingQueues, setLoadingQueues] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')

  useEffect(() => { void load() }, [outletId, nativeAndroid])

  async function load() {
    setLoading(true)
    setError('')
    let selected = null
    try {
      const rows = await opsClient.entities.PrinterProfile.filter(
        { outlet_id: outletId, purpose: 'food_label' },
        '-is_default,-updated_date',
        50,
      )
      const normalized = (rows || []).map((row) => normalizePrinterTransportProfile(row, outletId))
      savePrinterProfilesSnapshot(outletId, rows || [])
      const binding = readPrinterDeviceBinding(outletId)
      selected = normalized.find((row) => row.id === binding.selected_profile_id)
        || normalized.find((row) => row.is_default)
        || normalized[0]
        || null
      setSharedProfile(selected)
    } catch {
      // Device-local web printing remains available if the shared profile API is unavailable.
    }

    const local = readWebPrinterDevice(outletId, selected || {})
    setRoute(nativeAndroid ? 'raw_tcp' : local.web_transport || 'raw_tcp')
    setIpAddress(clean(local.ip_address || selected?.ip_address))
    setQueueName(clean(local.web_queue))
    setStatus('idle')
    setLoading(false)
  }

  function fixedProfile() {
    return stablePrinterProfile({
      ...(sharedProfile || {}),
      outlet_id: outletId,
      purpose: 'food_label',
      profile_name: clean(sharedProfile?.profile_name || 'Food Label Printer'),
      ip_address: clean(ipAddress),
      port: 9100,
      web_transport: nativeAndroid ? 'raw_tcp' : route,
      web_queue: clean(queueName),
      is_default: sharedProfile?.is_default !== false,
    })
  }

  async function repairAndroidSharedProfile(profile) {
    const next = {
      outlet_id: outletId,
      purpose: 'food_label',
      profile_name: profile.profile_name,
      brand: profile.brand,
      model: profile.model,
      connection_type: 'network',
      command_language: 'tspl',
      ip_address: profile.ip_address,
      port: 9100,
      bluetooth_mode: 'classic',
      bluetooth_device_name: clean(sharedProfile?.bluetooth_device_name),
      bluetooth_device_id: clean(sharedProfile?.bluetooth_device_id),
      label_width_mm: 40,
      label_height_mm: 30,
      dpi: 203,
      default_copies: 1,
      retry_limit: 3,
      enabled: true,
      is_default: profile.is_default,
      station_mode: 'this_device',
      station_device_name: clean(sharedProfile?.station_device_name),
      notes: encodePrinterTransportNotes({
        ...profile,
        bridge_url: '',
        bridge_token: '',
        bridge_transport: 'raw_tcp',
        bridge_queue: '',
        bridge_printer_ip: '',
        bridge_printer_port: 9100,
        fallback_connection: 'none',
      }),
    }
    const saved = sharedProfile?.id
      ? await opsClient.entities.PrinterProfile.update(sharedProfile.id, next)
      : await opsClient.entities.PrinterProfile.create(next)
    const normalized = normalizePrinterTransportProfile(saved, outletId)
    setSharedProfile(normalized)
    savePrinterDeviceBinding(outletId, normalized.id, normalized.profile_name)
    savePrinterProfilesSnapshot(outletId, [saved])
    return normalized
  }

  function validate() {
    if (!outletId) return 'This staff account must be assigned to an outlet.'
    if ((nativeAndroid || route === 'raw_tcp') && !clean(ipAddress)) return 'Enter the printer IP.'
    if (!nativeAndroid && route === 'queue' && !clean(queueName)) return 'Select a Windows printer queue.'
    return ''
  }

  async function loadQueues() {
    setLoadingQueues(true)
    setError('')
    try {
      const response = await fetchLocalConnector('/printers')
      const data = await response.json().catch(() => null)
      if (!response.ok || data?.ok === false) throw new Error(data?.error || 'Installed printers could not be read.')
      const rows = Array.isArray(data?.printers) ? data.printers : []
      setQueues(rows)
      if (!queueName && rows.length) {
        const kitchen = rows.find((item) => /kitchen label printer/i.test(item.name))
          || rows.find((item) => /kitchen/i.test(item.name))
          || rows[0]
        setQueueName(kitchen?.name || '')
      }
      setMessage(rows.length ? `${rows.length} installed printer(s) found.` : 'No installed printer queue was found.')
    } catch (loadError) {
      const described = await describeConnectorFailure(loadError)
      setError(`${described.title}. ${described.message}`)
    } finally {
      setLoadingQueues(false)
    }
  }

  async function save() {
    const validationError = validate()
    if (validationError) { setError(validationError); return null }
    setSaving(true)
    setError('')
    setMessage('')
    try {
      const profile = fixedProfile()
      const savedLocal = saveWebPrinterDevice(outletId, profile)
      if (nativeAndroid) {
        const repaired = await repairAndroidSharedProfile(profile)
        setIpAddress(repaired.ip_address)
        setMessage('Saved. Android Stable TSPL direct-IP printing remains locked to the accepted settings.')
        return repaired
      }
      setMessage(`Saved on this computer: ${webPrinterRouteLabel(savedLocal)}. Android and other devices were not changed.`)
      return savedLocal
    } catch (saveError) {
      setError(saveError.message || 'Printer settings could not be saved.')
      return null
    } finally {
      setSaving(false)
    }
  }

  async function connect() {
    const validationError = validate()
    if (validationError) { setError(validationError); return false }
    setTesting(true)
    setStatus('checking')
    setError('')
    setMessage('')
    try {
      const profile = fixedProfile()
      if (nativeAndroid) {
        const result = await testPrinterProfile(profile)
        setStatus('ready')
        setMessage(`Printer ready: ${result.printer || `${profile.ip_address}:9100`}.`)
        return true
      }
      const healthResponse = await fetchLocalConnector('/health')
      const health = await healthResponse.json().catch(() => null)
      if (!healthResponse.ok || health?.ok === false) throw new Error(health?.error || 'Web print service is unavailable.')
      const response = await fetchLocalConnector('/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(localConnectorTarget(profile)),
      })
      const result = await response.json().catch(() => null)
      if (!response.ok || result?.ok === false) throw new Error(result?.error || 'The selected printer route did not pass the test.')
      setStatus('ready')
      setMessage(`Printer ready: ${result?.printer || webPrinterRouteLabel(profile)}.`)
      return true
    } catch (connectError) {
      setStatus('error')
      const described = nativeAndroid
        ? { title: 'Printer connection failed', message: connectError.message || 'The printer could not be reached.' }
        : await describeConnectorFailure(connectError)
      setError(`${described.title}. ${described.message}`)
      return false
    } finally {
      setTesting(false)
    }
  }

  async function testLabel() {
    const validationError = validate()
    if (validationError) { setError(validationError); return }
    setTesting(true)
    setError('')
    setMessage('')
    try {
      const profile = fixedProfile()
      saveWebPrinterDevice(outletId, profile)
      if (nativeAndroid) {
        await repairAndroidSharedProfile(profile)
        openNativeTestLabel(outletId)
      } else {
        await printStableLabelHtmlV20(testLabelHtml(outletId), profile)
      }
      setStatus('ready')
      setMessage(`One Stable TSPL test label was sent through ${webPrinterRouteLabel(profile)}.`)
    } catch (printError) {
      setStatus('error')
      setError(printError.message || 'Test label failed.')
    } finally {
      setTesting(false)
    }
  }

  return (
    <div className="chefops-page mx-auto w-full max-w-2xl space-y-4 p-3 pb-32 sm:p-5" data-printer-workspace={SETTINGS_VERSION}>
      <header className="rounded-3xl border border-border bg-card p-4 shadow-sm">
        <div className="flex items-start gap-3">
          <Button asChild variant="outline" size="icon" className="h-10 w-10 shrink-0 rounded-xl"><Link to="/labels"><ArrowLeft className="h-4 w-4" /></Link></Button>
          <div>
            <h1 className="text-xl font-bold">标签打印机 / Label Printer</h1>
            <p className="mt-1 text-sm text-muted-foreground">Windows 可选择现有 Printer Queue 或 Direct IP；Android 保持稳定 Direct IP。</p>
          </div>
        </div>
      </header>

      {loading ? <div className="flex justify-center py-16"><Loader2 className="h-6 w-6 animate-spin" /></div> : (
        <>
          <section className="rounded-3xl border border-border bg-card p-5 shadow-sm">
            {!nativeAndroid ? (
              <div className="grid grid-cols-2 gap-2">
                <button type="button" onClick={() => { setRoute('queue'); setStatus('idle'); setError(''); setMessage('') }} className={`rounded-2xl border p-4 text-left ${route === 'queue' ? 'border-primary bg-primary/10' : 'border-border'}`}>
                  <Monitor className="mb-2 h-5 w-5" />
                  <b className="block text-sm">Windows Printer</b>
                  <span className="text-xs text-muted-foreground">复用 FeedMe 已安装 Queue</span>
                </button>
                <button type="button" onClick={() => { setRoute('raw_tcp'); setStatus('idle'); setError(''); setMessage('') }} className={`rounded-2xl border p-4 text-left ${route === 'raw_tcp' ? 'border-primary bg-primary/10' : 'border-border'}`}>
                  <Wifi className="mb-2 h-5 w-5" />
                  <b className="block text-sm">Direct IP</b>
                  <span className="text-xs text-muted-foreground">Kitchen printer · Port 9100</span>
                </button>
              </div>
            ) : null}

            {nativeAndroid || route === 'raw_tcp' ? (
              <div className="mt-5 space-y-2">
                <Label>Printer IP</Label>
                <Input inputMode="decimal" value={ipAddress} onChange={(event) => { setIpAddress(event.target.value); setStatus('idle'); setError(''); setMessage('') }} placeholder="192.168.0.211" className="h-12 text-base" />
              </div>
            ) : (
              <div className="mt-5 space-y-2">
                <Label>Windows Printer Queue</Label>
                <div className="flex gap-2">
                  <select className="h-12 min-w-0 flex-1 rounded-md border border-input bg-background px-3 text-sm" value={queueName} onChange={(event) => { setQueueName(event.target.value); setStatus('idle'); setError(''); setMessage('') }}>
                    <option value="">Select installed printer</option>
                    {queues.map((queue) => <option key={queue.name} value={queue.name}>{queue.name}{queue.port ? ` · ${queue.port}` : ''}</option>)}
                  </select>
                  <Button type="button" variant="outline" className="h-12 shrink-0" onClick={loadQueues} disabled={loadingQueues}>
                    {loadingQueues ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">选择 Windows 已经能打印的 Kitchen Label Printer；不会修改 Android 或其他设备。</p>
              </div>
            )}

            <div className="mt-4 rounded-2xl bg-muted/55 p-4 text-sm leading-6">
              <div className="flex justify-between gap-4"><span className="text-muted-foreground">Route</span><b>{nativeAndroid ? `Direct IP · ${ipAddress || 'Not set'}:9100` : route === 'queue' ? `Windows Queue · ${queueName || 'Not selected'}` : `Direct IP · ${ipAddress || 'Not set'}:9100`}</b></div>
              <div className="flex justify-between gap-4"><span className="text-muted-foreground">Label</span><b>40 × 30 mm</b></div>
              <div className="flex justify-between gap-4"><span className="text-muted-foreground">Print core</span><b>Stable TSPL v16</b></div>
              <div className="flex justify-between gap-4"><span className="text-muted-foreground">DPI / Gap</span><b>203 / 2 mm</b></div>
            </div>

            <div className="mt-5 grid grid-cols-1 gap-2 sm:grid-cols-3">
              <Button variant="outline" className="h-12" onClick={connect} disabled={testing}>
                {testing ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}Connect
              </Button>
              <Button variant="outline" className="h-12" onClick={testLabel} disabled={testing}>
                <Printer className="mr-2 h-4 w-4" />Test label
              </Button>
              <Button className="h-12" onClick={save} disabled={saving}>
                {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}Save
              </Button>
            </div>
            {status === 'ready' ? <div className="mt-3 flex items-center gap-2 text-sm text-emerald-700"><CheckCircle2 className="h-4 w-4" />Ready on this device</div> : null}
          </section>

          {error ? <div className="rounded-2xl bg-red-50 p-4 text-sm leading-6 text-red-700">{error}</div> : null}
          {message ? <div className="rounded-2xl bg-emerald-50 p-4 text-sm leading-6 text-emerald-700">{message}</div> : null}
        </>
      )}
    </div>
  )
}
