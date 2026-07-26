import { opsClient } from '@/api/opsClient'

function isNativeAndroid() {
  const capacitor = window.Capacitor
  return Boolean(
    (capacitor?.isNativePlatform?.() && capacitor?.getPlatform?.() === 'android')
    || window.location.origin === 'https://localhost'
    || window.location.origin === 'capacitor://localhost'
  )
}

function extractMillimetres(html) {
  const match = String(html || '').match(/@page\s*\{[^}]*size\s*:\s*([0-9.]+)mm\s+([0-9.]+)mm/i)
  if (!match) return { widthMm: 40, heightMm: 30 }
  const widthMm = Number(match[1])
  const heightMm = Number(match[2])
  return {
    widthMm: Number.isFinite(widthMm) ? widthMm : 40,
    heightMm: Number.isFinite(heightMm) ? heightMm : 30,
  }
}

function extractJobName(html) {
  const match = String(html || '').match(/<title>([^<]+)<\/title>/i)
  return String(match?.[1] || 'Stupiak Ops Label').trim().slice(0, 80)
}

function isPrintableLabel(html) {
  const value = String(html || '')
  return value.includes('@page')
    && value.includes('class="label"')
    && (value.includes('window.print') || value.includes('barcode-wrap') || value.includes('TEST LABEL'))
}

function countCopies(html) {
  return Math.max(1, Math.min(100, (String(html || '').match(/class="label"/g) || []).length || 1))
}

function sanitizeLabelHtml(html) {
  const withoutScripts = String(html || '').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
  const directStyle = '<style>html,body{overflow:hidden!important}.label~.label{display:none!important}</style>'
  return withoutScripts.includes('</head>')
    ? withoutScripts.replace('</head>', `${directStyle}</head>`)
    : `${directStyle}${withoutScripts}`
}

function cacheKey(outletId) {
  return `stupiaks_ops.label_printer_draft.${outletId || 'default'}`
}

function readCachedProfile(outletId) {
  try {
    const raw = localStorage.getItem(cacheKey(outletId))
    const parsed = raw ? JSON.parse(raw) : null
    return parsed?.form && typeof parsed.form === 'object' ? parsed.form : null
  } catch {
    return null
  }
}

async function resolvePrinterProfile() {
  const outletId = String(localStorage.getItem('chefops.data-pack.outlet') || '').trim()
  const cached = readCachedProfile(outletId)
  let server = null

  try {
    server = await opsClient.labels.printerProfile({ outletId })
  } catch (error) {
    console.debug('Direct printer profile could not be refreshed', error)
  }

  return {
    ...(server || {}),
    ...(cached || {}),
    outlet_id: server?.outlet_id || cached?.outlet_id || outletId,
  }
}

function directPrinter() {
  return window.Capacitor?.Plugins?.DirectLabelPrint
}

function showPrintMessage(message, tone = 'error') {
  document.getElementById('chefops-direct-print-message')?.remove()
  const item = document.createElement('div')
  item.id = 'chefops-direct-print-message'
  item.textContent = String(message || '')
  item.style.cssText = [
    'position:fixed',
    'top:calc(var(--chefops-header-height,3.5rem) + var(--chefops-safe-top,0px) + .65rem)',
    'left:50%',
    'transform:translateX(-50%)',
    'z-index:9999',
    'width:min(calc(100vw - 1.5rem),410px)',
    'padding:.8rem 1rem',
    'border-radius:.85rem',
    'font:600 13px/1.4 system-ui,sans-serif',
    'box-shadow:0 12px 34px rgba(0,0,0,.18)',
    tone === 'success'
      ? 'background:#ecfdf5;color:#047857;border:1px solid #a7f3d0'
      : 'background:#fef2f2;color:#b91c1c;border:1px solid #fecaca',
  ].join(';')
  document.body.appendChild(item)
  window.setTimeout(() => item.remove(), tone === 'success' ? 2200 : 5200)
}

function validateDirectProfile(profile) {
  const connectionType = String(profile?.connection_type || '').toLowerCase()
  const commandLanguage = String(profile?.command_language || '').toLowerCase()

  if (!profile?.enabled && profile?.enabled !== undefined) {
    throw new Error('The outlet label printer profile is disabled.')
  }

  if (connectionType === 'network') {
    if (!String(profile?.ip_address || '').trim()) {
      throw new Error('Direct printing needs the printer IP address in Label Printer Settings.')
    }
  } else if (connectionType === 'bluetooth') {
    if (!String(profile?.bluetooth_device_id || profile?.bluetooth_device_name || '').trim()) {
      throw new Error('Direct printing needs a paired Bluetooth printer name or MAC address.')
    }
    if (String(profile?.bluetooth_mode || '').toLowerCase() === 'ble') {
      throw new Error('Direct BLE printing is not enabled. Select Bluetooth Classic / paired printer, or Wi-Fi / LAN.')
    }
  } else {
    throw new Error('Direct print is not configured. Open More → Label Printer Settings and choose Wi-Fi / LAN or Bluetooth.')
  }

  if (!['tspl', 'zpl', 'cpcl', 'escpos'].includes(commandLanguage)) {
    throw new Error('Choose the printer command language in Label Printer Settings: TSPL, ZPL, CPCL or ESC/POS.')
  }

  return { connectionType, commandLanguage }
}

async function sendDirectLabel(html) {
  const plugin = directPrinter()
  if (!plugin?.printDirect) throw new Error('The Android direct-print service is unavailable in this APK.')

  const profile = await resolvePrinterProfile()
  const { connectionType, commandLanguage } = validateDirectProfile(profile)
  const { widthMm, heightMm } = extractMillimetres(html)
  const jobName = extractJobName(html)
  const copies = countCopies(html)

  const result = await plugin.printDirect({
    html: sanitizeLabelHtml(html),
    jobName,
    widthMm,
    heightMm,
    dpi: Math.max(72, Number(profile.dpi || 203)),
    copies,
    connectionType,
    commandLanguage,
    ipAddress: String(profile.ip_address || '').trim(),
    port: Math.max(1, Math.min(65535, Number(profile.port || 9100))),
    bluetoothMode: String(profile.bluetooth_mode || 'classic'),
    bluetoothDeviceName: String(profile.bluetooth_device_name || '').trim(),
    bluetoothDeviceId: String(profile.bluetooth_device_id || '').trim(),
    retryLimit: Math.max(0, Math.min(20, Number(profile.retry_limit || 0))),
  })

  showPrintMessage(`Printed directly${result?.printer ? ` to ${result.printer}` : ''}.`, 'success')
  window.dispatchEvent(new CustomEvent('chefops:native-print-started', {
    detail: { jobName, widthMm, heightMm, copies, direct: true, result },
  }))
}

export function installNativeLabelPrintBridge() {
  if (!isNativeAndroid() || window.__chefopsNativePrintInstalled) return
  window.__chefopsNativePrintInstalled = true

  const browserOpen = window.open.bind(window)

  window.open = function chefopsNativeWindowOpen(url = '', target = '', features = '') {
    const featureText = String(features || '').toLowerCase()
    const isLabelPopup = String(target || '') === '_blank'
      && (!url || String(url) === 'about:blank')
      && featureText.includes('width=480')
      && featureText.includes('height=640')

    if (!isLabelPopup) return browserOpen(url, target, features)

    let buffer = ''
    let closed = false
    let printing = false

    const fakeDocument = {
      open() {
        buffer = ''
        printing = false
      },
      write(value) {
        buffer += String(value ?? '')
      },
      close() {
        if (!isPrintableLabel(buffer) || printing || closed) return
        printing = true
        void sendDirectLabel(buffer).catch((error) => {
          printing = false
          const message = error?.message || 'Direct label printing failed.'
          console.error('Direct label print failed', error)
          showPrintMessage(message)
          window.dispatchEvent(new CustomEvent('chefops:native-print-error', {
            detail: { message, direct: true },
          }))
        })
      },
    }

    return {
      get closed() { return closed },
      document: fakeDocument,
      close() { closed = true },
      focus() {},
      print() { fakeDocument.close() },
    }
  }
}
