import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  ArrowLeft,
  CheckCircle2,
  Download,
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
  chooseRecommendedQueue,
  describeConnectorFailure,
  fetchLocalConnector,
  listLocalPrinterQueues,
  LOCAL_CONNECTOR_INSTALLER,
  localConnectorTarget,
  readWebPrinterDevice,
  saveWebPrinterDevice,
  stablePrinterProfile,
} from '@/lib/device-printer-v20'
import { encodePrinterTransportNotes, normalizePrinterTransportProfile } from '@/lib/printer-transport-v12'
import { isNativeAndroidPrinterRuntime, testPrinterProfile } from '@/lib/native-label-print'
import { printStableLabelHtmlV20 } from '@/lib/stable-label-print-v20'

const SETTINGS_VERSION = '4.6.22-windows-queue-kitchen-ip-v24'

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

function queueStatus(queue) {
  if (!queue) return ''
  if (queue.offline) return 'Offline'
  return [queue.port, queue.driver].filter(Boolean).join(' · ')
}

export default function LabelPrinterSettingsSimpleV20() {
  const { user } = useAuth()
  const outletId = clean(user?.outlet_id)
  const nativeAndroid = isNativeAndroidPrinterRuntime()
  const isWindows = typeof navigator !== 'undefined' && /Windows|Win32|Win64/i.test(`${navigator.userAgent} ${navigator.platform}`)
  const [sharedProfile, setSharedProfile] = useState(null)
  const [selectedMode, setSelectedMode] = useState('raw_tcp')
  const [ipAddress, setIpAddress] = useState('')
  const [queueName, setQueueName] = useState('')
  const [queues, setQueues] = useState([])
  const [connectorState, setConnectorState] = useState(nativeAndroid ? 'native' : 'checking')
  const [loading, setLoading] = useState(true)
  const [busyAction, setBusyAction] = useState('')
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')

  useEffect(() => { void load() }, [outletId, nativeAndroid])

  const selectedQueue = useMemo(
    () => queues.find((row) => clean(row.name).toLowerCase() === clean(queueName).toLowerCase()) || null,
    [queues, queueName],
  )

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
      // Device-local Web printing remains usable even if the shared profile request is unavailable.
    }

    const local = readWebPrinterDevice(outletId, selected || {})
    setSelectedMode(nativeAndroid ? 'raw_tcp' : local.web_transport)
    setIpAddress(clean(local.ip_address || selected?.ip_address))
    setQueueName(clean(local.web_queue))
    if (!nativeAndroid) await checkService({ preferredQueue: local.web_queue, silent: true })
    setLoading(false)
  }

  function fixedProfile(mode = selectedMode) {
    return stablePrinterProfile({
      ...(sharedProfile || {}),
      outlet_id: outletId,
      purpose: 'food_label',
      profile_name: mode === 'queue' ? 'Windows Label Printer' : 'Kitchen Label Printer',
      web_transport: mode,
      web_queue: clean(queueName),
      ip_address: clean(ipAddress),
      port: 9100,
      is_default: sharedProfile?.is_default !== false,
    })
  }

  async function repairNativeProfile(profile) {
    const next = {
      outlet_id: outletId,
      purpose: 'food_label',
      profile_name: clean(sharedProfile?.profile_name || 'Food Label Printer'),
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

  async function checkService({ preferredQueue = queueName, silent = false } = {}) {
    if (nativeAndroid) return true
    if (!silent) {
      setBusyAction('service')
      setError('')
      setMessage('')
    }
    setConnectorState('checking')
    try {
      const response = await fetchLocalConnector('/health')
      const data = await response.json().catch(() => null)
      if (!response.ok || data?.ok === false) throw new Error(data?.error || 'Local Print Service is unavailable.')
      const rows = await listLocalPrinterQueues()
      setQueues(rows)
      setQueueName((current) => chooseRecommendedQueue(rows, current || preferredQueue))
      setConnectorState('ready')
      if (!silent) setMessage(`Local Print Service ready. ${rows.length} installed printer(s) found.`)
      return true
    } catch (serviceError) {
      setConnectorState('missing')
      if (!silent) {
        const described = await describeConnectorFailure(serviceError)
        setError(`${described.title}. ${described.message}`)
      }
      return false
    } finally {
      if (!silent) setBusyAction('')
    }
  }

  function validateRoute(mode) {
    if (!outletId) return 'This staff account must be assigned to an outlet.'
    if (mode === 'queue' && !clean(queueName)) return 'Select the installed Windows printer.'
    if (mode === 'raw_tcp' && !clean(ipAddress)) return 'Enter the Kitchen printer IP.'
    return ''
  }

  async function useRoute(mode) {
    const validationError = validateRoute(mode)
    if (validationError) { setError(validationError); return null }
    setBusyAction(`save-${mode}`)
    setError('')
    setMessage('')
    try {
      const profile = fixedProfile(mode)
      if (nativeAndroid) {
        const repaired = await repairNativeProfile(profile)
        setSelectedMode('raw_tcp')
        setIpAddress(repaired.ip_address)
        setMessage('Saved. Android continues to use the accepted Stable TSPL Native route.')
        return repaired
      }
      const saved = saveWebPrinterDevice(outletId, profile)
      setSelectedMode(mode)
      setMessage(mode === 'queue'
        ? `This computer will print through Windows printer “${saved.web_queue}”.`
        : `This computer will print directly to Kitchen printer ${saved.ip_address}:9100.`)
      return saved
    } catch (saveError) {
      setError(saveError.message || 'Printer choice could not be saved.')
      return null
    } finally {
      setBusyAction('')
    }
  }

  async function testRoute(mode) {
    const validationError = validateRoute(mode)
    if (validationError) { setError(validationError); return false }
    setBusyAction(`route-${mode}`)
    setError('')
    setMessage('')
    try {
      const profile = fixedProfile(mode)
      if (nativeAndroid) {
        const result = await testPrinterProfile(profile)
        setMessage(`Printer ready: ${result.printer || `${profile.ip_address}:9100`}.`)
        return true
      }
      if (!(await checkService({ silent: true }))) throw new Error('Local Print Service is not running on this computer.')
      const response = await fetchLocalConnector('/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(localConnectorTarget(profile)),
      })
      const result = await response.json().catch(() => null)
      if (!response.ok || result?.ok === false) throw new Error(result?.error || 'The printer route test failed.')
      setMessage(mode === 'queue'
        ? `Windows printer ready: ${queueName}.`
        : `Kitchen printer ready: ${ipAddress}:9100.`)
      return true
    } catch (testError) {
      const described = nativeAndroid
        ? { title: 'Printer connection failed', message: testError.message || 'The printer could not be reached.' }
        : await describeConnectorFailure(testError)
      setError(`${described.title}. ${described.message}`)
      return false
    } finally {
      setBusyAction('')
    }
  }

  async function testLabel(mode) {
    const validationError = validateRoute(mode)
    if (validationError) { setError(validationError); return }
    setBusyAction(`label-${mode}`)
    setError('')
    setMessage('')
    try {
      const profile = fixedProfile(mode)
      if (nativeAndroid) {
        await repairNativeProfile(profile)
        openNativeTestLabel(outletId)
      } else {
        saveWebPrinterDevice(outletId, profile)
        setSelectedMode(mode)
        await printStableLabelHtmlV20(testLabelHtml(outletId), profile)
      }
      setMessage('One Stable TSPL test label was accepted. Confirm the physical label before using this route for production.')
    } catch (printError) {
      const described = nativeAndroid
        ? { title: 'Test label failed', message: printError.message || 'The label could not be sent.' }
        : await describeConnectorFailure(printError)
      setError(`${described.title}. ${described.message}`)
    } finally {
      setBusyAction('')
    }
  }

  return (
    <div className="chefops-page mx-auto w-full max-w-3xl space-y-4 p-3 pb-32 sm:p-5" data-printer-workspace={SETTINGS_VERSION}>
      <header className="rounded-3xl border border-border bg-card p-4 shadow-sm">
        <div className="flex items-start gap-3">
          <Button asChild variant="outline" size="icon" className="h-10 w-10 shrink-0 rounded-xl"><Link to="/labels"><ArrowLeft className="h-4 w-4" /></Link></Button>
          <div>
            <h1 className="text-xl font-bold">标签打印机 / Label Printers</h1>
            <p className="mt-1 text-sm text-muted-foreground">Windows Printer 和 Kitchen IP 同时保留；选择这台设备默认使用哪一台。</p>
          </div>
        </div>
      </header>

      {loading ? <div className="flex justify-center py-16"><Loader2 className="h-6 w-6 animate-spin" /></div> : (
        <>
          {!nativeAndroid ? (
            <section className={`rounded-3xl border p-4 shadow-sm ${connectorState === 'ready' ? 'border-emerald-200 bg-emerald-50/70' : 'border-amber-200 bg-amber-50/70'}`}>
              <div className="flex items-center gap-3">
                <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-white"><Monitor className="h-5 w-5" /></span>
                <div className="min-w-0 flex-1">
                  <h2 className="font-semibold">Local Print Service</h2>
                  <p className="text-xs text-muted-foreground">{connectorState === 'ready' ? 'Running · Windows Queue and Direct IP are available' : 'One-time installation required on this computer'}</p>
                </div>
                {connectorState === 'ready' ? <CheckCircle2 className="h-6 w-6 text-emerald-600" /> : null}
              </div>
              <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                {connectorState !== 'ready' && isWindows ? <Button asChild className="h-11"><a href={LOCAL_CONNECTOR_INSTALLER} download><Download className="mr-2 h-4 w-4" />Install / Repair Print Service</a></Button> : null}
                <Button variant="outline" className="h-11" onClick={() => checkService()} disabled={busyAction === 'service'}>
                  {busyAction === 'service' ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}Check again
                </Button>
              </div>
            </section>
          ) : null}

          {!nativeAndroid ? (
            <PrinterCard
              icon={Monitor}
              title="Windows Printer"
              subtitle="复用 FeedMe 已经使用的 Windows Printer Queue，包括 USB 或 Standard TCP/IP Port。"
              active={selectedMode === 'queue'}
            >
              <div className="space-y-2">
                <Label>Installed printer</Label>
                <select className="h-12 w-full rounded-md border border-input bg-background px-3 text-base" value={queueName} onChange={(event) => { setQueueName(event.target.value); setError(''); setMessage('') }}>
                  <option value="">Select Windows printer</option>
                  {queues.map((queue) => <option key={queue.name} value={queue.name}>{queue.name}{queue.port ? ` · ${queue.port}` : ''}</option>)}
                </select>
                {selectedQueue ? <p className="text-xs text-muted-foreground">{queueStatus(selectedQueue)}</p> : null}
              </div>
              <ActionRow mode="queue" busyAction={busyAction} onTestRoute={testRoute} onTestLabel={testLabel} onUse={useRoute} active={selectedMode === 'queue'} />
            </PrinterCard>
          ) : null}

          <PrinterCard
            icon={Wifi}
            title="Kitchen Printer · Direct IP"
            subtitle={nativeAndroid ? 'Android Native RAW TCP' : '直接发送同一份 Stable RAW TSPL 到 Kitchen Label Machine。'}
            active={selectedMode === 'raw_tcp'}
          >
            <div className="space-y-2">
              <Label>Kitchen printer IP</Label>
              <Input
                inputMode="decimal"
                value={ipAddress}
                onChange={(event) => { setIpAddress(event.target.value); setError(''); setMessage('') }}
                placeholder="192.168.0.211"
                className="h-12 text-base"
              />
              <p className="text-xs text-muted-foreground">RAW TCP · Port 9100</p>
            </div>
            <ActionRow mode="raw_tcp" busyAction={busyAction} onTestRoute={testRoute} onTestLabel={testLabel} onUse={useRoute} active={selectedMode === 'raw_tcp'} />
          </PrinterCard>

          <section className="rounded-3xl border border-border bg-card p-4 shadow-sm">
            <div className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
              <StableValue label="Label" value="40 × 30 mm" />
              <StableValue label="Print core" value="Stable TSPL v16" />
              <StableValue label="DPI / Gap" value="203 / 2 mm" />
              <StableValue label="Android APK" value="Frozen" />
            </div>
          </section>

          {error ? <div className="rounded-2xl bg-red-50 p-4 text-sm leading-6 text-red-700">{error}</div> : null}
          {message ? <div className="rounded-2xl bg-emerald-50 p-4 text-sm leading-6 text-emerald-700">{message}</div> : null}
        </>
      )}
    </div>
  )
}

function PrinterCard({ icon: Icon, title, subtitle, active, children }) {
  return <section className={`rounded-3xl border bg-card p-5 shadow-sm ${active ? 'border-primary ring-1 ring-primary/30' : 'border-border'}`}>
    <div className="mb-4 flex items-center gap-3">
      <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-primary/15 text-primary"><Icon className="h-6 w-6" /></span>
      <div className="min-w-0 flex-1"><h2 className="font-semibold">{title}</h2><p className="text-xs leading-5 text-muted-foreground">{subtitle}</p></div>
      {active ? <span className="rounded-full bg-emerald-100 px-2 py-1 text-[10px] font-semibold text-emerald-700">THIS DEVICE</span> : null}
    </div>
    {children}
  </section>
}

function ActionRow({ mode, busyAction, onTestRoute, onTestLabel, onUse, active }) {
  const busy = busyAction.endsWith(mode)
  return <div className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-3">
    <Button variant="outline" className="h-12" onClick={() => onTestRoute(mode)} disabled={busy}>
      {busyAction === `route-${mode}` ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}Test route
    </Button>
    <Button variant="outline" className="h-12" onClick={() => onTestLabel(mode)} disabled={busy}>
      {busyAction === `label-${mode}` ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Printer className="mr-2 h-4 w-4" />}Test label
    </Button>
    <Button className="h-12" onClick={() => onUse(mode)} disabled={busy || active}>
      {busyAction === `save-${mode}` ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : active ? <CheckCircle2 className="mr-2 h-4 w-4" /> : <Save className="mr-2 h-4 w-4" />}{active ? 'Using here' : 'Use here'}
    </Button>
  </div>
}

function StableValue({ label, value }) {
  return <div className="rounded-2xl bg-muted/55 p-3"><p className="text-xs text-muted-foreground">{label}</p><p className="mt-1 font-semibold">{value}</p></div>
}
