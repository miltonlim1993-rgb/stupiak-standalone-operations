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
    && (value.includes('window.print') || value.includes('barcode-wrap'))
}

function nativePrinter() {
  return window.Capacitor?.Plugins?.NativeLabelPrint
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
      },
      write(value) {
        buffer += String(value ?? '')
      },
      close() {
        if (!isPrintableLabel(buffer) || printing || closed) return
        printing = true
        const plugin = nativePrinter()
        if (!plugin?.printHtml) {
          printing = false
          console.error('Native Android print bridge is unavailable')
          window.dispatchEvent(new CustomEvent('chefops:native-print-error', {
            detail: { message: 'Native Android print bridge is unavailable' },
          }))
          return
        }

        const { widthMm, heightMm } = extractMillimetres(buffer)
        const jobName = extractJobName(buffer)
        Promise.resolve(plugin.printHtml({
          html: buffer,
          jobName,
          widthMm,
          heightMm,
        })).then(() => {
          window.dispatchEvent(new CustomEvent('chefops:native-print-started', {
            detail: { jobName, widthMm, heightMm },
          }))
        }).catch((error) => {
          printing = false
          const message = error?.message || 'Unable to open Android print service'
          console.error('Native label print failed', error)
          window.dispatchEvent(new CustomEvent('chefops:native-print-error', {
            detail: { message },
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
