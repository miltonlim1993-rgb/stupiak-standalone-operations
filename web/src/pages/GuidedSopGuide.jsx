import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Link, useParams } from 'react-router-dom'
import {
  AlertTriangle,
  ArrowLeft,
  BookOpen,
  Camera,
  Check,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  ClipboardCheck,
  Expand,
  FileText,
  Image as ImageIcon,
  ListChecks,
  Loader2,
  Menu,
  ShieldAlert,
  X,
} from 'lucide-react'
import { opsClient } from '@/api/opsClient'
import { useAuth } from '@/lib/AuthContext'
import { parseOutletIds } from '@/lib/outlets'
import MediaLightbox from '@/components/MediaLightbox'
import { Button } from '@/components/ui/button'

const truthy = (value) => value === true || String(value).toLowerCase() === 'true'

function parseCropSource(value) {
  const raw = String(value || '')
  const hashIndex = raw.indexOf('#')
  const src = hashIndex >= 0 ? raw.slice(0, hashIndex) : raw
  const fragment = hashIndex >= 0 ? raw.slice(hashIndex + 1) : ''
  const match = fragment.match(/(?:^|&)crop=([\d.]+),([\d.]+),([\d.]+),([\d.]+)/)
  if (!match) return { src, crop: null }
  const [, x, y, width, height] = match
  return {
    src,
    crop: {
      x: Number(x),
      y: Number(y),
      width: Number(width),
      height: Number(height),
    },
  }
}

function guideTone(step) {
  const text = `${step?.section_title || ''} ${step?.step_title || ''}`
  if (/FAIL|不及格|错误|禁止/i.test(text)) return 'danger'
  if (/WHAT TO DO|正确做法|通过标准/i.test(text)) return 'success'
  if (/PHOTO|拍照/i.test(text)) return 'photo'
  return 'normal'
}

function guideMarker(step, index) {
  const tone = guideTone(step)
  if (tone === 'danger') return '!'
  if (tone === 'success') return '✓'
  if (tone === 'photo') return '📷'
  return index + 1
}

function dateLabel(value) {
  if (!value) return ''
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime())
    ? String(value)
    : parsed.toLocaleDateString('en-MY', { day: '2-digit', month: 'short', year: 'numeric' })
}

export default function GuidedSopGuide() {
  const { sopId } = useParams()
  const { user } = useAuth()
  const contentRef = useRef(null)
  const [sop, setSop] = useState(null)
  const [steps, setSteps] = useState([])
  const [assets, setAssets] = useState([])
  const [acknowledgements, setAcknowledgements] = useState([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [index, setIndex] = useState(0)
  const [stepSheetOpen, setStepSheetOpen] = useState(false)
  const [media, setMedia] = useState(null)

  useEffect(() => {
    const root = document.documentElement
    const nav = document.getElementById('chefops-mobile-nav')
    const main = document.getElementById('chefops-mobile-main')
    const previousNavDisplay = nav?.style.display || ''
    const previousMainPadding = main?.style.paddingBottom || ''
    const previousMainBackground = main?.style.background || ''

    root.classList.add('chefops-guided-sop-active')
    if (nav) nav.style.display = 'none'
    if (main) {
      main.style.paddingBottom = '0px'
      main.style.background = '#f4efe3'
    }

    return () => {
      root.classList.remove('chefops-guided-sop-active')
      if (nav) nav.style.display = previousNavDisplay
      if (main) {
        main.style.paddingBottom = previousMainPadding
        main.style.background = previousMainBackground
      }
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError('')

    Promise.all([
      opsClient.entities.SOP.filter({ id: sopId }, '', 5),
      opsClient.entities.SOPStep.filter({ sop_id: sopId }, 'step_order', 250),
      opsClient.entities.SOPAsset.filter({ sop_id: sopId }, 'step_id,display_order', 400),
      opsClient.entities.TrainingAcknowledgement.filter(
        { sop_id: sopId, user_email: user?.email || '' },
        '-acknowledged_at',
        20,
      ),
    ])
      .then(([sopRows, stepRows, assetRows, acknowledgementRows]) => {
        if (cancelled) return
        const nextSteps = (stepRows || [])
          .filter((row) => truthy(row.active))
          .sort((a, b) => Number(a.step_order) - Number(b.step_order))
        setSop((sopRows || [])[0] || null)
        setSteps(nextSteps)
        setAssets((assetRows || []).filter((row) => truthy(row.active)))
        setAcknowledgements(acknowledgementRows || [])
        const savedIndex = Number(window.localStorage.getItem(`ops:sop:${sopId}:guide`) || 0)
        setIndex(Math.min(Math.max(savedIndex, 0), Math.max(nextSteps.length - 1, 0)))
      })
      .catch((err) => {
        if (!cancelled) setError(err.message || 'Unable to load SOP')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => { cancelled = true }
  }, [sopId, user?.email])

  useEffect(() => {
    window.localStorage.setItem(`ops:sop:${sopId}:guide`, String(index))
    const scrollHost = document.getElementById('chefops-mobile-main')
    if (scrollHost) scrollHost.scrollTo({ top: 0, behavior: 'smooth' })
    else contentRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [index, sopId])

  const current = steps[index]
  const currentAssets = useMemo(
    () => assets
      .filter((asset) => String(asset.step_id || '') === String(current?.id || ''))
      .sort((a, b) => Number(a.display_order || 0) - Number(b.display_order || 0)),
    [assets, current?.id],
  )

  const version = sop?.version_label || String(sop?.version || '')
  const acknowledged = acknowledgements.some((row) => String(row.acknowledged_version) === String(version))
  const progress = steps.length ? Math.round(((index + 1) / steps.length) * 100) : 0

  function goToStep(nextIndex) {
    setIndex(Math.min(Math.max(nextIndex, 0), Math.max(steps.length - 1, 0)))
    setStepSheetOpen(false)
  }

  function openAsset(asset) {
    const type = String(asset.asset_type || '').toLowerCase()
    const parsed = parseCropSource(asset.file_url || asset.thumbnail_url || '')
    setMedia({
      src: parsed.src,
      poster: parsed.src,
      title: asset.caption || asset.file_name || 'SOP reference',
      type: type === 'video' ? 'video' : 'image',
    })
  }

  async function acknowledge() {
    if (!sop || acknowledged) return
    setSaving(true)
    setError('')
    try {
      const row = await opsClient.entities.TrainingAcknowledgement.create({
        sop_id: sop.id,
        user_email: user?.email || '',
        user_name: user?.full_name || user?.email || '',
        outlet_id: user?.outlet_id || parseOutletIds(user)[0] || '',
        acknowledged_version: version,
        status: 'acknowledged',
      })
      setAcknowledgements((rows) => [row, ...rows])
    } catch (err) {
      setError(err.message || 'Unable to acknowledge SOP')
    } finally {
      setSaving(false)
    }
  }

  if (loading) return <div className="flex min-h-[60dvh] items-center justify-center"><Loader2 className="h-7 w-7 animate-spin" /></div>

  if (!sop) {
    return (
      <div className="mx-auto max-w-lg p-4">
        <Link to="/training" className="flex items-center gap-2 text-sm font-medium"><ArrowLeft className="h-4 w-4" />返回 SOP Library</Link>
        <div className="mt-4 rounded-2xl border border-red-300 bg-red-50 p-4 text-sm text-red-700">{error || 'SOP not found'}</div>
      </div>
    )
  }

  const mobileActions = (
    <div className="fixed inset-x-0 bottom-0 z-[480] border-t-2 border-black bg-white shadow-[0_-10px_28px_rgba(0,0,0,0.18)] md:hidden">
      <div className="mx-auto grid w-full max-w-[680px] grid-cols-[0.9fr_1.2fr] gap-2 p-2.5 pb-[max(0.7rem,env(safe-area-inset-bottom))]">
        <Button variant="outline" className="h-12 border-2 border-black font-bold" disabled={index === 0} onClick={() => goToStep(index - 1)}>
          <ChevronLeft className="mr-1 h-4 w-4" />上一步
        </Button>
        {index < steps.length - 1 ? (
          <Button className="h-12 border-2 border-black bg-[#f7b500] font-black text-black hover:bg-[#e7a900]" onClick={() => goToStep(index + 1)}>下一步<ChevronRight className="ml-1 h-4 w-4" /></Button>
        ) : (
          <Button className="h-12 border-2 border-black bg-[#f7b500] font-black text-black hover:bg-[#e7a900]" onClick={acknowledge} disabled={saving || acknowledged}>
            {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <CheckCircle2 className="mr-2 h-4 w-4" />}
            {acknowledged ? '已完成' : '我已阅读并理解'}
          </Button>
        )}
      </div>
    </div>
  )

  return (
    <>
      <div ref={contentRef} className="min-h-full bg-[#f4efe3] pb-24 md:px-4 md:pb-8 xl:px-6">
        <header className="sticky top-0 z-40 border-b-2 border-black bg-[#f7b500] shadow-sm md:top-2 md:mx-auto md:mt-2 md:max-w-[1500px] md:rounded-2xl md:border-2">
          <div className="h-1.5 bg-black" />
          <div className="flex items-start gap-3 px-3 py-3 md:px-5">
            <Link to="/training" className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border-2 border-black bg-white" aria-label="Back to SOP library"><ArrowLeft className="h-4 w-4" /></Link>
            <img src="/stupiaks-ops-192.png" alt="Stupiak's" className="hidden h-11 w-11 rounded-xl border-2 border-black bg-white object-cover sm:block" />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2 text-[9px] font-black uppercase tracking-[0.12em] text-black sm:text-[10px]">
                <span className="rounded-full bg-black px-2.5 py-1 text-white">{sop.sop_code}</span>
                <span>Version {version || '-'}</span>
                {sop.effective_date ? <span className="hidden sm:inline">Effective {dateLabel(sop.effective_date)}</span> : null}
              </div>
              <h1 className="mt-1 line-clamp-2 text-[17px] font-black leading-5 text-black md:text-xl xl:text-2xl">{sop.title}</h1>
            </div>
            <button type="button" onClick={() => setStepSheetOpen(true)} className="flex h-10 items-center gap-1.5 rounded-xl border-2 border-black bg-white px-3 text-xs font-black md:hidden"><Menu className="h-4 w-4" />{index + 1}/{Math.max(steps.length, 1)}</button>
          </div>
          <div className="flex items-center gap-3 border-t border-black/20 px-3 py-2 md:px-5">
            <div className="h-2 flex-1 overflow-hidden rounded-full border border-black bg-white/75"><div className="h-full bg-black transition-all" style={{ width: `${progress}%` }} /></div>
            <span className="w-10 text-right text-xs font-black text-black">{progress}%</span>
          </div>
        </header>

        <div className="mx-auto max-w-[1500px]">
          {error ? <div className="mx-3 mt-3 rounded-xl border-2 border-red-500 bg-red-50 p-3 text-sm text-red-800 md:mx-0">{error}</div> : null}
          <div className="grid gap-4 md:mt-4 md:grid-cols-[230px_minmax(0,1fr)] xl:grid-cols-[260px_minmax(0,1fr)_290px]">
            <aside className="hidden md:block">
              <div className="sticky top-28 overflow-hidden rounded-2xl border-2 border-black bg-white">
                <div className="flex items-center gap-2 bg-black px-4 py-3 text-white"><ListChecks className="h-4 w-4 text-[#f7b500]" /><b className="text-xs">GUIDE LIST</b></div>
                <nav className="max-h-[calc(100dvh-180px)] space-y-1.5 overflow-y-auto p-3">
                  {steps.map((step, stepIndex) => <GuideNav key={step.id} step={step} index={stepIndex} active={stepIndex === index} complete={stepIndex < index || acknowledged} onClick={() => goToStep(stepIndex)} />)}
                </nav>
                {sop.source_document_url ? <a href={sop.source_document_url} target="_blank" rel="noreferrer" className="m-3 mt-0 flex items-center gap-2 rounded-xl border-2 border-black bg-[#fff4bf] p-3 text-xs font-bold"><Expand className="h-4 w-4" />完整海报参考</a> : null}
              </div>
            </aside>

            <main className="min-w-0 space-y-3 md:space-y-4">
              {index === 0 ? <StartStrip sop={sop} /> : null}
              {current ? <GuideCard step={current} index={index} total={steps.length} assets={currentAssets} onOpenAsset={openAsset} /> : <div className="m-3 rounded-2xl border-2 border-dashed border-black bg-white p-8 text-center text-sm md:m-0">No active guide is available.</div>}
              <div className="hidden grid-cols-[1fr_auto_1fr] items-center gap-3 md:grid">
                <Button variant="outline" className="justify-self-start border-2 border-black" disabled={index === 0} onClick={() => goToStep(index - 1)}><ChevronLeft className="mr-1 h-4 w-4" />上一步</Button>
                <span className="rounded-full bg-black px-3 py-1 text-xs font-bold text-white">{index + 1} / {Math.max(steps.length, 1)}</span>
                {index < steps.length - 1 ? <Button className="justify-self-end border-2 border-black bg-[#f7b500] font-black text-black" onClick={() => goToStep(index + 1)}>下一步<ChevronRight className="ml-1 h-4 w-4" /></Button> : <Button className="justify-self-end border-2 border-black bg-[#f7b500] font-black text-black" onClick={acknowledge} disabled={saving || acknowledged}><CheckCircle2 className="mr-2 h-4 w-4" />{acknowledged ? '已完成' : '完成本章'}</Button>}
              </div>
            </main>

            <aside className="hidden xl:block">
              <div className="sticky top-28 space-y-4">
                <ProgressBox progress={progress} index={index} total={steps.length} />
                <FocusBox step={current} />
              </div>
            </aside>
          </div>
        </div>
      </div>

      {typeof document !== 'undefined' ? createPortal(mobileActions, document.body) : null}
      {stepSheetOpen && typeof document !== 'undefined' ? createPortal(
        <div className="fixed inset-0 z-[500] bg-black/55 md:hidden" onClick={() => setStepSheetOpen(false)}>
          <div className="absolute inset-x-0 bottom-0 max-h-[84dvh] overflow-hidden rounded-t-3xl border-t-2 border-black bg-[#f4efe3]" onClick={(event) => event.stopPropagation()}>
            <div className="flex items-center justify-between border-b-2 border-black bg-[#f7b500] p-4">
              <div><b className="text-sm font-black">选择 Guide</b><p className="text-xs">一个标题就是一个 Guide。</p></div>
              <button type="button" onClick={() => setStepSheetOpen(false)} className="flex h-9 w-9 items-center justify-center rounded-xl border-2 border-black bg-white" aria-label="Close guide list"><X className="h-4 w-4" /></button>
            </div>
            <div className="max-h-[calc(84dvh-78px)] space-y-2 overflow-y-auto p-4 pb-[calc(1rem+env(safe-area-inset-bottom))]">
              {steps.map((step, stepIndex) => <GuideNav key={step.id} step={step} index={stepIndex} active={stepIndex === index} complete={stepIndex < index || acknowledged} onClick={() => goToStep(stepIndex)} />)}
            </div>
          </div>
        </div>,
        document.body,
      ) : null}

      <MediaLightbox open={Boolean(media)} onOpenChange={(open) => !open && setMedia(null)} src={media?.src || ''} title={media?.title || 'SOP reference'} type={media?.type || 'image'} poster={media?.poster || ''} />
    </>
  )
}

function StartStrip({ sop }) {
  return (
    <section className="mx-3 overflow-hidden rounded-2xl border-2 border-black bg-white md:mx-0">
      <div className="grid gap-3 p-4 md:grid-cols-2">
        <InfoBlock icon={BookOpen} label="目的 / PURPOSE" text={sop.purpose || sop.summary} />
        <InfoBlock icon={ShieldAlert} label="安全 / SAFETY" text={sop.safety_notes || 'Follow the guide in order and ask the leader when unsure.'} />
      </div>
    </section>
  )
}

function GuideCard({ step, index, total, assets, onOpenAsset }) {
  const tone = guideTone(step)
  const headerClass = tone === 'danger' ? 'bg-red-600 text-white' : tone === 'success' ? 'bg-emerald-600 text-white' : tone === 'photo' ? 'bg-black text-[#f7b500]' : 'bg-[#f7b500] text-black'
  const markerClass = tone === 'normal' ? 'bg-white text-black' : 'bg-white text-black'
  const icon = tone === 'danger' ? <AlertTriangle className="h-5 w-5" /> : tone === 'success' ? <CheckCircle2 className="h-5 w-5" /> : tone === 'photo' ? <Camera className="h-5 w-5" /> : null

  return (
    <article className="overflow-hidden border-y-2 border-black bg-white shadow-sm md:rounded-2xl md:border-2">
      <div className="flex items-center justify-between bg-black px-4 py-2 text-[10px] font-black uppercase tracking-[0.18em] text-[#f7b500]"><span>STUPIAK'S SOP GUIDE</span><span>{index + 1} / {total}</span></div>
      <div className={`flex items-start gap-3 border-b-2 border-black px-4 py-4 md:px-5 ${headerClass}`}>
        <span className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-xl border-2 border-black text-xl font-black ${markerClass}`}>{icon || String(index + 1).padStart(2, '0')}</span>
        <div className="min-w-0"><p className="text-[10px] font-black uppercase tracking-[0.14em] opacity-80">{step.section_title || `Guide ${index + 1}`}</p><h2 className="mt-0.5 text-xl font-black leading-7 md:text-2xl">{step.step_title}</h2></div>
      </div>

      <div className={assets.length ? 'grid lg:grid-cols-[minmax(0,1.08fr)_minmax(320px,0.92fr)]' : ''}>
        {assets.length ? <VisualBlock assets={assets} onOpenAsset={onOpenAsset} /> : null}
        <InstructionBlock step={step} />
      </div>
      <div className="border-t-2 border-black bg-black px-4 py-2 text-center text-[10px] font-black uppercase tracking-[0.18em] text-[#f7b500]">Precise · Clean · Careful = Quality</div>
    </article>
  )
}

function VisualBlock({ assets, onOpenAsset }) {
  return (
    <section className="border-b-2 border-black bg-[#fff9e8] p-3 md:p-4 lg:border-b-0 lg:border-r-2">
      <div className="flex items-center gap-2"><ImageIcon className="h-4 w-4" /><b className="text-[10px] uppercase tracking-[0.14em]">VISUAL GUIDE</b></div>
      <div className={`mt-3 grid gap-3 ${assets.length > 1 ? 'sm:grid-cols-2 lg:grid-cols-1 2xl:grid-cols-2' : 'grid-cols-1'}`}>
        {assets.map((asset) => <AssetCard key={asset.id} asset={asset} onOpenAsset={onOpenAsset} />)}
      </div>
    </section>
  )
}

function AssetCard({ asset, onOpenAsset }) {
  const type = String(asset.asset_type || '').toLowerCase()
  const title = asset.caption || asset.file_name || 'SOP guide'
  if (type === 'image') {
    return (
      <button type="button" onClick={() => onOpenAsset(asset)} className="overflow-hidden rounded-xl border-2 border-black bg-white text-left shadow-sm">
        <div className="relative bg-white"><GuideImage asset={asset} title={title} /><span className="absolute right-2 top-2 flex items-center gap-1 rounded-lg bg-black px-2 py-1 text-[10px] font-bold text-white"><Expand className="h-3 w-3" />完整海报</span></div>
        <span className="block border-t-2 border-black px-3 py-2 text-[11px] font-bold">{title}</span>
      </button>
    )
  }
  if (type === 'video') return <button type="button" onClick={() => onOpenAsset(asset)} className="flex min-h-28 items-center justify-center gap-2 rounded-xl border-2 border-black bg-white p-4 text-sm font-bold"><Expand className="h-5 w-5" />Open training video</button>
  return <a href={asset.file_url} target="_blank" rel="noreferrer" className="flex min-h-24 items-center gap-3 rounded-xl border-2 border-black bg-white p-4"><FileText className="h-5 w-5" /><span className="text-sm font-medium">{title}</span></a>
}

function GuideImage({ asset, title }) {
  const primary = asset.file_url || asset.thumbnail_url || ''
  const fallback = asset.thumbnail_url && asset.thumbnail_url !== primary ? asset.thumbnail_url : ''
  const parsed = useMemo(() => parseCropSource(primary), [primary])
  const fallbackParsed = useMemo(() => parseCropSource(fallback), [fallback])
  const [src, setSrc] = useState(parsed.src)
  const canvasRef = useRef(null)

  useEffect(() => { setSrc(parsed.src) }, [parsed.src])

  useEffect(() => {
    if (!parsed.crop || !src || typeof window === 'undefined') return undefined
    let cancelled = false
    const image = new window.Image()
    image.decoding = 'async'
    image.onload = () => {
      if (cancelled || !canvasRef.current) return
      const canvas = canvasRef.current
      const context = canvas.getContext('2d')
      if (!context) return
      canvas.width = Math.max(1, Math.round(parsed.crop.width))
      canvas.height = Math.max(1, Math.round(parsed.crop.height))
      context.clearRect(0, 0, canvas.width, canvas.height)
      context.drawImage(
        image,
        parsed.crop.x,
        parsed.crop.y,
        parsed.crop.width,
        parsed.crop.height,
        0,
        0,
        canvas.width,
        canvas.height,
      )
    }
    image.onerror = () => {
      if (fallbackParsed.src && fallbackParsed.src !== src) setSrc(fallbackParsed.src)
    }
    image.src = src
    return () => { cancelled = true }
  }, [src, parsed.crop, fallbackParsed.src])

  if (parsed.crop) return <canvas ref={canvasRef} aria-label={title} className="block h-auto w-full bg-white" />
  return <img src={src} alt={title} loading="lazy" onError={() => fallbackParsed.src && fallbackParsed.src !== src && setSrc(fallbackParsed.src)} className="block h-auto w-full object-contain" />
}

function InstructionBlock({ step }) {
  return (
    <section className="space-y-4 p-4 md:p-5">
      {step.instruction ? <TextBlock icon={BookOpen} label="怎么做 / HOW TO DO" text={step.instruction} /> : null}
      {step.warning ? <StatusBlock icon={AlertTriangle} label="错误与禁止 / DO NOT" text={step.warning} tone="bad" /> : null}
      {step.quality_check ? <StatusBlock icon={ClipboardCheck} label="完成标准 / PASS" text={step.quality_check} tone="good" /> : null}
    </section>
  )
}

function TextBlock({ icon: Icon, label, text }) {
  return <section><div className="flex items-center gap-2"><Icon className="h-4 w-4" /><b className="text-[10px] uppercase tracking-[0.14em]">{label}</b></div><p className="mt-3 whitespace-pre-wrap rounded-xl border border-black/15 bg-[#fafafa] p-4 text-sm leading-7 md:text-[15px]">{text}</p></section>
}

function StatusBlock({ icon: Icon, label, text, tone }) {
  const bad = tone === 'bad'
  return <section className={`overflow-hidden rounded-xl border-2 ${bad ? 'border-red-500 bg-red-50' : 'border-emerald-500 bg-emerald-50'}`}><div className={`flex items-center gap-2 px-3 py-2 text-white ${bad ? 'bg-red-500' : 'bg-emerald-600'}`}><Icon className="h-4 w-4" /><b className="text-[10px] uppercase tracking-[0.12em]">{label}</b></div><p className="whitespace-pre-wrap p-3.5 text-sm leading-7 md:text-[15px]">{text}</p></section>
}

function GuideNav({ step, index, active, complete, onClick }) {
  const tone = guideTone(step)
  const toneClass = tone === 'danger' ? 'bg-red-600 text-white' : tone === 'success' ? 'bg-emerald-600 text-white' : tone === 'photo' ? 'bg-black text-[#f7b500]' : active ? 'bg-black text-[#f7b500]' : 'bg-white text-black'
  return (
    <button type="button" onClick={onClick} className={`flex w-full items-center gap-3 rounded-xl border-2 p-3 text-left transition ${active ? 'border-black bg-[#f7b500]' : 'border-transparent bg-[#f6f4ef] hover:border-black/30'}`}>
      <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full border-2 border-black text-xs font-black ${complete ? 'bg-emerald-600 text-white' : toneClass}`}>{complete ? <Check className="h-4 w-4" /> : guideMarker(step, index)}</span>
      <span className="min-w-0 flex-1"><span className="block truncate text-[9px] font-bold uppercase tracking-wide text-muted-foreground">{step.section_title}</span><span className="line-clamp-2 block text-xs font-black leading-5">{step.step_title}</span></span>
      <ChevronRight className="h-4 w-4 shrink-0" />
    </button>
  )
}

function InfoBlock({ icon: Icon, label, text }) {
  return <div className="rounded-xl border-2 border-black bg-[#fff9e8] p-3"><div className="flex items-center gap-2"><Icon className="h-4 w-4" /><b className="text-[10px] uppercase tracking-wide">{label}</b></div><p className="mt-2 text-sm leading-6">{text}</p></div>
}

function ProgressBox({ progress, index, total }) {
  return <section className="overflow-hidden rounded-2xl border-2 border-black bg-white"><div className="bg-black px-4 py-3 text-white"><b className="text-xs">学习进度 / PROGRESS</b></div><div className="flex items-center gap-4 p-4"><div className="flex h-20 w-20 items-center justify-center rounded-full border-4 border-black bg-[#f7b500]"><b>{progress}%</b></div><div><b className="text-sm">Guide {index + 1} of {Math.max(total, 1)}</b><p className="mt-1 text-xs text-muted-foreground">按标题逐页完成。</p></div></div></section>
}

function FocusBox({ step }) {
  if (!step) return null
  return <section className="overflow-hidden rounded-2xl border-2 border-black bg-white"><div className="bg-[#f7b500] px-4 py-3"><b className="text-xs">当前重点 / CURRENT</b></div><div className="space-y-3 p-4">{step.warning ? <p className="rounded-xl border-2 border-red-500 bg-red-50 p-3 text-xs leading-5"><b className="block">DO NOT</b>{step.warning}</p> : null}{step.quality_check ? <p className="rounded-xl border-2 border-emerald-500 bg-emerald-50 p-3 text-xs leading-5"><b className="block">PASS</b>{step.quality_check}</p> : null}</div></section>
}
