import { useEffect, useRef } from 'react'
import {
  publishTaskPhotoCapture,
  subscribeTaskPhotoCaptureConsumer,
} from '@/lib/task-photo-capture-channel'

const CAPTURE_LABEL = /(拍照|加拍照片|capture|take\s*photo|camera)/i
const PENDING_CAPTURE_KEY = 'chefops:task-photo-native-capture:v2'
const RESTORED_RESULT_KEY = 'chefops:task-photo-native-restored:v2'
let cameraProxy = null
let appProxy = null

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
  if (!cameraProxy) cameraProxy = capacitor.Plugins?.Camera || capacitor.registerPlugin?.('Camera') || null
  return cameraProxy
}

function nativeAppPlugin() {
  const capacitor = window.Capacitor
  if (!nativeAndroid() || !capacitor) return null
  if (!capacitor.isPluginAvailable?.('App')) return null
  if (!appProxy) appProxy = capacitor.Plugins?.App || capacitor.registerPlugin?.('App') || null
  return appProxy
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

function captureContext(input) {
  return {
    groupId: String(input?.dataset?.taskPhotoGroup || ''),
    taskId: String(input?.dataset?.taskPhotoTaskId || ''),
    outletId: String(input?.dataset?.taskPhotoOutletId || ''),
    startedAt: new Date().toISOString(),
  }
}

function readJsonStorage(key) {
  try { return JSON.parse(localStorage.getItem(key) || 'null') } catch { return null }
}

function writeJsonStorage(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)) } catch {}
}

function clearCaptureStorage() {
  try {
    localStorage.removeItem(PENDING_CAPTURE_KEY)
    localStorage.removeItem(RESTORED_RESULT_KEY)
  } catch {}
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

function reportInlineError(contextOrInput, error) {
  const context = contextOrInput instanceof HTMLInputElement ? captureContext(contextOrInput) : (contextOrInput || {})
  const code = String(error?.code || '').trim()
  const detail = String(error?.message || error || '').trim()
  const message = code ? `相机启动失败 [${code}] ${detail}` : detail || '相机启动失败，请检查相机权限'
  window.dispatchEvent(new CustomEvent('chefops:task-photo-inline-error', {
    detail: { groupId: String(context.groupId || ''), taskId: String(context.taskId || ''), message },
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
    window.setTimeout(() => Object.assign(input.style, previous), 0)
  }
}

async function deliverNativeResult(result, context, { keepOnUnhandled = true } = {}) {
  if (!context?.groupId || !result) return false
  const file = await nativeResultFile(result)
  const handled = publishTaskPhotoCapture({
    ...context,
    file,
    source: 'capacitor-camera',
  })
  if (handled) {
    clearCaptureStorage()
    return true
  }
  if (keepOnUnhandled) {
    writeJsonStorage(PENDING_CAPTURE_KEY, context)
    writeJsonStorage(RESTORED_RESULT_KEY, result)
  }
  return false
}

async function tryDeliverStoredResult(taskId = '') {
  const context = readJsonStorage(PENDING_CAPTURE_KEY)
  const result = readJsonStorage(RESTORED_RESULT_KEY)
  if (!context?.groupId || !result) return false
  if (taskId && context.taskId && String(taskId) !== String(context.taskId)) return false
  try {
    return await deliverNativeResult(result, context, { keepOnUnhandled: true })
  } catch (error) {
    clearCaptureStorage()
    reportInlineError(context, error)
    return false
  }
}

export default function NativeMediaCaptureBridge() {
  const opening = useRef(false)

  useEffect(() => {
    let removed = false
    let restoredHandle = null

    const app = nativeAppPlugin()
    if (app?.addListener) {
      Promise.resolve(app.addListener('appRestoredResult', async (event) => {
        if (removed) return
        if (String(event?.pluginId || '').toLowerCase() !== 'camera') return
        if (!['takePhoto', 'getPhoto'].includes(String(event?.methodName || ''))) return
        const context = readJsonStorage(PENDING_CAPTURE_KEY)
        if (!context?.groupId) return
        if (!event?.success) {
          clearCaptureStorage()
          reportInlineError(context, new Error(event?.error?.message || '相机返回失败'))
          return
        }
        writeJsonStorage(RESTORED_RESULT_KEY, event.data || null)
        await tryDeliverStoredResult(context.taskId)
      })).then((handle) => { restoredHandle = handle }).catch(() => {})
    }

    const unsubscribeConsumer = subscribeTaskPhotoCaptureConsumer(({ taskId }) => {
      void tryDeliverStoredResult(taskId)
    })

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
        try { openBrowserPicker(input) } catch (error) { reportInlineError(input, error) }
        return
      }

      const camera = nativeCameraPlugin()
      if (!camera || typeof camera.takePhoto !== 'function') {
        reportInlineError(input, new Error('OPS 原生相机组件没有加载，请重新打开应用'))
        return
      }
      if (opening.current) return

      const context = captureContext(input)
      if (!context.groupId || !context.taskId) {
        reportInlineError(context, new Error('照片留证目标丢失，请关闭 Task 后重新打开'))
        return
      }

      opening.current = true
      writeJsonStorage(PENDING_CAPTURE_KEY, context)
      try { localStorage.removeItem(RESTORED_RESULT_KEY) } catch {}

      Promise.resolve(camera.takePhoto({
        quality: 90,
        includeMetadata: true,
        saveToGallery: false,
        cameraDirection: 'REAR',
      }))
        .then(async (result) => {
          writeJsonStorage(RESTORED_RESULT_KEY, result)
          await deliverNativeResult(result, context, { keepOnUnhandled: true })
        })
        .catch((error) => {
          if (cancellation(error)) clearCaptureStorage()
          else reportInlineError(context, error)
        })
        .finally(() => { opening.current = false })
    }

    document.addEventListener('click', onClick, true)
    return () => {
      removed = true
      document.removeEventListener('click', onClick, true)
      unsubscribeConsumer()
      restoredHandle?.remove?.().catch?.(() => {})
    }
  }, [])

  return null
}
