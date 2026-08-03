import { useEffect, useRef, useState } from 'react'
import { AlertTriangle, Camera, CheckCircle2, CloudOff, Loader2, X } from 'lucide-react'

const CAPTURE_LABEL = /(拍照|加拍照片|capture|take\s*photo|camera)/i
const STATUS_CLEAR_MS = 6000
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
  const [state, setState] = useState({ kind: '', message: '', previewUrl: '' })
  const clearTimer = useRef(null)
  const opening = useRef(false)
  const previewUrl = useRef('')

  useEffect(() => {
    const releasePreview = () => {
      if (!previewUrl.current) return
      URL.revokeObjectURL(previewUrl.current)
      previewUrl.current = ''
    }

    const clearState = () => {
      window.clearTimeout(clearTimer.current)
      releasePreview()
      setState({ kind: '', message: '', previewUrl: '' })
    }

    const clearLater = (delay = STATUS_CLEAR_MS) => {
      window.clearTimeout(clearTimer.current)
      clearTimer.current = window.setTimeout(clearState, delay)
    }

    const showPreview = (file) => {
      if (!(file instanceof File) || !String(file.type || '').startsWith('image/')) return
      releasePreview()
      previewUrl.current = URL.createObjectURL(file)
      setState({
        kind: 'processing',
        message: '照片已取得并显示，正在保存到系统…',
        previewUrl: previewUrl.current,
      })
    }

    const showError = (message) => {
      setState((current) => ({
        kind: 'error',
        message: String(message || '无法打开相机'),
        previewUrl: current.previewUrl || previewUrl.current,
      }))
    }

    const onInputChange = (event) => {
      const input = event.target
      if (!(input instanceof HTMLInputElement)) return
      if (input.type !== 'file' || !input.hasAttribute('capture')) return
      const file = input.files?.[0]
      if (file) showPreview(file)
    }

    const onPhotoSyncState = (event) => {
      const detail = event.detail || {}
      const syncState = String(detail.state || '')
      if (!previewUrl.current) return
      if (syncState === 'committed') {
        setState((current) => ({
          ...current,
          kind: 'saved',
          message: '照片已显示并保存成功',
          previewUrl: current.previewUrl || previewUrl.current,
        }))
        clearLater(3500)
      } else if (syncState === 'queued_offline') {
        setState((current) => ({
          ...current,
          kind: 'queued',
          message: '照片已显示；网络恢复后会自动完成同步',
          previewUrl: current.previewUrl || previewUrl.current,
        }))
      } else if (syncState === 'rejected') {
        showError(`照片没有保存成功：${detail.error || '请保留画面并重新尝试'}`)
      }
    }

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
          showError(error?.message || '这个浏览器无法打开相机，请检查相机权限')
        }
        return
      }

      const camera = nativeCameraPlugin()
      if (!camera || typeof camera.takePhoto !== 'function') {
        showError('OPS 原生相机组件没有加载。请安装最新版本后重新打开应用。')
        return
      }

      if (opening.current) return
      opening.current = true
      releasePreview()
      setState({ kind: 'opening', message: '正在打开相机…', previewUrl: '' })

      Promise.resolve(camera.takePhoto({
        quality: 90,
        includeMetadata: true,
        saveToGallery: false,
        cameraDirection: 'REAR',
      }))
        .then(nativeResultFile)
        .then((file) => {
          showPreview(file)
          deliverFile(input, file)
        })
        .catch((error) => {
          if (cancellation(error)) {
            clearState()
            return
          }
          const code = String(error?.code || '').trim()
          const detail = String(error?.message || '').trim()
          showError(code ? `相机启动失败 [${code}] ${detail}` : detail || '相机启动失败，请确认 OPS 的相机权限')
        })
        .finally(() => {
          opening.current = false
        })
    }

    document.addEventListener('click', onClick, true)
    document.addEventListener('change', onInputChange, true)
    window.addEventListener('chefops:task-photo-sync-state', onPhotoSyncState)
    return () => {
      window.clearTimeout(clearTimer.current)
      releasePreview()
      document.removeEventListener('click', onClick, true)
      document.removeEventListener('change', onInputChange, true)
      window.removeEventListener('chefops:task-photo-sync-state', onPhotoSyncState)
    }
  }, [])

  if (!state.kind) return null

  const error = state.kind === 'error'
  const saved = state.kind === 'saved'
  const queued = state.kind === 'queued'
  return (
    <div
      className={`fixed left-1/2 top-16 z-[10020] flex w-[min(92vw,420px)] -translate-x-1/2 gap-3 rounded-2xl border px-4 py-3 text-sm font-semibold shadow-2xl ${error ? 'border-red-300 bg-red-50 text-red-800' : saved ? 'border-emerald-300 bg-emerald-50 text-emerald-900' : queued ? 'border-sky-300 bg-sky-50 text-sky-900' : 'border-amber-300 bg-amber-50 text-amber-900'}`}
      role="status"
      aria-live="assertive"
    >
      {state.previewUrl ? (
        <img src={state.previewUrl} alt="刚拍摄的任务照片" className="h-16 w-16 shrink-0 rounded-xl object-cover" />
      ) : error
        ? <AlertTriangle className="h-5 w-5 shrink-0" />
        : <Camera className="h-5 w-5 shrink-0" />}
      <div className="flex min-w-0 flex-1 items-center gap-2">
        {error
          ? <AlertTriangle className="h-4 w-4 shrink-0" />
          : saved
            ? <CheckCircle2 className="h-4 w-4 shrink-0" />
            : queued
              ? <CloudOff className="h-4 w-4 shrink-0" />
              : state.kind === 'opening'
                ? <Camera className="h-4 w-4 shrink-0" />
                : <Loader2 className="h-4 w-4 shrink-0 animate-spin" />}
        <span className="min-w-0 flex-1">{state.message}</span>
      </div>
      {(error || queued || saved) ? (
        <button
          type="button"
          onClick={() => {
            if (previewUrl.current) URL.revokeObjectURL(previewUrl.current)
            previewUrl.current = ''
            setState({ kind: '', message: '', previewUrl: '' })
          }}
          className="rounded-full p-1"
          aria-label="Close camera status"
        >
          <X className="h-4 w-4" />
        </button>
      ) : null}
    </div>
  )
}
