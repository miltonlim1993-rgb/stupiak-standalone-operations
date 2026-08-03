import { useEffect, useRef } from 'react'

const CAPTURE_LABEL = /(拍照|加拍照片|capture|take\s*photo|camera)/i
let cameraProxy = null

function nativeAndroid() {
  const capacitor = window.Capacitor
  return Boolean(
    (capacitor?.isNativePlatform?.() && capacitor?.getPlatform?.() === 'android')
    || window.location.origin === 'https://localhost'
    || window.location.origin === 'capacitor://localhost'
  )
}

function nativeCameraPlugin() {
  const capacitor = window.Capacitor
  if (!nativeAndroid() || !capacitor) return null
  if (!capacitor.isPluginAvailable?.('Camera')) return null
  if (!cameraProxy) {
    cameraProxy = capacitor.Plugins?.Camera || capacitor.registerPlugin?.('Camera') || null
  }
  return cameraProxy
}

function findCaptureInput(button) {
  let current = button?.parentElement || null
  while (current && current !== document.body) {
    const inputs = [...current.querySelectorAll('input[type="file"][capture]')]
      .filter((input) => !input.disabled)
    if (inputs.length) return inputs[0]
    current = current.parentElement
  }
  return null
}

function cancellation(error) {
  const value = `${error?.code || ''} ${error?.message || error || ''}`.toLowerCase()
  return value.includes('cancel') || value.includes('canceled') || value.includes('cancelled')
    || String(error?.code || '') === 'OS-PLUG-CAMR-0006'
}

function extensionFor(type, format) {
  const normalizedFormat = String(format || '').toLowerCase().replace(/^image\//, '')
  if (normalizedFormat === 'jpeg' || normalizedFormat === 'jpg') return 'jpg'
  if (normalizedFormat === 'png') return 'png'
  if (normalizedFormat === 'webp') return 'webp'
  const normalizedType = String(type || '').toLowerCase()
  if (normalizedType.includes('png')) return 'png'
  if (normalizedType.includes('webp')) return 'webp'
  return 'jpg'
}

async function nativeResultFile(result) {
  const capacitor = window.Capacitor
  const source = String(
    result?.webPath
    || (result?.uri && capacitor?.convertFileSrc?.(result.uri))
    || '',
  ).trim()
  if (!source) throw new Error('相机没有返回可读取的照片')

  const response = await fetch(source, { cache: 'no-store' })
  if (!response.ok) throw new Error(`无法读取刚拍摄的照片 (${response.status})`)
  const blob = await response.blob()
  if (!blob.size) throw new Error('刚拍摄的照片是空文件')

  const format = result?.metadata?.format || ''
  const extension = extensionFor(blob.type, format)
  const type = blob.type || (extension === 'jpg' ? 'image/jpeg' : `image/${extension}`)
  return new File([blob], `ops-camera-${Date.now()}.${extension}`, {
    type,
    lastModified: Date.now(),
  })
}

function deliverFile(input, file) {
  if (!input || !file) return
  const transfer = new DataTransfer()
  transfer.items.add(file)
  input.files = transfer.files
  input.dispatchEvent(new Event('change', { bubbles: true }))
}

function reportInlineError(input, error) {
  const code = String(error?.code || '').trim()
  const detail = String(error?.message || error || '').trim()
  const message = code ? `相机启动失败 [${code}] ${detail}` : detail || '相机启动失败，请检查相机权限'
  window.dispatchEvent(new CustomEvent('chefops:task-photo-inline-error', {
    detail: {
      groupId: String(input?.dataset?.taskPhotoGroup || ''),
      message,
    },
  }))
}

function openBrowserPicker(input) {
  const previous = {
    display: input.style.display,
    position: input.style.position,
    inset: input.style.inset,
    width: input.style.width,
    height: input.style.height,
    opacity: input.style.opacity,
    pointerEvents: input.style.pointerEvents,
    zIndex: input.style.zIndex,
  }

  input.style.display = 'block'
  input.style.position = 'fixed'
  input.style.inset = '0 auto auto 0'
  input.style.width = '1px'
  input.style.height = '1px'
  input.style.opacity = '0'
  input.style.pointerEvents = 'none'
  input.style.zIndex = '-1'

  try {
    if (typeof input.showPicker === 'function') input.showPicker()
    else input.click()
  } finally {
    window.setTimeout(() => {
      Object.assign(input.style, previous)
    }, 0)
  }
}

export default function NativeMediaCaptureBridge() {
  const opening = useRef(false)

  useEffect(() => {
    const onClick = (event) => {
      const target = event.target
      if (!(target instanceof Element)) return
      const button = target.closest('button')
      if (!button || button.disabled) return
      const label = String(button.textContent || button.getAttribute('aria-label') || '').trim()
      if (!CAPTURE_LABEL.test(label)) return

      const input = findCaptureInput(button)
      if (!input) return

      event.preventDefault()
      event.stopPropagation()
      event.stopImmediatePropagation()

      if (!nativeAndroid()) {
        try {
          openBrowserPicker(input)
        } catch (error) {
          reportInlineError(input, error)
        }
        return
      }

      const camera = nativeCameraPlugin()
      if (!camera || typeof camera.takePhoto !== 'function') {
        reportInlineError(input, new Error('OPS 原生相机组件没有加载，请重新打开应用'))
        return
      }

      if (opening.current) return
      opening.current = true

      Promise.resolve(camera.takePhoto({
        quality: 90,
        includeMetadata: true,
        saveToGallery: false,
        cameraDirection: 'REAR',
      }))
        .then(nativeResultFile)
        .then((file) => deliverFile(input, file))
        .catch((error) => {
          if (!cancellation(error)) reportInlineError(input, error)
        })
        .finally(() => {
          opening.current = false
        })
    }

    document.addEventListener('click', onClick, true)
    return () => document.removeEventListener('click', onClick, true)
  }, [])

  return null
}
