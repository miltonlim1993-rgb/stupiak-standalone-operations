function isSandboxLabelPopup(url, target, features) {
  const featureText = String(features || '').toLowerCase()
  return String(target || '') === '_blank'
    && (!url || String(url) === 'about:blank')
    && featureText.includes('width=480')
    && featureText.includes('height=640')
}

function capturePrint(html) {
  const detail = {
    ok: true,
    mocked: true,
    printed: false,
    mode: 'local-ui-sandbox',
    captured_at: new Date().toISOString(),
    html: String(html || ''),
  }
  window.__chefopsLastLocalSandboxPrint = detail
  window.__chefopsLastLabelPrintOutcome = detail
  window.dispatchEvent(new CustomEvent('chefops:native-print-started', { detail }))
  console.info('Local UI sandbox captured Label print without contacting a printer.')
  return detail
}

export function installLocalLabelPrintSandbox() {
  if (window.__chefopsLocalLabelPrintSandboxInstalled) return
  window.__chefopsLocalLabelPrintSandboxInstalled = true
  window.__chefopsPrintStableLabelHtml = async (html) => capturePrint(html)

  const browserOpen = window.open.bind(window)
  window.open = function chefopsLocalSandboxWindowOpen(url = '', target = '', features = '') {
    if (!isSandboxLabelPopup(url, target, features)) return browserOpen(url, target, features)

    let buffer = ''
    let closed = false
    let captured = false
    const fakeDocument = {
      open() { buffer = ''; captured = false },
      write(value) { buffer += String(value ?? '') },
      close() {
        if (captured || closed) return
        captured = true
        capturePrint(buffer)
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
