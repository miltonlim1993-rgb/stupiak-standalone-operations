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

export default function GuidedSopLearning() {
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

    root.classList.add('chefops-guided-sop-active')
    if (nav) nav.style.display = 'none'
    if (main) main.style.paddingBottom = '0px'

    return () => {
      root.classList.remove('chefops-guided-sop-active')
      if (nav) nav.style.display = previousNavDisplay
      if (main) main.style.paddingBottom = previousMainPadding
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
      const top = Math.max(0, (contentRef.current?.offsetTop || 0) - 88)
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
    <div className="fixed inset-x-0 bottom-0 z-[480] mx-auto w-full max-w-[430px] border-t border-black/10 bg-white p-2.5 pb-[max(0.65rem,env(safe-area-inset-bottom))] shadow-[0_-8px_24px_rgba(0,0,0,0.14)] md:hidden">
      <div className="grid grid-cols-[0.9fr_1.2fr] gap-2">
        <Button variant="outline" disabled={index === 0} onClick={() => goToStep(index - 1)}>
          <ChevronLeft className="mr-1 h-4 w-4" />上一步
        </Button>
        {index < steps.length - 1 ? (
          <Button onClick={() => goToStep(index + 1)}>下一步<ChevronRight className="ml-1 h-4 w-4" /></Button>
        ) : (
          <Button onClick={acknowledge} disabled={saving || acknowledged}>
            {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <CheckCircle2 className="mr-2 h-4 w-4" />}
            {acknowledged ? '已完成' : '我已阅读并理解'}
          </Button>
        )}
      </div>
    </div>
  )

  return (
    <>
      <div className="mx-auto w-full max-w-[1540px] bg-[#fffdfa] pb-24 md:bg-transparent md:px-4 md:pb-8 xl:px-6">
        <header className="sticky top-0 z-30 border-b border-black/10 bg-white px-4 py-3 md:top-2 md:mt-2 md:rounded-2xl md:border md:px-5">
          <div className="flex items-start gap-3">
            <Link to="/training" className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border bg-white" aria-label="Back to SOP library">
              <ArrowLeft className="h-4 w-4" />
            </Link>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2 text-[9px] font-bold uppercase tracking-wide sm:text-[10px]">
                <span className="rounded-full bg-primary/15 px-2.5 py-1 text-primary">{sop.sop_code}</span>
                <span className="text-muted-foreground">V{version || '-'}</span>
                {sop.effective_date ? <span className="hidden text-muted-foreground sm:inline">Effective {dateLabel(sop.effective_date)}</span> : null}
              </div>
              <h1 className="mt-1 line-clamp-2 text-[17px] font-black leading-5 md:text-xl xl:text-2xl">{sop.title}</h1>
            </div>
            <button type="button" onClick={() => setStepSheetOpen(true)} className="flex h-10 items-center gap-1.5 rounded-xl border bg-white px-3 text-xs font-bold md:hidden">
              <Menu className="h-4 w-4" />{index + 1}/{Math.max(steps.length, 1)}
            </button>
          </div>
          <div className="mt-3 flex items-center gap-3">
            <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-slate-200"><div className="h-full rounded-full bg-primary transition-all" style={{ width: `${progress}%` }} /></div>
            <span className="w-9 text-right text-xs font-bold">{progress}%</span>
          </div>
        </header>

        {error ? <div className="mx-4 mt-3 rounded-xl border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive md:mx-0">{error}</div> : null}

        <div className="grid gap-4 md:mt-4 md:grid-cols-[220px_minmax(0,1fr)] xl:grid-cols-[250px_minmax(0,1fr)_300px]">
          <aside className="hidden md:block">
            <div className="sticky top-28 space-y-3 rounded-2xl border bg-white p-3">
              <SectionLabel icon={ListChecks} label="学习步骤 / STEPS" />
              <nav className="space-y-1.5">
                {steps.map((step, stepIndex) => (
                  <StepNavButton key={step.id} step={step} index={stepIndex} active={stepIndex === index} complete={stepIndex < index || acknowledged} onClick={() => goToStep(stepIndex)} />
                ))}
              </nav>
              {sop.source_document_url ? (
                <a href={sop.source_document_url} target="_blank" rel="noreferrer" className="flex w-full items-center gap-3 rounded-xl border bg-muted/20 p-3 text-left">
                  <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/15 text-primary"><Expand className="h-4 w-4" /></span>
                  <span><b className="block text-xs">完整海报参考</b><small className="block text-[10px] text-muted-foreground">需要时才打开</small></span>
                </a>
              ) : null}
            </div>
          </aside>

          <main ref={contentRef} className="min-w-0 scroll-mt-24 space-y-3 md:space-y-4">
            {index === 0 ? <LessonOverview sop={sop} showMaskReminder={showMaskReminder} /> : null}
            {current ? <ActiveStep step={current} index={index} total={steps.length} assets={currentAssets} onOpenAsset={openAsset} /> : <div className="m-4 rounded-2xl border border-dashed bg-white p-8 text-center text-sm text-muted-foreground md:m-0">No active steps are available for this SOP.</div>}
            {generalAssets.length ? <ReferenceFiles assets={generalAssets} onOpenAsset={openAsset} /> : null}
            <div className="hidden grid-cols-[1fr_auto_1fr] items-center gap-3 md:grid">
              <Button variant="outline" className="justify-self-start" disabled={index === 0} onClick={() => goToStep(index - 1)}><ChevronLeft className="mr-1 h-4 w-4" />上一步</Button>
              <p className="text-center text-xs text-muted-foreground">{index + 1} / {Math.max(steps.length, 1)}</p>
              {index < steps.length - 1 ? <Button className="justify-self-end" onClick={() => goToStep(index + 1)}>下一步<ChevronRight className="ml-1 h-4 w-4" /></Button> : <Button className="justify-self-end" onClick={acknowledge} disabled={saving || acknowledged}><CheckCircle2 className="mr-2 h-4 w-4" />{acknowledged ? '已完成' : '完成本章'}</Button>}
            </div>
          </main>

          <aside className="hidden xl:block">
            <div className="sticky top-28 space-y-4">
              <ProgressPanel progress={progress} current={index} total={steps.length} acknowledged={acknowledged} />
              <CompletionPanel isLast={index === steps.length - 1} acknowledged={acknowledged} saving={saving} onAcknowledge={acknowledge} />
              <div className="rounded-2xl border bg-white p-4"><SectionLabel icon={HelpCircle} label="需要帮助 / HELP" /><p className="mt-3 text-sm leading-6 text-muted-foreground">不确定时先停止操作，立即询问培训员或领班，不要自行猜测。</p></div>
            </div>
          </aside>
        </div>
      </div>

      {typeof document !== 'undefined' ? createPortal(mobileActions, document.body) : null}
      {stepSheetOpen && typeof document !== 'undefined' ? createPortal(
        <div className="fixed inset-0 z-[500] bg-black/45 md:hidden" onClick={() => setStepSheetOpen(false)}>
          <div className="absolute inset-x-0 bottom-0 mx-auto max-h-[82dvh] w-full max-w-[430px] overflow-hidden rounded-t-3xl bg-white" onClick={(event) => event.stopPropagation()}>
            <div className="flex items-center justify-between border-b p-4">
              <div><b className="text-sm">选择学习步骤</b><p className="text-xs text-muted-foreground">一次只看一个步骤。</p></div>
              <button type="button" onClick={() => setStepSheetOpen(false)} className="flex h-9 w-9 items-center justify-center rounded-xl border" aria-label="Close step list"><X className="h-4 w-4" /></button>
            </div>
            <div className="max-h-[calc(82dvh-76px)] space-y-2 overflow-y-auto p-4 pb-[calc(1rem+env(safe-area-inset-bottom))]">
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

function LessonOverview({ sop, showMaskReminder }) {
  return (
    <section className="mx-4 overflow-hidden rounded-2xl border bg-white md:mx-0">
      <div className="border-b bg-gradient-to-r from-primary/20 via-primary/5 to-transparent p-4">
        <div className="flex items-start gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary text-primary-foreground"><Sparkles className="h-5 w-5" /></span>
          <div><p className="text-[10px] font-black uppercase tracking-[0.16em] text-primary">Before you start</p><p className="mt-1 text-sm leading-6">{sop.summary || sop.purpose || 'Follow every step in order and ask the trainer whenever you are unsure.'}</p></div>
        </div>
      </div>
      <div className="grid gap-3 p-4 lg:grid-cols-2">
        {sop.purpose ? <CompactInfo icon={Target} label="目的 / PURPOSE" text={sop.purpose} /> : null}
        {sop.scope ? <CompactInfo icon={BookOpen} label="范围 / SCOPE" text={sop.scope} /> : null}
        {showMaskReminder ? <MaskReminder /> : null}
        {sop.safety_notes ? <div className="flex gap-3 rounded-xl border border-amber-300 bg-amber-50 p-3 text-amber-950 lg:col-span-2"><ShieldAlert className="mt-0.5 h-5 w-5 shrink-0" /><div><b className="text-xs">安全提醒 / SAFETY</b><p className="mt-1 whitespace-pre-wrap text-sm leading-6">{sop.safety_notes}</p></div></div> : null}
      </div>
    </section>
  )
}

function MaskReminder() {
  return <div className="flex gap-3 rounded-xl border border-primary/40 bg-primary/10 p-3 lg:col-span-2"><span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary text-primary-foreground"><ShieldAlert className="h-5 w-5" /></span><div><b className="text-sm">员工必须自行准备口罩</b><p className="mt-1 text-sm leading-6 text-muted-foreground">Self-prepared face mask required · Pekerja mesti menyediakan pelitup muka sendiri.</p></div></div>
}

function ActiveStep({ step, index, total, assets, onOpenAsset }) {
  return (
    <article className="overflow-hidden border-y border-black/10 bg-white shadow-sm md:rounded-2xl md:border">
      <div className="bg-primary px-4 py-3.5 text-primary-foreground md:px-5 md:py-4">
        <div className="flex items-start gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-black/15 text-lg font-black">{index + 1}</span>
          <div className="min-w-0">
            <p className="text-[10px] font-black uppercase tracking-[0.18em] opacity-75">Step {index + 1} of {total}</p>
            {step.section_title ? <p className="mt-0.5 text-[11px] font-bold opacity-80">{step.section_title}</p> : null}
            <h2 className="mt-0.5 text-lg font-black leading-6 md:text-xl md:leading-7">{step.step_title}</h2>
          </div>
        </div>
      </div>
      {assets.length ? <VisualReference assets={assets} onOpenAsset={onOpenAsset} /> : null}
      <div className="space-y-4 p-4 md:space-y-5 md:p-5">
        {step.instruction ? <StepBlock icon={BookOpen} label="怎么做 / HOW TO DO" text={step.instruction} /> : null}
        {step.warning ? <StepBlock icon={AlertTriangle} label="错误与禁止 / DO NOT" text={step.warning} tone="bad" /> : null}
        {step.quality_check ? <StepBlock icon={ClipboardCheck} label="完成标准 / PASS" text={step.quality_check} tone="good" /> : null}
      </div>
    </article>
  )
}

function VisualReference({ assets, onOpenAsset }) {
  return (
    <div className="border-b border-black/10 bg-[#fff9e8] px-3 py-3 md:px-4 md:py-4">
      <SectionLabel icon={ImageIcon} label="步骤示范 / VISUAL" />
      <div className={`mt-3 grid gap-3 ${assets.length > 1 ? 'sm:grid-cols-2' : 'grid-cols-1'}`}>
        {assets.map((asset) => {
          const type = String(asset.asset_type || '').toLowerCase()
          const title = asset.caption || asset.file_name || 'SOP reference'
          if (type === 'image') {
            return (
              <button key={asset.id} type="button" onClick={() => onOpenAsset(asset)} className="overflow-hidden rounded-xl border border-black/10 bg-white text-left shadow-sm">
                <div className="relative overflow-hidden bg-white">
                  <ResponsiveAssetImage asset={asset} title={title} />
                  <span className="absolute right-2 top-2 flex items-center gap-1 rounded-lg bg-black/75 px-2 py-1 text-[10px] font-bold text-white"><Expand className="h-3 w-3" />放大</span>
                </div>
                <span className="block border-t border-black/10 px-3 py-2 text-[11px] font-bold">{title}</span>
              </button>
            )
          }
          if (type === 'video') {
            return <button key={asset.id} type="button" onClick={() => onOpenAsset(asset)} className="flex min-h-28 items-center justify-center gap-2 rounded-xl border bg-white p-4 text-sm font-bold"><Expand className="h-5 w-5 text-primary" />Open training video</button>
          }
          return <a key={asset.id} href={asset.file_url} target="_blank" rel="noreferrer" className="flex min-h-24 items-center gap-3 rounded-xl border bg-white p-4"><FileText className="h-5 w-5 shrink-0 text-primary" /><span className="text-sm font-medium">{title}</span></a>
        })}
      </div>
    </div>
  )
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
    ? 'mx-auto block h-auto max-h-[56dvh] w-auto max-w-full object-contain md:max-h-[68dvh]'
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

function ReferenceFiles({ assets, onOpenAsset }) {
  return (
    <section className="mx-4 rounded-2xl border bg-white p-4 md:mx-0 md:p-5">
      <SectionLabel icon={FileText} label="补充资料 / REFERENCES" />
      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        {assets.map((asset) => {
          const type = String(asset.asset_type || '').toLowerCase()
          const title = asset.caption || asset.file_name || 'Reference file'
          return type === 'image' || type === 'video'
            ? <button key={asset.id} type="button" onClick={() => onOpenAsset(asset)} className="flex items-center gap-3 rounded-xl border bg-muted/20 p-3 text-left"><ImageIcon className="h-4 w-4 shrink-0 text-primary" /><span className="min-w-0 flex-1 truncate text-sm font-medium">{title}</span><ChevronRight className="h-4 w-4 text-muted-foreground" /></button>
            : <a key={asset.id} href={asset.file_url} target="_blank" rel="noreferrer" className="flex items-center gap-3 rounded-xl border bg-muted/20 p-3"><FileText className="h-4 w-4 shrink-0 text-primary" /><span className="min-w-0 flex-1 truncate text-sm font-medium">{title}</span><ChevronRight className="h-4 w-4 text-muted-foreground" /></a>
        })}
      </div>
    </section>
  )
}

function StepBlock({ icon: Icon, label, text, tone = 'default' }) {
  const style = tone === 'bad'
    ? 'border-rose-200 bg-rose-50 text-rose-950'
    : tone === 'good'
      ? 'border-emerald-200 bg-emerald-50 text-emerald-950'
      : 'border-slate-200 bg-slate-50 text-slate-950'
  const iconStyle = tone === 'bad' ? 'bg-rose-500 text-white' : tone === 'good' ? 'bg-emerald-500 text-white' : 'bg-primary text-primary-foreground'

  return (
    <section className={`rounded-2xl border p-3.5 ${style}`}>
      <div className="flex items-center gap-2.5">
        <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${iconStyle}`}><Icon className="h-4 w-4" /></span>
        <b className="text-[10px] font-black uppercase tracking-[0.12em] sm:text-[11px]">{label}</b>
      </div>
      <p className="mt-3 whitespace-pre-wrap text-sm leading-7 md:text-[15px]">{text}</p>
    </section>
  )
}

function SectionLabel({ icon: Icon, label }) {
  return <div className="flex min-w-0 items-center gap-2.5"><span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-primary/15 text-primary"><Icon className="h-3.5 w-3.5" /></span><span className="min-w-0 text-[9px] font-black uppercase tracking-[0.14em] text-muted-foreground sm:text-[10px]">{label}</span><span className="h-px min-w-4 flex-1 bg-border" /></div>
}

function StepNavButton({ step, index, active, complete, onClick }) {
  return (
    <button type="button" onClick={onClick} className={`flex w-full items-center gap-3 rounded-xl border p-3 text-left transition ${active ? 'border-primary bg-primary/10 shadow-sm' : 'border-transparent bg-muted/20 hover:border-border hover:bg-muted/40'}`}>
      <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-xs font-bold ${complete ? 'bg-emerald-100 text-emerald-700' : active ? 'bg-primary text-primary-foreground' : 'bg-white text-muted-foreground'}`}>{complete ? <Check className="h-4 w-4" /> : index + 1}</span>
      <span className="min-w-0 flex-1">{step.section_title ? <span className="block truncate text-[10px] uppercase tracking-wide text-muted-foreground">{step.section_title}</span> : null}<span className="line-clamp-2 block text-xs font-semibold leading-5">{step.step_title}</span></span>
      <ChevronRight className={`h-4 w-4 shrink-0 ${active ? 'text-primary' : 'text-muted-foreground'}`} />
    </button>
  )
}

function CompactInfo({ icon: Icon, label, text }) {
  return <div className="rounded-xl border bg-muted/15 p-3"><div className="flex items-center gap-2"><Icon className="h-4 w-4 text-primary" /><b className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</b></div><p className="mt-2 whitespace-pre-wrap text-sm leading-6">{text}</p></div>
}

function ProgressPanel({ progress, current, total, acknowledged }) {
  return <section className="rounded-2xl border bg-white p-4"><SectionLabel icon={ListChecks} label="学习进度 / PROGRESS" /><div className="mt-4 flex items-center gap-4"><div className="relative flex h-20 w-20 shrink-0 items-center justify-center rounded-full bg-muted"><div className="absolute inset-1 rounded-full bg-white" /><b className="relative text-lg">{acknowledged ? '100%' : `${progress}%`}</b></div><div><b className="text-sm">Step {Math.min(current + 1, Math.max(total, 1))} of {Math.max(total, 1)}</b><p className="mt-1 text-xs leading-5 text-muted-foreground">{acknowledged ? 'This SOP version is acknowledged.' : 'Complete the steps in order.'}</p></div></div></section>
}

function CompletionPanel({ isLast, acknowledged, saving, onAcknowledge }) {
  return <section className="rounded-2xl border bg-white p-4"><SectionLabel icon={CheckCircle2} label="完成确认 / COMPLETE" /><p className="mt-3 text-sm leading-6 text-muted-foreground">{isLast ? '确认你已经看过做法、错误情况和完成标准。' : '完成当前步骤后继续下一步；最后一步才进行确认。'}</p><Button className="mt-4 w-full" disabled={!isLast || saving || acknowledged} onClick={onAcknowledge}>{saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <CheckCircle2 className="mr-2 h-4 w-4" />}{acknowledged ? '已阅读并理解' : isLast ? '完成本章' : '请先完成所有步骤'}</Button></section>
}
