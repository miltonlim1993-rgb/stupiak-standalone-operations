import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Link, useParams } from 'react-router-dom'
import { opsClient } from '@/api/opsClient'
import { useAuth } from '@/lib/AuthContext'
import { parseOutletIds } from '@/lib/outlets'
import MediaLightbox from '@/components/MediaLightbox'
import { Button } from '@/components/ui/button'
import {
  AlertTriangle,
  ArrowLeft,
  BookOpen,
  Check,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  ClipboardCheck,
  Expand,
  FileText,
  HelpCircle,
  Image as ImageIcon,
  ListChecks,
  Loader2,
  Menu,
  ShieldAlert,
  Target,
  X,
} from 'lucide-react'

const truthy = (value) => value === true || String(value).toLowerCase() === 'true'

function dateLabel(value) {
  if (!value) return ''
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime())
    ? String(value)
    : parsed.toLocaleDateString('en-MY', { day: '2-digit', month: 'short', year: 'numeric' })
}

function splitInstruction(text) {
  return String(text || '')
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
}

function isLegacyVisual(asset) {
  const text = `${asset?.caption || ''} ${asset?.file_name || ''}`.toLowerCase()
  return /(?:step|步骤)\s*\d+[^\n]*(?:visual|图解|slice|crop)|poster\s*(?:slice|crop)|海报切片/.test(text)
}

function hasMaskReminder(sop, steps) {
  const text = [
    sop?.title,
    sop?.summary,
    sop?.purpose,
    sop?.scope,
    sop?.safety_notes,
    ...steps.flatMap((step) => [step.section_title, step.step_title, step.instruction, step.warning, step.quality_check]),
  ].join(' ')
  return /口罩|face\s*mask|mask\b|pelitup\s*muka/i.test(text)
}

function isOnboardingSop(sop) {
  return /onboarding|入职|new staff|pekerja baru/i.test(`${sop?.sop_code || ''} ${sop?.title || ''} ${sop?.category || ''}`)
}

export default function GuidedSopLearningV30() {
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
      main.style.background = '#f8fafc'
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
      opsClient.entities.SOPStep.filter({ sop_id: sopId }, 'step_order', 200),
      opsClient.entities.SOPAsset.filter({ sop_id: sopId }, 'step_id,display_order', 300),
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

        const savedIndex = Number(window.localStorage.getItem(`ops:sop:${sopId}:step`) || 0)
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
    window.localStorage.setItem(`ops:sop:${sopId}:step`, String(index))
    const scrollHost = document.getElementById('chefops-mobile-main')
    if (scrollHost) {
      const top = Math.max(0, (contentRef.current?.offsetTop || 0) - 76)
      scrollHost.scrollTo({ top, behavior: 'smooth' })
    } else {
      contentRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }
  }, [index, sopId])

  const current = steps[index]
  const currentAssets = useMemo(
    () => assets
      .filter((asset) => String(asset.step_id || '') === String(current?.id || ''))
      .sort((a, b) => Number(a.display_order || 0) - Number(b.display_order || 0)),
    [assets, current?.id],
  )
  const primaryAssets = useMemo(() => currentAssets.filter((asset) => !isLegacyVisual(asset)), [currentAssets])
  const referenceAssets = useMemo(() => currentAssets.filter(isLegacyVisual), [currentAssets])
  const generalAssets = useMemo(
    () => assets
      .filter((asset) => !String(asset.step_id || '').trim())
      .sort((a, b) => Number(a.display_order || 0) - Number(b.display_order || 0)),
    [assets],
  )

  const version = sop?.version_label || String(sop?.version || '')
  const acknowledged = acknowledgements.some((row) => String(row.acknowledged_version) === String(version))
  const progress = steps.length ? Math.round(((index + 1) / steps.length) * 100) : 0
  const showMaskReminder = Boolean(sop && isOnboardingSop(sop) && !hasMaskReminder(sop, steps))

  function goToStep(nextIndex) {
    setIndex(Math.min(Math.max(nextIndex, 0), Math.max(steps.length - 1, 0)))
    setStepSheetOpen(false)
  }

  function openAsset(asset) {
    const type = String(asset.asset_type || '').toLowerCase()
    setMedia({
      src: asset.file_url || asset.thumbnail_url || '',
      poster: asset.thumbnail_url || '',
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

  if (loading) {
    return <div className="flex min-h-[60dvh] items-center justify-center bg-slate-50"><Loader2 className="h-7 w-7 animate-spin text-slate-500" /></div>
  }

  if (!sop) {
    return (
      <div className="mx-auto max-w-lg p-4">
        <Link to="/training" className="flex items-center gap-2 text-sm font-medium text-slate-700"><ArrowLeft className="h-4 w-4" />返回 SOP Library</Link>
        <div className="mt-4 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">{error || 'SOP not found'}</div>
      </div>
    )
  }

  const mobileActions = (
    <div className="fixed inset-x-0 bottom-0 z-[480] border-t border-slate-200 bg-white shadow-[0_-8px_24px_rgba(15,23,42,0.12)] md:hidden">
      <div className="mx-auto grid w-full max-w-[680px] grid-cols-[0.9fr_1.2fr] gap-2 p-2.5 pb-[max(0.7rem,env(safe-area-inset-bottom))]">
        <Button variant="outline" className="h-11 border-slate-200 font-semibold" disabled={index === 0} onClick={() => goToStep(index - 1)}>
          <ChevronLeft className="mr-1 h-4 w-4" />上一步
        </Button>
        {index < steps.length - 1 ? (
          <Button className="h-11 bg-[#f7b500] font-semibold text-black hover:bg-[#e9aa00]" onClick={() => goToStep(index + 1)}>下一步<ChevronRight className="ml-1 h-4 w-4" /></Button>
        ) : (
          <Button className="h-11 bg-[#f7b500] font-semibold text-black hover:bg-[#e9aa00]" onClick={acknowledge} disabled={saving || acknowledged}>
            {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <CheckCircle2 className="mr-2 h-4 w-4" />}
            {acknowledged ? '已完成' : '我已阅读并理解'}
          </Button>
        )}
      </div>
    </div>
  )

  return (
    <>
      <div data-sop-standard="ops-compact-guided-v30" className="min-h-full bg-slate-50 pb-24 md:px-5 md:pb-8 xl:px-6">
        <div className="mx-auto max-w-[1500px] px-4 pt-4 md:px-0 md:pt-5">
          <header className="sticky top-0 z-40 rounded-xl border border-slate-200 bg-white/95 shadow-sm backdrop-blur">
            <div className="flex items-start gap-3 p-3 md:p-4">
              <Link to="/training" className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-slate-200 bg-white text-slate-700 hover:bg-slate-50" aria-label="Back to SOP library">
                <ArrowLeft className="h-4 w-4" />
              </Link>
              <span className="hidden h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-amber-50 text-amber-700 sm:flex"><BookOpen className="h-4 w-4" /></span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2 text-[10px] font-semibold text-slate-500">
                  <span className="rounded-md bg-slate-100 px-2 py-1 font-bold text-slate-700">{sop.sop_code}</span>
                  <span>Version {version || '-'}</span>
                  {sop.effective_date ? <span className="hidden sm:inline">Effective {dateLabel(sop.effective_date)}</span> : null}
                </div>
                <h1 className="mt-1 line-clamp-2 text-lg font-semibold leading-6 text-slate-950 md:text-xl">{sop.title}</h1>
              </div>
              <button type="button" onClick={() => setStepSheetOpen(true)} className="flex h-9 items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 text-xs font-semibold text-slate-700 md:hidden">
                <Menu className="h-4 w-4" />{index + 1}/{Math.max(steps.length, 1)}
              </button>
            </div>
            <div className="flex items-center gap-3 border-t border-slate-100 px-3 py-2 md:px-4">
              <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-slate-100"><div className="h-full rounded-full bg-[#f7b500] transition-all" style={{ width: `${progress}%` }} /></div>
              <span className="w-10 text-right text-xs font-semibold text-slate-600">{progress}%</span>
            </div>
          </header>

          {error ? <div className="mt-3 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</div> : null}

          <div className="grid gap-4 pt-4 md:grid-cols-[220px_minmax(0,1fr)] xl:grid-cols-[220px_minmax(0,1fr)_260px]">
            <aside className="hidden md:block">
              <div className="sticky top-24 rounded-xl border border-slate-200 bg-white p-3 shadow-sm">
                <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-slate-900"><ListChecks className="h-4 w-4 text-amber-600" />学习步骤</div>
                <nav className="space-y-1.5">
                  {steps.map((step, stepIndex) => (
                    <StepNavButton key={step.id} step={step} index={stepIndex} active={stepIndex === index} complete={stepIndex < index || acknowledged} onClick={() => goToStep(stepIndex)} />
                  ))}
                </nav>
                {sop.source_document_url ? (
                  <a href={sop.source_document_url} target="_blank" rel="noreferrer" className="mt-3 flex items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs text-slate-700 hover:border-amber-300">
                    <Expand className="h-4 w-4 shrink-0" /><span><b className="block">完整参考文件</b><small className="text-slate-500">需要时打开</small></span>
                  </a>
                ) : null}
              </div>
            </aside>

            <main ref={contentRef} className="min-w-0 scroll-mt-24 space-y-4">
              {index === 0 ? <StartPanel sop={sop} showMaskReminder={showMaskReminder} /> : null}
              {current ? (
                <StepContent
                  step={current}
                  index={index}
                  total={steps.length}
                  assets={primaryAssets}
                  referenceAssets={referenceAssets}
                  onOpenAsset={openAsset}
                />
              ) : (
                <div className="rounded-xl border border-dashed border-slate-300 bg-white p-8 text-center text-sm text-slate-500">No active steps are available for this SOP.</div>
              )}
              {generalAssets.length ? <ReferenceFiles assets={generalAssets} onOpenAsset={openAsset} /> : null}
              <div className="hidden grid-cols-[1fr_auto_1fr] items-center gap-3 md:grid">
                <Button variant="outline" className="justify-self-start border-slate-200" disabled={index === 0} onClick={() => goToStep(index - 1)}><ChevronLeft className="mr-1 h-4 w-4" />上一步</Button>
                <p className="rounded-full bg-slate-100 px-3 py-1 text-center text-xs font-semibold text-slate-600">{index + 1} / {Math.max(steps.length, 1)}</p>
                {index < steps.length - 1 ? (
                  <Button className="justify-self-end bg-[#f7b500] font-semibold text-black hover:bg-[#e9aa00]" onClick={() => goToStep(index + 1)}>下一步<ChevronRight className="ml-1 h-4 w-4" /></Button>
                ) : (
                  <Button className="justify-self-end bg-[#f7b500] font-semibold text-black hover:bg-[#e9aa00]" onClick={acknowledge} disabled={saving || acknowledged}><CheckCircle2 className="mr-2 h-4 w-4" />{acknowledged ? '已完成' : '完成本章'}</Button>
                )}
              </div>
            </main>

            <aside className="hidden xl:block">
              <div className="sticky top-24 space-y-3">
                <ProgressCard progress={progress} current={index} total={steps.length} acknowledged={acknowledged} />
                <CurrentStandard step={current} />
                <CompletionCard isLast={index === steps.length - 1} acknowledged={acknowledged} saving={saving} onAcknowledge={acknowledge} />
                <HelpCard />
              </div>
            </aside>
          </div>
        </div>
      </div>

      {typeof document !== 'undefined' ? createPortal(mobileActions, document.body) : null}
      {stepSheetOpen && typeof document !== 'undefined' ? createPortal(
        <div className="fixed inset-0 z-[500] bg-slate-950/45 md:hidden" onClick={() => setStepSheetOpen(false)}>
          <div className="absolute inset-x-0 bottom-0 max-h-[84dvh] overflow-hidden rounded-t-2xl bg-white shadow-2xl" onClick={(event) => event.stopPropagation()}>
            <div className="flex items-center justify-between border-b border-slate-200 p-4">
              <div><b className="text-sm font-semibold text-slate-950">选择学习步骤</b><p className="mt-0.5 text-xs text-slate-500">一次只查看一个步骤。</p></div>
              <button type="button" onClick={() => setStepSheetOpen(false)} className="flex h-9 w-9 items-center justify-center rounded-lg border border-slate-200 bg-white" aria-label="Close step list"><X className="h-4 w-4" /></button>
            </div>
            <div className="max-h-[calc(84dvh-74px)] space-y-2 overflow-y-auto p-4 pb-[calc(1rem+env(safe-area-inset-bottom))]">
              {steps.map((step, stepIndex) => <StepNavButton key={step.id} step={step} index={stepIndex} active={stepIndex === index} complete={stepIndex < index || acknowledged} onClick={() => goToStep(stepIndex)} />)}
            </div>
          </div>
        </div>,
        document.body,
      ) : null}

      <MediaLightbox open={Boolean(media)} onOpenChange={(open) => !open && setMedia(null)} src={media?.src || ''} title={media?.title || 'SOP reference'} type={media?.type || 'image'} poster={media?.poster || ''} />
    </>
  )
}

function StartPanel({ sop, showMaskReminder }) {
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex items-start gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-amber-50 text-amber-700"><Target className="h-4 w-4" /></span>
        <div className="min-w-0"><p className="text-xs font-semibold uppercase tracking-wide text-amber-700">开始前 / Before start</p><p className="mt-1 text-sm leading-6 text-slate-700">{sop.summary || sop.purpose || 'Follow every step in order and ask the trainer whenever you are unsure.'}</p></div>
      </div>
      <div className="mt-4 grid gap-3 lg:grid-cols-2">
        {sop.purpose ? <InfoCard icon={Target} label="目的 / Purpose" text={sop.purpose} /> : null}
        {sop.scope ? <InfoCard icon={BookOpen} label="范围 / Scope" text={sop.scope} /> : null}
        {showMaskReminder ? <MaskReminder /> : null}
        {sop.safety_notes ? <div className="flex gap-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-amber-950 lg:col-span-2"><ShieldAlert className="mt-0.5 h-5 w-5 shrink-0" /><div><b className="text-xs">安全提醒 / Safety</b><p className="mt-1 whitespace-pre-wrap text-sm leading-6">{sop.safety_notes}</p></div></div> : null}
      </div>
    </section>
  )
}

function MaskReminder() {
  return <div className="flex gap-3 rounded-lg border border-amber-200 bg-amber-50 p-3 lg:col-span-2"><ShieldAlert className="mt-0.5 h-5 w-5 shrink-0 text-amber-700" /><div><b className="text-sm text-slate-900">员工必须自行准备口罩</b><p className="mt-1 text-sm leading-6 text-slate-600">Self-prepared face mask required · Pekerja mesti menyediakan pelitup muka sendiri.</p></div></div>
}

function InfoCard({ icon: Icon, label, text }) {
  return <div className="rounded-lg border border-slate-200 bg-slate-50 p-3"><div className="flex items-center gap-2"><Icon className="h-4 w-4 text-slate-500" /><b className="text-[10px] uppercase tracking-wide text-slate-600">{label}</b></div><p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-slate-700">{text}</p></div>
}

function StepContent({ step, index, total, assets, referenceAssets, onOpenAsset }) {
  const hasVisuals = assets.length > 0
  return (
    <article className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
      <div className="flex items-start gap-3 border-b border-slate-100 p-4 md:p-5">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-[#f7b500] text-sm font-bold text-black">{String(index + 1).padStart(2, '0')}</span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center justify-between gap-2">
            {step.section_title ? <p className="text-[10px] font-semibold uppercase tracking-wide text-amber-700">{step.section_title}</p> : <span />}
            <span className="text-[10px] font-semibold text-slate-400">Step {index + 1} of {total}</span>
          </div>
          <h2 className="mt-1 text-lg font-semibold leading-6 text-slate-950 md:text-xl">{step.step_title}</h2>
        </div>
      </div>

      <div className={hasVisuals ? 'grid lg:grid-cols-[minmax(280px,0.8fr)_minmax(0,1.2fr)]' : ''}>
        {hasVisuals ? <VisualPanel assets={assets} onOpenAsset={onOpenAsset} /> : null}
        <ProcedurePanel step={step} />
      </div>

      {referenceAssets.length ? (
        <div className="border-t border-slate-100 bg-slate-50 px-4 py-3 md:px-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div><b className="text-xs text-slate-700">补充参考图</b><p className="mt-0.5 text-[11px] text-slate-500">仅在需要时打开。</p></div>
            <div className="flex flex-wrap gap-2">
              {referenceAssets.map((asset, assetIndex) => (
                <button key={asset.id} type="button" onClick={() => onOpenAsset(asset)} className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-700 hover:border-amber-300">打开参考 {assetIndex + 1}</button>
              ))}
            </div>
          </div>
        </div>
      ) : null}
    </article>
  )
}

function VisualPanel({ assets, onOpenAsset }) {
  return (
    <section className="border-b border-slate-100 bg-slate-50 p-4 lg:border-b-0 lg:border-r">
      <SectionLabel icon={ImageIcon} label="步骤示范 / Visual reference" />
      <div className={`mt-3 grid gap-3 ${assets.length > 1 ? 'sm:grid-cols-2 lg:grid-cols-1 2xl:grid-cols-2' : 'grid-cols-1'}`}>
        {assets.map((asset) => <AssetCard key={asset.id} asset={asset} onOpenAsset={onOpenAsset} />)}
      </div>
    </section>
  )
}

function AssetCard({ asset, onOpenAsset }) {
  const type = String(asset.asset_type || '').toLowerCase()
  const title = asset.caption || asset.file_name || 'SOP reference'

  if (type === 'image') {
    return (
      <button type="button" onClick={() => onOpenAsset(asset)} className="overflow-hidden rounded-lg border border-slate-200 bg-white text-left shadow-sm hover:border-amber-300">
        <div className="relative bg-white">
          <ResponsiveAssetImage asset={asset} title={title} />
          <span className="absolute right-2 top-2 flex items-center gap-1 rounded-md bg-slate-900/85 px-2 py-1 text-[10px] font-semibold text-white"><Expand className="h-3 w-3" />放大</span>
        </div>
        <span className="block border-t border-slate-100 px-3 py-2 text-[11px] font-medium text-slate-700">{title}</span>
      </button>
    )
  }

  if (type === 'video') {
    return <button type="button" onClick={() => onOpenAsset(asset)} className="flex min-h-32 items-center justify-center gap-2 rounded-lg border border-slate-200 bg-white p-4 text-sm font-semibold text-slate-700 hover:border-amber-300"><Expand className="h-5 w-5" />Open training video</button>
  }

  return <a href={asset.file_url} target="_blank" rel="noreferrer" className="flex min-h-24 items-center gap-3 rounded-lg border border-slate-200 bg-white p-4 text-slate-700 hover:border-amber-300"><FileText className="h-5 w-5 shrink-0" /><span className="text-sm font-medium">{title}</span></a>
}

function ResponsiveAssetImage({ asset, title }) {
  const primary = asset.file_url || asset.thumbnail_url || ''
  const fallback = asset.thumbnail_url && asset.thumbnail_url !== primary ? asset.thumbnail_url : ''
  const [src, setSrc] = useState(primary)
  const [ratio, setRatio] = useState(null)

  useEffect(() => {
    setSrc(primary)
    setRatio(null)
  }, [primary])

  const className = ratio && ratio < 0.9
    ? 'mx-auto block h-auto max-h-[58dvh] w-auto max-w-full object-contain md:max-h-[70dvh]'
    : 'block h-auto w-full object-contain'

  return (
    <img
      src={src}
      alt={title}
      loading="lazy"
      onLoad={(event) => {
        const image = event.currentTarget
        if (image.naturalHeight) setRatio(image.naturalWidth / image.naturalHeight)
      }}
      onError={() => fallback && src !== fallback && setSrc(fallback)}
      className={className}
    />
  )
}

function ProcedurePanel({ step }) {
  const lines = splitInstruction(step.instruction)
  return (
    <section className="space-y-4 p-4 md:p-5">
      {step.instruction ? (
        <div>
          <SectionLabel icon={BookOpen} label="怎么做 / How to do / Cara melakukan" />
          <div className="mt-3 space-y-2.5">
            {lines.length > 1 ? lines.map((line, lineIndex) => (
              <div key={`${lineIndex}-${line}`} className="flex gap-3 rounded-lg border border-slate-200 bg-slate-50 p-3">
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-amber-100 text-xs font-bold text-amber-800">{lineIndex + 1}</span>
                <p className="min-w-0 text-sm leading-7 text-slate-700 md:text-[15px]">{line}</p>
              </div>
            )) : <p className="rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm leading-7 text-slate-700 md:text-[15px]">{step.instruction}</p>}
          </div>
        </div>
      ) : null}

      {step.warning ? <StatusBlock icon={AlertTriangle} label="错误与禁止 / Do not / Jangan" text={step.warning} tone="bad" /> : null}
      {step.quality_check ? <StatusBlock icon={ClipboardCheck} label="完成标准 / Pass standard" text={step.quality_check} tone="good" /> : null}
    </section>
  )
}

function StatusBlock({ icon: Icon, label, text, tone }) {
  const isBad = tone === 'bad'
  return (
    <section className={`rounded-lg border p-3.5 ${isBad ? 'border-red-200 bg-red-50' : 'border-emerald-200 bg-emerald-50'}`}>
      <div className={`flex items-center gap-2 ${isBad ? 'text-red-700' : 'text-emerald-700'}`}>
        <Icon className="h-4 w-4" />
        <b className="text-[10px] uppercase tracking-wide">{label}</b>
      </div>
      <p className={`mt-2 whitespace-pre-wrap text-sm leading-7 md:text-[15px] ${isBad ? 'text-red-900' : 'text-emerald-900'}`}>{text}</p>
    </section>
  )
}

function ReferenceFiles({ assets, onOpenAsset }) {
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <SectionLabel icon={FileText} label="补充资料 / References" />
      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        {assets.map((asset) => {
          const type = String(asset.asset_type || '').toLowerCase()
          const title = asset.caption || asset.file_name || 'Reference file'
          return type === 'image' || type === 'video'
            ? <button key={asset.id} type="button" onClick={() => onOpenAsset(asset)} className="flex items-center gap-3 rounded-lg border border-slate-200 bg-slate-50 p-3 text-left hover:border-amber-300"><ImageIcon className="h-4 w-4 shrink-0 text-slate-500" /><span className="min-w-0 flex-1 truncate text-sm font-medium text-slate-700">{title}</span><ChevronRight className="h-4 w-4 text-slate-400" /></button>
            : <a key={asset.id} href={asset.file_url} target="_blank" rel="noreferrer" className="flex items-center gap-3 rounded-lg border border-slate-200 bg-slate-50 p-3 hover:border-amber-300"><FileText className="h-4 w-4 shrink-0 text-slate-500" /><span className="min-w-0 flex-1 truncate text-sm font-medium text-slate-700">{title}</span><ChevronRight className="h-4 w-4 text-slate-400" /></a>
        })}
      </div>
    </section>
  )
}

function SectionLabel({ icon: Icon, label }) {
  return <div className="flex min-w-0 items-center gap-2 text-[10px] font-semibold uppercase tracking-wide text-slate-500"><Icon className="h-4 w-4 text-amber-600" /><span>{label}</span></div>
}

function StepNavButton({ step, index, active, complete, onClick }) {
  return (
    <button type="button" onClick={onClick} className={`flex w-full items-center gap-2.5 rounded-lg border p-2.5 text-left transition ${active ? 'border-amber-300 bg-amber-50' : 'border-transparent bg-slate-50 hover:border-slate-200 hover:bg-white'}`}>
      <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${complete ? 'bg-emerald-600 text-white' : active ? 'bg-[#f7b500] text-black' : 'border border-slate-200 bg-white text-slate-600'}`}>{complete ? <Check className="h-4 w-4" /> : index + 1}</span>
      <span className="min-w-0 flex-1">{step.section_title ? <span className="block truncate text-[9px] font-medium uppercase tracking-wide text-slate-400">{step.section_title}</span> : null}<span className="line-clamp-2 block text-xs font-semibold leading-5 text-slate-800">{step.step_title}</span></span>
      <ChevronRight className="h-4 w-4 shrink-0 text-slate-400" />
    </button>
  )
}

function ProgressCard({ progress, current, total, acknowledged }) {
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex items-center gap-2 text-sm font-semibold text-slate-900"><ListChecks className="h-4 w-4 text-amber-600" />学习进度</div>
      <div className="mt-3 flex items-center gap-3">
        <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full bg-amber-50 text-sm font-bold text-amber-800">{acknowledged ? '100%' : `${progress}%`}</div>
        <div><b className="text-sm text-slate-800">Step {Math.min(current + 1, Math.max(total, 1))} of {Math.max(total, 1)}</b><p className="mt-1 text-xs leading-5 text-slate-500">{acknowledged ? 'This SOP version is acknowledged.' : 'Complete the steps in order.'}</p></div>
      </div>
    </section>
  )
}

function CurrentStandard({ step }) {
  if (!step?.quality_check && !step?.warning) return null
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex items-center gap-2 text-sm font-semibold text-slate-900"><CheckCircle2 className="h-4 w-4 text-amber-600" />当前重点</div>
      <div className="mt-3 space-y-2">
        {step.warning ? <p className="rounded-lg border border-red-200 bg-red-50 p-3 text-xs leading-5 text-red-900"><b className="block text-red-700">DO NOT</b>{step.warning}</p> : null}
        {step.quality_check ? <p className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-xs leading-5 text-emerald-900"><b className="block text-emerald-700">PASS</b>{step.quality_check}</p> : null}
      </div>
    </section>
  )
}

function CompletionCard({ isLast, acknowledged, saving, onAcknowledge }) {
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex items-center gap-2 text-sm font-semibold text-slate-900"><CheckCircle2 className="h-4 w-4 text-amber-600" />完成确认</div>
      <p className="mt-3 text-sm leading-6 text-slate-500">{isLast ? '确认你已经看过做法、错误情况和完成标准。' : '完成当前步骤后继续下一步；最后一步才进行确认。'}</p>
      <Button className="mt-4 w-full bg-[#f7b500] font-semibold text-black hover:bg-[#e9aa00]" disabled={!isLast || saving || acknowledged} onClick={onAcknowledge}>{saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <CheckCircle2 className="mr-2 h-4 w-4" />}{acknowledged ? '已阅读并理解' : isLast ? '完成本章' : '请先完成所有步骤'}</Button>
    </section>
  )
}

function HelpCard() {
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex items-center gap-2 text-sm font-semibold text-slate-900"><HelpCircle className="h-4 w-4 text-amber-600" />需要帮助</div>
      <p className="mt-3 text-sm leading-6 text-slate-500">不确定时先停止操作，立即询问培训员或领班，不要自行猜测。</p>
    </section>
  )
}
