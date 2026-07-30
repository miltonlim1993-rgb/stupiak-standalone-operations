import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  ArrowLeft,
  CheckCircle2,
  Loader2,
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
} from '@/lib/device-printer-v20'
import { encodePrinterTransportNotes, normalizePrinterTransportProfile } from '@/lib/printer-transport-v12'
import { isNativeAndroidPrinterRuntime, testPrinterProfile } from '@/lib/native-label-print'
import { printStableLabelHtmlV20 } from '@/lib/stable-label-print-v20'

const SETTINGS_VERSION = '4.6.18-simple-stable-printer-v20'

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
  const [ipAddress, setIpAddress] = useState('')
  const [status, setStatus] = useState('idle')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
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
      // The page remains usable from this device even if the shared profile request is temporarily unavailable.
    }

    const local = readWebPrinterDevice(outletId, selected || {})
    setIpAddress(clean(local.ip_address || selected?.ip_address))
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
      is_default: sharedProfile?.is_default !== false,
    })
  }

  async function repairSharedProfile(profile) {
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

  async function save() {
    if (!outletId) { setError('This staff account must be assigned to an outlet.'); return null }
    if (!clean(ipAddress)) { setError('Enter the printer IP.'); return null }
    setSaving(true)
    setError('')
    setMessage('')
    try {
      const profile = fixedProfile()
      saveWebPrinterDevice(outletId, profile)
      const repaired = await repairSharedProfile(profile)
      setIpAddress(repaired.ip_address)
      setMessage(nativeAndroid
        ? 'Saved. APK printing is restored to the accepted Stable TSPL settings.'
        : 'Saved on this computer. The shared APK profile was also restored to 40×30 mm, 203 dpi and 2 mm gap.')
      return repaired
    } catch (saveError) {
      setError(saveError.message || 'Printer settings could not be saved.')
      return null
    } finally {
      setSaving(false)
    }
  }

  async function connect({ testPrinter = true } = {}) {
    if (!clean(ipAddress)) { setError('Enter the printer IP.'); return false }
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
      if (testPrinter) {
        const response = await fetchLocalConnector('/test', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(localConnectorTarget(profile)),
        })
        const result = await response.json().catch(() => null)
        if (!response.ok || result?.ok === false) throw new Error(result?.error || 'The printer did not accept the connection test.')
      }
      setStatus('ready')
      setMessage(`Printer ready: ${profile.ip_address}:9100.`)
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
    if (!clean(ipAddress)) { setError('Enter the printer IP.'); return }
    setTesting(true)
    setError('')
    setMessage('')
    try {
      const profile = fixedProfile()
      saveWebPrinterDevice(outletId, profile)
      if (nativeAndroid) openNativeTestLabel(outletId)
      else await printStableLabelHtmlV20(testLabelHtml(outletId), profile)
      setStatus('ready')
      setMessage('One Stable TSPL test label was sent. No browser page, Raster or shared Web connector settings were used.')
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
            <p className="mt-1 text-sm text-muted-foreground">和稳定 APK 一样：输入打印机 IP，然后测试和保存。</p>
          </div>
        </div>
      </header>

      {loading ? <div className="flex justify-center py-16"><Loader2 className="h-6 w-6 animate-spin" /></div> : (
        <>
          <section className="rounded-3xl border border-border bg-card p-5 shadow-sm">
            <div className="flex items-center gap-3">
              <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-primary/15 text-primary"><Wifi className="h-6 w-6" /></span>
              <div className="min-w-0 flex-1">
                <h2 className="font-semibold">Direct Wi-Fi / LAN</h2>
                <p className="text-xs text-muted-foreground">{nativeAndroid ? 'Android Native RAW TCP' : 'Web RAW TCP through this computer'}</p>
              </div>
              {status === 'ready' ? <CheckCircle2 className="h-6 w-6 text-emerald-600" /> : null}
            </div>

            <div className="mt-5 space-y-2">
              <Label>Printer IP</Label>
              <Input
                inputMode="decimal"
                value={ipAddress}
                onChange={(event) => { setIpAddress(event.target.value); setStatus('idle'); setError(''); setMessage('') }}
                placeholder="192.168.0.211"
                className="h-12 text-base"
              />
            </div>

            <div className="mt-4 rounded-2xl bg-muted/55 p-4 text-sm leading-6">
              <div className="flex justify-between gap-4"><span className="text-muted-foreground">Label</span><b>40 × 30 mm</b></div>
              <div className="flex justify-between gap-4"><span className="text-muted-foreground">Print core</span><b>Stable TSPL v16</b></div>
              <div className="flex justify-between gap-4"><span className="text-muted-foreground">DPI / Gap</span><b>203 / 2 mm</b></div>
              <div className="flex justify-between gap-4"><span className="text-muted-foreground">Port</span><b>9100</b></div>
            </div>

            <div className="mt-5 grid grid-cols-1 gap-2 sm:grid-cols-3">
              <Button variant="outline" className="h-12" onClick={() => connect({ testPrinter: true })} disabled={testing}>
                {testing ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}Connect
              </Button>
              <Button variant="outline" className="h-12" onClick={testLabel} disabled={testing}>
                <Printer className="mr-2 h-4 w-4" />Test label
              </Button>
              <Button className="h-12" onClick={save} disabled={saving}>
                {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}Save
              </Button>
            </div>
          </section>

          {error ? <div className="rounded-2xl bg-red-50 p-4 text-sm leading-6 text-red-700">{error}</div> : null}
          {message ? <div className="rounded-2xl bg-emerald-50 p-4 text-sm leading-6 text-emerald-700">{message}</div> : null}
        </>
      )}
    </div>
  )
}
