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
  Sparkles,
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

function isLegacyVisual(asset) {
  const text = `${asset?.caption || ''} ${asset?.file_name || ''}`.toLowerCase()
  return /(?:step|步骤)\s*\d+[^\n]*(?:visual|图解|slice|crop)|poster\s*(?:slice|crop)|海报切片/.test(text)
}

function splitInstruction(text) {
  return String(text || '')
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
}

export default function GuidedSopStandard() {
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
      const top = Math.max(0, (contentRef.current?.offsetTop || 0) - 82)
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
    return <div className="flex min-h-[60dvh] items-center justify-center"><Loader2 className="h-7 w-7 animate-spin" /></div>
  }

  if (!sop) {
    return (
      <div className="mx-auto max-w-lg p-4">
        <Link to="/training" className="flex items-center gap-2 text-sm font-medium"><ArrowLeft className="h-4 w-4" />返回 SOP Library</Link>
        <div className="mt-4 rounded-2xl border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">{error || 'SOP not found'}</div>
      </div>
    )
  }

  const mobileActions = (
    <div className="fixed inset-x-0 bottom-0 z-[480] border-t-2 border-black bg-white shadow-[0_-10px_28px_rgba(0,0,0,0.18)] md:hidden">
      <div className="mx-auto grid w-full max-w-[680px] grid-cols-[0.9fr_1.2fr] gap-2 p-2.5 pb-[max(0.7rem,env(safe-area-inset-bottom))]">
        <Button variant="outline" className="h-12 border-black font-bold" disabled={index === 0} onClick={() => goToStep(index - 1)}>
          <ChevronLeft className="mr-1 h-4 w-4" />上一步
        </Button>
        {index < steps.length - 1 ? (
          <Button className="h-12 border border-black bg-[#f7b500] font-black text-black hover:bg-[#e7a900]" onClick={() => goToStep(index + 1)}>下一步<ChevronRight className="ml-1 h-4 w-4" /></Button>
        ) : (
          <Button className="h-12 border border-black bg-[#f7b500] font-black text-black hover:bg-[#e7a900]" onClick={acknowledge} disabled={saving || acknowledged}>
            {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <CheckCircle2 className="mr-2 h-4 w-4" />}
            {acknowledged ? '已完成' : '我已阅读并理解'}
          </Button>
        )}
      </div>
    </div>
  )

  return (
    <>
      <div data-sop-standard="stupiaks-poster-v1" className="min-h-full bg-[#f4efe3] pb-24 md:px-4 md:pb-8 xl:px-6">
        <header className="sticky top-0 z-40 border-b-2 border-black bg-[#f7b500] shadow-sm md:top-2 md:mx-auto md:mt-2 md:max-w-[1500px] md:rounded-2xl md:border-2">
          <div className="h-1.5 bg-black" />
          <div className="flex items-start gap-3 px-3 py-3 md:px-5">
            <Link to="/training" className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border-2 border-black bg-white" aria-label="Back to SOP library">
              <ArrowLeft className="h-4 w-4" />
            </Link>
            <img src="/stupiaks-ops-192.png" alt="Stupiak's" className="hidden h-11 w-11 rounded-xl border-2 border-black bg-white object-cover sm:block" />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2 text-[9px] font-black uppercase tracking-[0.12em] text-black sm:text-[10px]">
                <span className="rounded-full bg-black px-2.5 py-1 text-white">{sop.sop_code}</span>
                <span>Version {version || '-'}</span>
                {sop.effective_date ? <span className="hidden sm:inline">Effective {dateLabel(sop.effective_date)}</span> : null}
              </div>
              <h1 className="mt-1 line-clamp-2 text-[17px] font-black leading-5 text-black md:text-xl xl:text-2xl">{sop.title}</h1>
            </div>
            <button type="button" onClick={() => setStepSheetOpen(true)} className="flex h-10 items-center gap-1.5 rounded-xl border-2 border-black bg-white px-3 text-xs font-black md:hidden">
              <Menu className="h-4 w-4" />{index + 1}/{Math.max(steps.length, 1)}
            </button>
          </div>
          <div className="flex items-center gap-3 border-t border-black/20 px-3 py-2 md:px-5">
            <div className="h-2 flex-1 overflow-hidden rounded-full border border-black bg-white/75"><div className="h-full bg-black transition-all" style={{ width: `${progress}%` }} /></div>
            <span className="w-10 text-right text-xs font-black text-black">{progress}%</span>
          </div>
        </header>

        <div className="mx-auto max-w-[1500px]">
          {error ? <div className="mx-3 mt-3 rounded-xl border-2 border-red-500 bg-red-50 p-3 text-sm text-red-800 md:mx-0">{error}</div> : null}

          <div className="grid gap-4 md:mt-4 md:grid-cols-[220px_minmax(0,1fr)] xl:grid-cols-[250px_minmax(0,1fr)_300px]">
            <aside className="hidden md:block">
              <div className="sticky top-28 overflow-hidden rounded-2xl border-2 border-black bg-white">
                <div className="bg-black px-4 py-3 text-white"><SectionTitle icon={ListChecks} label="学习步骤 / STEPS" inverse /></div>
                <nav className="space-y-1.5 p-3">
                  {steps.map((step, stepIndex) => (
                    <StepNavButton key={step.id} step={step} index={stepIndex} active={stepIndex === index} complete={stepIndex < index || acknowledged} onClick={() => goToStep(stepIndex)} />
                  ))}
                </nav>
                {sop.source_document_url ? (
                  <a href={sop.source_document_url} target="_blank" rel="noreferrer" className="m-3 mt-0 flex items-center gap-3 rounded-xl border-2 border-black bg-[#fff4bf] p-3 text-left">
                    <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-black text-white"><Expand className="h-4 w-4" /></span>
                    <span><b className="block text-xs">完整海报参考</b><small className="block text-[10px] text-muted-foreground">需要时才打开，不作为主阅读画面</small></span>
                  </a>
                ) : null}
              </div>
            </aside>

            <main ref={contentRef} className="min-w-0 scroll-mt-24 space-y-3 md:space-y-4">
              {index === 0 ? <StartPanel sop={sop} showMaskReminder={showMaskReminder} /> : null}
              {current ? (
                <StepPoster
                  step={current}
                  index={index}
                  total={steps.length}
                  assets={primaryAssets}
                  referenceAssets={referenceAssets}
                  onOpenAsset={openAsset}
                />
              ) : (
                <div className="m-3 rounded-2xl border-2 border-dashed border-black bg-white p-8 text-center text-sm text-muted-foreground md:m-0">No active steps are available for this SOP.</div>
              )}
              {generalAssets.length ? <ReferenceFiles assets={generalAssets} onOpenAsset={openAsset} /> : null}
              <div className="hidden grid-cols-[1fr_auto_1fr] items-center gap-3 md:grid">
                <Button variant="outline" className="justify-self-start border-2 border-black" disabled={index === 0} onClick={() => goToStep(index - 1)}><ChevronLeft className="mr-1 h-4 w-4" />上一步</Button>
                <p className="rounded-full bg-black px-3 py-1 text-center text-xs font-bold text-white">{index + 1} / {Math.max(steps.length, 1)}</p>
                {index < steps.length - 1 ? (
                  <Button className="justify-self-end border-2 border-black bg-[#f7b500] font-black text-black hover:bg-[#e7a900]" onClick={() => goToStep(index + 1)}>下一步<ChevronRight className="ml-1 h-4 w-4" /></Button>
                ) : (
                  <Button className="justify-self-end border-2 border-black bg-[#f7b500] font-black text-black hover:bg-[#e7a900]" onClick={acknowledge} disabled={saving || acknowledged}><CheckCircle2 className="mr-2 h-4 w-4" />{acknowledged ? '已完成' : '完成本章'}</Button>
                )}
              </div>
            </main>

            <aside className="hidden xl:block">
              <div className="sticky top-28 space-y-4">
                <ProgressPanel progress={progress} current={index} total={steps.length} acknowledged={acknowledged} />
                <CurrentStandard step={current} />
                <CompletionPanel isLast={index === steps.length - 1} acknowledged={acknowledged} saving={saving} onAcknowledge={acknowledge} />
                <div className="overflow-hidden rounded-2xl border-2 border-black bg-white">
                  <div className="bg-black px-4 py-3 text-white"><SectionTitle icon={HelpCircle} label="需要帮助 / HELP" inverse /></div>
                  <p className="p-4 text-sm leading-6 text-muted-foreground">不确定时先停止操作，立即询问培训员或领班，不要自行猜测。</p>
                </div>
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
              <div><b className="text-sm font-black">选择学习步骤</b><p className="text-xs">一次只看一个步骤，不需要缩放整张海报。</p></div>
              <button type="button" onClick={() => setStepSheetOpen(false)} className="flex h-9 w-9 items-center justify-center rounded-xl border-2 border-black bg-white" aria-label="Close step list"><X className="h-4 w-4" /></button>
            </div>
            <div className="max-h-[calc(84dvh-78px)] space-y-2 overflow-y-auto p-4 pb-[calc(1rem+env(safe-area-inset-bottom))]">
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
    <section className="mx-3 overflow-hidden rounded-2xl border-2 border-black bg-white md:mx-0">
      <div className="flex items-center gap-3 bg-black px-4 py-3 text-white">
        <Sparkles className="h-5 w-5 text-[#f7b500]" />
        <div><p className="text-[10px] font-black uppercase tracking-[0.16em] text-[#f7b500]">开始前 / BEFORE START</p><p className="mt-0.5 text-sm font-semibold">{sop.summary || sop.purpose || 'Follow every step in order and ask the trainer whenever you are unsure.'}</p></div>
      </div>
      <div className="grid gap-3 p-4 lg:grid-cols-2">
        {sop.purpose ? <CompactInfo icon={Target} label="目的 / PURPOSE" text={sop.purpose} /> : null}
        {sop.scope ? <CompactInfo icon={BookOpen} label="范围 / SCOPE" text={sop.scope} /> : null}
        {showMaskReminder ? <MaskReminder /> : null}
        {sop.safety_notes ? <div className="flex gap-3 rounded-xl border-2 border-amber-400 bg-amber-50 p-3 text-amber-950 lg:col-span-2"><ShieldAlert className="mt-0.5 h-5 w-5 shrink-0" /><div><b className="text-xs">安全提醒 / SAFETY</b><p className="mt-1 whitespace-pre-wrap text-sm leading-6">{sop.safety_notes}</p></div></div> : null}
      </div>
    </section>
  )
}

function MaskReminder() {
  return <div className="flex gap-3 rounded-xl border-2 border-black bg-[#fff4bf] p-3 lg:col-span-2"><span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-black text-[#f7b500]"><ShieldAlert className="h-5 w-5" /></span><div><b className="text-sm">员工必须自行准备口罩</b><p className="mt-1 text-sm leading-6 text-muted-foreground">Self-prepared face mask required · Pekerja mesti menyediakan pelitup muka sendiri.</p></div></div>
}

function StepPoster({ step, index, total, assets, referenceAssets, onOpenAsset }) {
  const hasVisuals = assets.length > 0
  return (
    <article className="overflow-hidden border-y-2 border-black bg-white shadow-sm md:rounded-2xl md:border-2">
      <div className="flex items-center justify-between gap-3 bg-black px-4 py-2 text-white md:px-5">
        <span className="text-[10px] font-black uppercase tracking-[0.2em] text-[#f7b500]">STUPIAK'S SOP</span>
        <span className="text-[10px] font-black uppercase tracking-[0.16em]">STEP {index + 1} / {total}</span>
      </div>
      <div className="flex items-start gap-3 border-b-2 border-black bg-[#f7b500] px-4 py-4 text-black md:px-5">
        <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl border-2 border-black bg-white text-xl font-black">{String(index + 1).padStart(2, '0')}</span>
        <div className="min-w-0">
          {step.section_title ? <p className="text-[10px] font-black uppercase tracking-[0.14em] opacity-75">{step.section_title}</p> : null}
          <h2 className="mt-0.5 text-xl font-black leading-7 md:text-2xl">{step.step_title}</h2>
        </div>
      </div>

      <div className={hasVisuals ? 'grid lg:grid-cols-[minmax(0,1.08fr)_minmax(320px,0.92fr)]' : ''}>
        {hasVisuals ? <VisualPanel assets={assets} onOpenAsset={onOpenAsset} /> : null}
        <ProcedurePanel step={step} />
      </div>

      {referenceAssets.length ? (
        <div className="border-t-2 border-black bg-[#fff9e8] px-4 py-3 md:px-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div><b className="text-xs">补充参考图 / REFERENCE ONLY</b><p className="mt-0.5 text-[11px] text-muted-foreground">旧海报切片不作为主要教学画面，需要时才打开。</p></div>
            <div className="flex flex-wrap gap-2">
              {referenceAssets.map((asset, assetIndex) => (
                <button key={asset.id} type="button" onClick={() => onOpenAsset(asset)} className="rounded-lg border-2 border-black bg-white px-3 py-2 text-xs font-bold">打开参考 {assetIndex + 1}</button>
              ))}
            </div>
          </div>
        </div>
      ) : null}

      <div className="border-t-2 border-black bg-black px-4 py-2 text-center text-[10px] font-black uppercase tracking-[0.18em] text-[#f7b500]">Precise · Clean · Careful = Quality</div>
    </article>
  )
}

function VisualPanel({ assets, onOpenAsset }) {
  return (
    <section className="border-b-2 border-black bg-[#fff9e8] p-3 lg:border-b-0 lg:border-r-2 md:p-4">
      <SectionTitle icon={ImageIcon} label="步骤示范 / VISUAL REFERENCE" />
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
      <button type="button" onClick={() => onOpenAsset(asset)} className="overflow-hidden rounded-xl border-2 border-black bg-white text-left shadow-sm">
        <div className="relative bg-white">
          <ResponsiveAssetImage asset={asset} title={title} />
          <span className="absolute right-2 top-2 flex items-center gap-1 rounded-lg bg-black px-2 py-1 text-[10px] font-bold text-white"><Expand className="h-3 w-3" />放大</span>
        </div>
        <span className="block border-t-2 border-black px-3 py-2 text-[11px] font-bold">{title}</span>
      </button>
    )
  }

  if (type === 'video') {
    return <button type="button" onClick={() => onOpenAsset(asset)} className="flex min-h-32 items-center justify-center gap-2 rounded-xl border-2 border-black bg-white p-4 text-sm font-bold"><Expand className="h-5 w-5" />Open training video</button>
  }

  return <a href={asset.file_url} target="_blank" rel="noreferrer" className="flex min-h-24 items-center gap-3 rounded-xl border-2 border-black bg-white p-4"><FileText className="h-5 w-5 shrink-0" /><span className="text-sm font-medium">{title}</span></a>
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
          <SectionTitle icon={BookOpen} label="怎么做 / HOW TO DO / CARA MELAKUKAN" />
          <div className="mt-3 space-y-3">
            {lines.length > 1 ? lines.map((line, lineIndex) => (
              <div key={`${lineIndex}-${line}`} className="flex gap-3 rounded-xl border border-black/15 bg-[#fafafa] p-3">
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[#f7b500] text-xs font-black text-black">{lineIndex + 1}</span>
                <p className="min-w-0 text-sm leading-7 md:text-[15px]">{line}</p>
              </div>
            )) : <p className="rounded-xl border border-black/15 bg-[#fafafa] p-4 text-sm leading-7 md:text-[15px]">{step.instruction}</p>}
          </div>
        </div>
      ) : null}

      {step.warning ? <StatusBlock icon={AlertTriangle} label="错误与禁止 / DO NOT / JANGAN" text={step.warning} tone="bad" /> : null}
      {step.quality_check ? <StatusBlock icon={ClipboardCheck} label="完成标准 / PASS STANDARD" text={step.quality_check} tone="good" /> : null}
    </section>
  )
}

function StatusBlock({ icon: Icon, label, text, tone }) {
  const isBad = tone === 'bad'
  return (
    <section className={`overflow-hidden rounded-xl border-2 ${isBad ? 'border-red-500 bg-red-50' : 'border-emerald-500 bg-emerald-50'}`}>
      <div className={`flex items-center gap-2 px-3 py-2 text-white ${isBad ? 'bg-red-500' : 'bg-emerald-600'}`}>
        <Icon className="h-4 w-4" />
        <b className="text-[10px] font-black uppercase tracking-[0.12em] sm:text-[11px]">{label}</b>
      </div>
      <p className="whitespace-pre-wrap p-3.5 text-sm leading-7 md:text-[15px]">{text}</p>
    </section>
  )
}

function ReferenceFiles({ assets, onOpenAsset }) {
  return (
    <section className="mx-3 overflow-hidden rounded-2xl border-2 border-black bg-white md:mx-0">
      <div className="bg-black px-4 py-3 text-white"><SectionTitle icon={FileText} label="补充资料 / REFERENCES" inverse /></div>
      <div className="grid gap-2 p-3 sm:grid-cols-2">
        {assets.map((asset) => {
          const type = String(asset.asset_type || '').toLowerCase()
          const title = asset.caption || asset.file_name || 'Reference file'
          return type === 'image' || type === 'video'
            ? <button key={asset.id} type="button" onClick={() => onOpenAsset(asset)} className="flex items-center gap-3 rounded-xl border-2 border-black bg-[#fff9e8] p-3 text-left"><ImageIcon className="h-4 w-4 shrink-0" /><span className="min-w-0 flex-1 truncate text-sm font-bold">{title}</span><ChevronRight className="h-4 w-4" /></button>
            : <a key={asset.id} href={asset.file_url} target="_blank" rel="noreferrer" className="flex items-center gap-3 rounded-xl border-2 border-black bg-[#fff9e8] p-3"><FileText className="h-4 w-4 shrink-0" /><span className="min-w-0 flex-1 truncate text-sm font-bold">{title}</span><ChevronRight className="h-4 w-4" /></a>
        })}
      </div>
    </section>
  )
}

function SectionTitle({ icon: Icon, label, inverse = false }) {
  return <div className="flex min-w-0 items-center gap-2.5"><span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg ${inverse ? 'bg-[#f7b500] text-black' : 'bg-black text-[#f7b500]'}`}><Icon className="h-3.5 w-3.5" /></span><span className={`min-w-0 text-[9px] font-black uppercase tracking-[0.14em] sm:text-[10px] ${inverse ? 'text-white' : 'text-black'}`}>{label}</span><span className={`h-px min-w-4 flex-1 ${inverse ? 'bg-white/35' : 'bg-black/20'}`} /></div>
}

function StepNavButton({ step, index, active, complete, onClick }) {
  return (
    <button type="button" onClick={onClick} className={`flex w-full items-center gap-3 rounded-xl border-2 p-3 text-left transition ${active ? 'border-black bg-[#f7b500] shadow-sm' : 'border-transparent bg-[#f6f4ef] hover:border-black/30'}`}>
      <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full border-2 text-xs font-black ${complete ? 'border-emerald-600 bg-emerald-600 text-white' : active ? 'border-black bg-black text-[#f7b500]' : 'border-black/20 bg-white text-black'}`}>{complete ? <Check className="h-4 w-4" /> : index + 1}</span>
      <span className="min-w-0 flex-1">{step.section_title ? <span className="block truncate text-[9px] font-bold uppercase tracking-wide text-muted-foreground">{step.section_title}</span> : null}<span className="line-clamp-2 block text-xs font-black leading-5">{step.step_title}</span></span>
      <ChevronRight className="h-4 w-4 shrink-0" />
    </button>
  )
}

function CompactInfo({ icon: Icon, label, text }) {
  return <div className="rounded-xl border-2 border-black bg-[#fff9e8] p-3"><div className="flex items-center gap-2"><Icon className="h-4 w-4" /><b className="text-[10px] font-black uppercase tracking-wide">{label}</b></div><p className="mt-2 whitespace-pre-wrap text-sm leading-6">{text}</p></div>
}

function ProgressPanel({ progress, current, total, acknowledged }) {
  return (
    <section className="overflow-hidden rounded-2xl border-2 border-black bg-white">
      <div className="bg-black px-4 py-3 text-white"><SectionTitle icon={ListChecks} label="学习进度 / PROGRESS" inverse /></div>
      <div className="flex items-center gap-4 p-4">
        <div className="relative flex h-20 w-20 shrink-0 items-center justify-center rounded-full border-4 border-black bg-[#f7b500]"><b className="text-lg">{acknowledged ? '100%' : `${progress}%`}</b></div>
        <div><b className="text-sm">Step {Math.min(current + 1, Math.max(total, 1))} of {Math.max(total, 1)}</b><p className="mt-1 text-xs leading-5 text-muted-foreground">{acknowledged ? 'This SOP version is acknowledged.' : 'Complete the steps in order.'}</p></div>
      </div>
    </section>
  )
}

function CurrentStandard({ step }) {
  if (!step?.quality_check && !step?.warning) return null
  return (
    <section className="overflow-hidden rounded-2xl border-2 border-black bg-white">
      <div className="bg-[#f7b500] px-4 py-3"><SectionTitle icon={CheckCircle2} label="当前重点 / CURRENT STANDARD" /></div>
      <div className="space-y-3 p-4">
        {step.warning ? <p className="rounded-xl border-2 border-red-500 bg-red-50 p-3 text-xs leading-5 text-red-900"><b className="block">DO NOT</b>{step.warning}</p> : null}
        {step.quality_check ? <p className="rounded-xl border-2 border-emerald-500 bg-emerald-50 p-3 text-xs leading-5 text-emerald-900"><b className="block">PASS</b>{step.quality_check}</p> : null}
      </div>
    </section>
  )
}

function CompletionPanel({ isLast, acknowledged, saving, onAcknowledge }) {
  return (
    <section className="overflow-hidden rounded-2xl border-2 border-black bg-white">
      <div className="bg-black px-4 py-3 text-white"><SectionTitle icon={CheckCircle2} label="完成确认 / COMPLETE" inverse /></div>
      <div className="p-4">
        <p className="text-sm leading-6 text-muted-foreground">{isLast ? '确认你已经看过做法、错误情况和完成标准。' : '完成当前步骤后继续下一步；最后一步才进行确认。'}</p>
        <Button className="mt-4 w-full border-2 border-black bg-[#f7b500] font-black text-black hover:bg-[#e7a900]" disabled={!isLast || saving || acknowledged} onClick={onAcknowledge}>{saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <CheckCircle2 className="mr-2 h-4 w-4" />}{acknowledged ? '已阅读并理解' : isLast ? '完成本章' : '请先完成所有步骤'}</Button>
      </div>
    </section>
  )
}
