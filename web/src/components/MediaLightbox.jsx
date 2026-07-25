import { useEffect, useState } from 'react'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { ExternalLink, Minus, Plus, RotateCcw, X } from 'lucide-react'

export default function MediaLightbox({
  open,
  onOpenChange,
  src = '',
  title = 'Media preview',
  type = 'image',
  poster = '',
}) {
  const [zoom, setZoom] = useState(1)
  const [failed, setFailed] = useState(false)
  const isVideo = type === 'video'

  useEffect(() => {
    if (!open) return
    setZoom(1)
    setFailed(false)
  }, [open, src, type])

  const changeZoom = (next) => {
    setZoom(Math.max(0.75, Math.min(4, Number(Number(next).toFixed(2)))))
  }

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-[520] bg-black/90 backdrop-blur-sm data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=open]:fade-in-0 data-[state=closed]:fade-out-0" />
        <DialogPrimitive.Content className="fixed inset-0 z-[521] flex min-h-0 flex-col overflow-hidden bg-black text-white outline-none">
          <DialogPrimitive.Title className="sr-only">{title}</DialogPrimitive.Title>
          <DialogPrimitive.Description className="sr-only">
            {isVideo ? 'Full-screen video viewer' : 'Full-screen image viewer'}
          </DialogPrimitive.Description>

          <div className="flex shrink-0 items-center justify-between gap-3 border-b border-white/15 bg-black/85 px-3 py-2 sm:px-4">
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold">{title}</p>
              <p className="text-[11px] text-white/60">
                {isVideo ? 'Video SOP' : `${Math.round(zoom * 100)}% · double tap or scroll when enlarged`}
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              {!isVideo ? (
                <>
                  <button type="button" onClick={() => changeZoom(zoom - 0.25)} className="sop-lightbox-control" aria-label="Zoom out"><Minus className="h-4 w-4" /></button>
                  <button type="button" onClick={() => setZoom(1)} className="sop-lightbox-control" aria-label="Reset zoom"><RotateCcw className="h-4 w-4" /></button>
                  <button type="button" onClick={() => changeZoom(zoom + 0.25)} className="sop-lightbox-control" aria-label="Zoom in"><Plus className="h-4 w-4" /></button>
                </>
              ) : null}
              {src ? (
                <a href={src} target="_blank" rel="noreferrer" className="sop-lightbox-control" aria-label="Open original file">
                  <ExternalLink className="h-4 w-4" />
                </a>
              ) : null}
              <DialogPrimitive.Close className="sop-lightbox-control ml-1" aria-label="Close media"><X className="h-5 w-5" /></DialogPrimitive.Close>
            </div>
          </div>

          <div
            className="sop-lightbox-stage min-h-0 flex-1 overflow-auto overscroll-contain"
            onWheel={(event) => {
              if (isVideo || (!event.ctrlKey && !event.metaKey)) return
              event.preventDefault()
              changeZoom(zoom + (event.deltaY < 0 ? 0.25 : -0.25))
            }}
            onDoubleClick={() => {
              if (!isVideo) setZoom((value) => value > 1 ? 1 : 2)
            }}
          >
            <div className="flex min-h-full min-w-full items-center justify-center p-3 sm:p-6">
              {!src || failed ? (
                <div className="max-w-sm rounded-2xl border border-white/15 bg-white/10 p-5 text-center">
                  <p className="text-sm font-semibold">Unable to display this media.</p>
                  <p className="mt-2 text-xs leading-5 text-white/65">The original file may be unavailable, still uploading, or not supported by this device.</p>
                  {src ? <a href={src} target="_blank" rel="noreferrer" className="mt-4 inline-flex items-center gap-2 rounded-xl border border-white/20 px-3 py-2 text-xs font-semibold"><ExternalLink className="h-4 w-4" /> Open original</a> : null}
                </div>
              ) : isVideo ? (
                <video
                  key={src}
                  src={src}
                  poster={poster || undefined}
                  controls
                  playsInline
                  preload="metadata"
                  onError={() => setFailed(true)}
                  className="max-h-[calc(100dvh-88px)] max-w-full rounded-xl bg-black object-contain"
                />
              ) : (
                <img
                  key={src}
                  src={src}
                  alt={title}
                  draggable="false"
                  onError={() => setFailed(true)}
                  className="sop-lightbox-image block select-none object-contain"
                  style={{
                    width: `${zoom * 100}%`,
                    maxWidth: zoom <= 1 ? '100%' : 'none',
                    maxHeight: zoom <= 1 ? 'calc(100dvh - 88px)' : 'none',
                  }}
                />
              )}
            </div>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}
