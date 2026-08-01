import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Link, useParams } from 'react-router-dom'
import { opsClient } from '@/api/opsClient'
import { useAuth } from '@/lib/AuthContext'
import { parseOutletIds } from '@/lib/outlets'
import MediaLightbox from '@/components/MediaLightbox'
import { Button } from '@/components/ui/button'
import {
  AlertTriangle, ArrowLeft, BookOpen, Check, CheckCircle2, ChevronLeft,
  ChevronRight, ClipboardCheck, Expand, HelpCircle, Image as ImageIcon,
  ListChecks, Loader2, Menu, ShieldAlert, Sparkles, Target, X,
} from 'lucide-react'

const truthy = (value) => value === true || String(value).toLowerCase() === 'true'
const OPS_POSTER_SOPS = new Set([
  'sop-ops-opening-preparation', 'sop-ops-opening-area', 'sop-ops-non-busy-cleaning',
  'sop-ops-closing-kitchen', 'sop-ops-closing-front', 'sop-ops-toilet-closing',
  'sop-ops-garbage-bin', 'sop-ops-freezer-deep-clean',
])

function dateLabel(value) {
  if (!value) return ''
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? String(value) : parsed.toLocaleDateString('en-MY', { day: '2-digit', month: 'short', year: 'numeric' })
}

function isOnboardingSop(sop) {
  return /onboarding|入职|new staff|pekerja baru/i.test(`${sop?.sop_code || ''} ${sop?.title || ''} ${sop?.category || ''}`)
}

function hasMaskReminder(sop, steps) {
  const text = [sop?.title, sop?.summary, sop?.purpose, sop?.scope, sop?.safety_notes,
    ...steps.flatMap((step) => [step.section_title, step.step_title, step.instruction, step.warning, step.quality_check])].join(' ')
  return /口罩|face\s*mask|mask\b|pelitup\s*muka/i.test(text)
}

function buildGuides(sop, steps, assets) {
  const stepGuides = steps.map((step, index) => ({
    id: step.id,
    kind: 'step',
    number: index + 1,
    title: step.step_title,
    section: step.section_title,
    instruction: step.instruction,
    warning: step.warning,
    quality: step.quality_check,
    assets: assets.filter((asset) => String(asset.step_id || '') === String(step.id)),
    stepIndex: index,
  }))

  const guides = [...stepGuides]
  const warnings = steps.filter((step) => String(step.warning || '').trim())
  const passes = steps.filter((step) => String(step.quality_check || '').trim())

  if (warnings.length) guides.push({
    id: `${sop.id}-attention`, kind: 'attention', title: '注意事项与禁止 / IMPORTANT NOTES',
    items: warnings.map((step, index) => ({ number: index + 1, title: step.step_title, text: step.warning })),
  })
  if (passes.length) guides.push({
    id: `${sop.id}-pass`, kind: 'pass', title: '完成标准 / PASS STANDARD',
    items: passes.map((step, index) => ({ number: index + 1, title: step.step_title, text: step.quality_check })),
  })
  if (sop.source_document_url) guides.push({ id: `${sop.id}-reference`, kind: 'reference', title: '完整海报与拍照要求 / FULL REFERENCE', src: sop.source_document_url })
  return guides
}

function posterCropFor(sop, guide, stepCount) {
  if (!OPS_POSTER_SOPS.has(sop?.id) || !sop?.source_document_url) return null
  const start = 224
  const end = 835
  if (guide.kind === 'step') {
    const y0 = Math.round(start + ((end - start) * guide.stepIndex) / stepCount) - 2
    const y1 = Math.round(start + ((end - start) * (guide.stepIndex + 1)) / stepCount) + 2
    return { src: sop.source_document_url, y0, y1, width: 900, height: 1272 }
  }
  if (guide.kind === 'attention') return { src: sop.source_document_url, y0: 834, y1: 989, width: 900, height: 1272 }
  if (guide.kind === 'pass') return { src: sop.source_document_url, y0: 987, y1: 1136, width: 900, height: 1272 }
  if (guide.kind === 'reference') return { src: sop.source_document_url, y0: 1134, y1: 1220, width: 900, height: 1272 }
  return null
}

export default function GuidedSopGuideBook() {
  const { sopId } = useParams()
  const { user } = useAuth()
  const contentRef = useRef(null)
  const [sop, setSop] = useState(null)
  const [steps, setSteps] = useState([])
  const [assets, setAssets] = useState([])
  const [acks, setAcks] = useState([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [index, setIndex] = useState(0)
  const [menuOpen, setMenuOpen] = useState(false)
  const [media, setMedia] = useState(null)

  useEffect(() => {
    const nav = document.getElementById('chefops-mobile-nav')
    const main = document.getElementById('chefops-mobile-main')
    const oldNav = nav?.style.display || ''
    const oldPad = main?.style.paddingBottom || ''
    const oldBg = main?.style.background || ''
    document.documentElement.classList.add('chefops-guided-sop-active')
    if (nav) nav.style.display = 'none'
    if (main) { main.style.paddingBottom = '0px'; main.style.background = '#f4efe3' }
    return () => {
      document.documentElement.classList.remove('chefops-guided-sop-active')
      if (nav) nav.style.display = oldNav
      if (main) { main.style.paddingBottom = oldPad; main.style.background = oldBg }
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    Promise.all([
      opsClient.entities.SOP.filter({ id: sopId }, '', 5),
      opsClient.entities.SOPStep.filter({ sop_id: sopId }, 'step_order', 300),
      opsClient.entities.SOPAsset.filter({ sop_id: sopId }, 'step_id,display_order', 500),
      opsClient.entities.TrainingAcknowledgement.filter({ sop_id: sopId, user_email: user?.email || '' }, '-acknowledged_at', 20),
    ]).then(([sopRows, stepRows, assetRows, ackRows]) => {
      if (cancelled) return
      const nextSop = (sopRows || [])[0] || null
      const nextSteps = (stepRows || []).filter((row) => truthy(row.active)).sort((a, b) => Number(a.step_order) - Number(b.step_order))
      setSop(nextSop)
      setSteps(nextSteps)
      setAssets((assetRows || []).filter((row) => truthy(row.active)))
      setAcks(ackRows || [])
      const saved = Number(localStorage.getItem(`ops:sop:${sopId}:guide`) || 0)
      setIndex(Math.max(0, saved))
    }).catch((err) => !cancelled && setError(err.message || 'Unable to load SOP')).finally(() => !cancelled && setLoading(false))
    return () => { cancelled = true }
  }, [sopId, user?.email])

  const guides = useMemo(() => sop ? buildGuides(sop, steps, assets) : [], [sop, steps, assets])
  const current = guides[Math.min(index, Math.max(guides.length - 1, 0))]
  const version = sop?.version_label || String(sop?.version || '')
  const acknowledged = acks.some((row) => String(row.acknowledged_version) === String(version))
  const progress = guides.length ? Math.round(((Math.min(index, guides.length - 1) + 1) / guides.length) * 100) : 0
  const crop = posterCropFor(sop, current, steps.length)

  useEffect(() => {
    if (!guides.length) return
    const safe = Math.min(index, guides.length - 1)
    if (safe !== index) setIndex(safe)
    localStorage.setItem(`ops:sop:${sopId}:guide`, String(safe))
    const host = document.getElementById('chefops-mobile-main')
    if (host) host.scrollTo({ top: Math.max(0, (contentRef.current?.offsetTop || 0) - 82), behavior: 'smooth' })
  }, [index, guides.length, sopId])

  function go(next) { setIndex(Math.min(Math.max(next, 0), Math.max(guides.length - 1, 0))); setMenuOpen(false) }
  function openAsset(asset) {
    const type = String(asset.asset_type || '').toLowerCase()
    setMedia({ src: asset.file_url || asset.thumbnail_url || '', poster: asset.thumbnail_url || '', title: asset.caption || asset.file_name || 'SOP reference', type: type === 'video' ? 'video' : 'image' })
  }
  async function acknowledge() {
    if (!sop || acknowledged) return
    setSaving(true); setError('')
    try {
      const row = await opsClient.entities.TrainingAcknowledgement.create({ sop_id: sop.id, user_email: user?.email || '', user_name: user?.full_name || user?.email || '', outlet_id: user?.outlet_id || parseOutletIds(user)[0] || '', acknowledged_version: version, status: 'acknowledged' })
      setAcks((rows) => [row, ...rows])
    } catch (err) { setError(err.message || 'Unable to acknowledge SOP') } finally { setSaving(false) }
  }

  if (loading) return <div className="flex min-h-[60dvh] items-center justify-center"><Loader2 className="h-7 w-7 animate-spin" /></div>
  if (!sop) return <div className="mx-auto max-w-lg p-4"><Link to="/training" className="flex items-center gap-2"><ArrowLeft className="h-4 w-4" />返回 SOP Library</Link><div className="mt-4 rounded-xl border bg-red-50 p-4 text-red-800">{error || 'SOP not found'}</div></div>

  const actions = <div className="fixed inset-x-0 bottom-0 z-[480] border-t-2 border-black bg-white md:hidden"><div className="mx-auto grid max-w-[680px] grid-cols-[0.9fr_1.2fr] gap-2 p-2.5 pb-[max(.7rem,env(safe-area-inset-bottom))]"><Button variant="outline" className="h-12 border-black font-bold" disabled={index === 0} onClick={() => go(index - 1)}><ChevronLeft className="mr-1 h-4 w-4" />上一步</Button>{index < guides.length - 1 ? <Button className="h-12 border border-black bg-[#f7b500] font-black text-black" onClick={() => go(index + 1)}>下一步<ChevronRight className="ml-1 h-4 w-4" /></Button> : <Button className="h-12 border border-black bg-[#f7b500] font-black text-black" onClick={acknowledge} disabled={saving || acknowledged}>{saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <CheckCircle2 className="mr-2 h-4 w-4" />}{acknowledged ? '已完成' : '我已阅读并理解'}</Button>}</div></div>

  return <>
    <div className="min-h-full bg-[#f4efe3] pb-24 md:px-4 md:pb-8 xl:px-6">
      <header className="sticky top-0 z-40 border-b-2 border-black bg-[#f7b500] shadow-sm md:top-2 md:mx-auto md:mt-2 md:max-w-[1500px] md:rounded-2xl md:border-2">
        <div className="h-1.5 bg-black" />
        <div className="flex items-start gap-3 px-3 py-3 md:px-5">
          <Link to="/training" className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border-2 border-black bg-white"><ArrowLeft className="h-4 w-4" /></Link>
          <img src="/stupiaks-ops-192.png" alt="Stupiak's" className="hidden h-11 w-11 rounded-xl border-2 border-black bg-white sm:block" />
          <div className="min-w-0 flex-1"><div className="flex flex-wrap gap-2 text-[9px] font-black uppercase tracking-[.12em]"><span className="rounded-full bg-black px-2.5 py-1 text-white">{sop.sop_code}</span><span>Version {version || '-'}</span>{sop.effective_date ? <span className="hidden sm:inline">Effective {dateLabel(sop.effective_date)}</span> : null}</div><h1 className="mt-1 line-clamp-2 text-[17px] font-black leading-5 md:text-xl xl:text-2xl">{sop.title}</h1></div>
          <button onClick={() => setMenuOpen(true)} className="flex h-10 items-center gap-1.5 rounded-xl border-2 border-black bg-white px-3 text-xs font-black md:hidden"><Menu className="h-4 w-4" />{index + 1}/{Math.max(guides.length, 1)}</button>
        </div>
        <div className="flex items-center gap-3 border-t border-black/20 px-3 py-2 md:px-5"><div className="h-2 flex-1 overflow-hidden rounded-full border border-black bg-white/75"><div className="h-full bg-black" style={{ width: `${progress}%` }} /></div><span className="w-10 text-right text-xs font-black">{progress}%</span></div>
      </header>

      <div className="mx-auto max-w-[1500px]">
        {error ? <div className="mx-3 mt-3 rounded-xl border-2 border-red-500 bg-red-50 p-3 text-sm text-red-800 md:mx-0">{error}</div> : null}
        <div className="grid gap-4 md:mt-4 md:grid-cols-[230px_minmax(0,1fr)] xl:grid-cols-[260px_minmax(0,1fr)_300px]">
          <aside className="hidden md:block"><div className="sticky top-28 overflow-hidden rounded-2xl border-2 border-black bg-white"><div className="bg-black px-4 py-3 text-white"><SectionTitle icon={ListChecks} label="学习指南 / GUIDES" inverse /></div><nav className="space-y-1.5 p-3">{guides.map((guide, i) => <GuideNav key={guide.id} guide={guide} index={i} active={i === index} complete={i < index || acknowledged} onClick={() => go(i)} />)}</nav></div></aside>
          <main ref={contentRef} className="min-w-0 scroll-mt-24 space-y-3 md:space-y-4">
            {index === 0 ? <StartPanel sop={sop} showMaskReminder={isOnboardingSop(sop) && !hasMaskReminder(sop, steps)} /> : null}
            <GuideCard guide={current} index={index} total={guides.length} crop={crop} onOpenAsset={openAsset} onOpenCrop={() => crop && setMedia({ src: crop.src, title: current.title, type: 'image' })} />
            <div className="hidden grid-cols-[1fr_auto_1fr] items-center gap-3 md:grid"><Button variant="outline" disabled={index === 0} onClick={() => go(index - 1)}><ChevronLeft className="mr-1 h-4 w-4" />上一步</Button><span className="text-xs text-muted-foreground">{index + 1} / {guides.length}</span>{index < guides.length - 1 ? <Button className="justify-self-end" onClick={() => go(index + 1)}>下一步<ChevronRight className="ml-1 h-4 w-4" /></Button> : <Button className="justify-self-end" onClick={acknowledge} disabled={saving || acknowledged}><CheckCircle2 className="mr-2 h-4 w-4" />{acknowledged ? '已完成' : '完成本章'}</Button>}</div>
          </main>
          <aside className="hidden xl:block"><div className="sticky top-28 space-y-4"><InfoPanel icon={ListChecks} title="学习进度 / PROGRESS"><b>{index + 1} / {guides.length}</b><p>{progress}% complete</p></InfoPanel><InfoPanel icon={HelpCircle} title="需要帮助 / HELP"><p>不确定时停止操作，立即询问培训员或领班，不要自行猜测。</p></InfoPanel></div></aside>
        </div>
      </div>
    </div>
    {typeof document !== 'undefined' ? createPortal(actions, document.body) : null}
    {menuOpen && typeof document !== 'undefined' ? createPortal(<div className="fixed inset-0 z-[500] bg-black/45 md:hidden" onClick={() => setMenuOpen(false)}><div className="absolute inset-x-0 bottom-0 mx-auto max-h-[82dvh] max-w-[680px] overflow-hidden rounded-t-3xl bg-white" onClick={(e) => e.stopPropagation()}><div className="flex items-center justify-between border-b p-4"><div><b>选择 Guide</b><p className="text-xs text-muted-foreground">一个标题，一个画面。</p></div><button onClick={() => setMenuOpen(false)} className="flex h-9 w-9 items-center justify-center rounded-xl border"><X className="h-4 w-4" /></button></div><div className="max-h-[calc(82dvh-76px)] space-y-2 overflow-y-auto p-4">{guides.map((guide, i) => <GuideNav key={guide.id} guide={guide} index={i} active={i === index} complete={i < index || acknowledged} onClick={() => go(i)} />)}</div></div></div>, document.body) : null}
    <MediaLightbox open={Boolean(media)} onOpenChange={(open) => !open && setMedia(null)} src={media?.src || ''} title={media?.title || 'SOP reference'} type={media?.type || 'image'} poster={media?.poster || ''} />
  </>
}

function GuideCard({ guide, index, total, crop, onOpenAsset, onOpenCrop }) {
  if (!guide) return null
  const tone = guide.kind === 'attention' ? 'bg-red-600 text-white' : guide.kind === 'pass' ? 'bg-emerald-600 text-white' : 'bg-[#f7b500] text-black'
  return <article className="overflow-hidden border-y-2 border-black bg-white shadow-sm md:rounded-2xl md:border-2">
    <div className={`${tone} px-4 py-3.5 md:px-5`}><div className="flex items-start gap-3"><span className="flex h-11 min-w-11 items-center justify-center rounded-full border-2 border-current bg-white/25 px-2 text-lg font-black">{guide.kind === 'attention' ? '!' : guide.kind === 'pass' ? '✓' : guide.kind === 'reference' ? '📷' : guide.number || index + 1}</span><div><p className="text-[10px] font-black uppercase tracking-[.18em] opacity-75">Guide {index + 1} of {total}</p>{guide.section ? <p className="mt-0.5 text-[11px] font-bold opacity-80">{guide.section}</p> : null}<h2 className="mt-0.5 text-xl font-black leading-7">{guide.title}</h2></div></div></div>
    {crop ? <PosterCrop crop={crop} title={guide.title} onOpen={onOpenCrop} /> : null}
    {!crop && guide.assets?.length ? <AssetList assets={guide.assets} onOpenAsset={onOpenAsset} /> : null}
    <div className="space-y-4 p-4 md:p-5">
      {guide.kind === 'step' ? <><TextBlock icon={BookOpen} label="怎么做 / HOW TO DO" text={guide.instruction} /><TextBlock icon={AlertTriangle} label="错误与禁止 / DO NOT" text={guide.warning} tone="bad" /><TextBlock icon={ClipboardCheck} label="完成标准 / PASS" text={guide.quality} tone="good" /></> : null}
      {guide.items?.map((item) => <div key={`${guide.id}-${item.number}`} className={`rounded-xl border-2 p-4 ${guide.kind === 'attention' ? 'border-red-300 bg-red-50' : 'border-emerald-300 bg-emerald-50'}`}><div className="flex gap-3"><span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-black text-sm font-black text-white">{item.number}</span><div><b className="text-sm">{item.title}</b><p className="mt-1 whitespace-pre-wrap text-sm leading-6">{item.text}</p></div></div></div>)}
      {guide.kind === 'reference' ? <div className="rounded-xl border-2 border-black bg-[#fff4bf] p-4"><b>完整海报只作为总览参考</b><p className="mt-2 text-sm leading-6">员工平时按前面的 Guide 逐页学习；需要核对整张布局或拍照要求时才打开完整海报。</p><a href={guide.src} target="_blank" rel="noreferrer" className="mt-3 inline-flex items-center gap-2 rounded-lg bg-black px-4 py-2 text-sm font-bold text-white"><Expand className="h-4 w-4" />打开完整海报</a></div> : null}
    </div>
  </article>
}

function PosterCrop({ crop, title, onOpen }) {
  const cropHeight = Math.max(1, crop.y1 - crop.y0)
  return <button type="button" onClick={onOpen} className="block w-full border-b-2 border-black bg-[#fff9e8] p-3 text-left md:p-4"><div className="mb-2 flex items-center justify-between"><SectionTitle icon={ImageIcon} label="对应图解 / VISUAL GUIDE" /><span className="flex items-center gap-1 rounded-lg bg-black px-2 py-1 text-[10px] font-bold text-white"><Expand className="h-3 w-3" />放大</span></div><div className="relative mx-auto w-full overflow-hidden rounded-xl border-2 border-black bg-white" style={{ aspectRatio: `${crop.width} / ${cropHeight}` }}><img src={crop.src} alt={title} className="absolute left-0 w-full max-w-none" style={{ top: `${-(crop.y0 / cropHeight) * 100}%`, height: `${(crop.height / cropHeight) * 100}%` }} /></div></button>
}

function AssetList({ assets, onOpenAsset }) { return <div className="border-b-2 border-black bg-[#fff9e8] p-3 md:p-4"><SectionTitle icon={ImageIcon} label="对应图解 / VISUAL GUIDE" /><div className="mt-3 grid gap-3 sm:grid-cols-2">{assets.map((asset) => <button key={asset.id} onClick={() => onOpenAsset(asset)} className="overflow-hidden rounded-xl border-2 border-black bg-white text-left"><img src={asset.file_url || asset.thumbnail_url || ''} alt={asset.caption || asset.file_name || ''} className="block h-auto w-full object-contain" /><span className="block border-t-2 border-black px-3 py-2 text-xs font-bold">{asset.caption || asset.file_name}</span></button>)}</div></div> }
function TextBlock({ icon: Icon, label, text, tone = 'default' }) { if (!text) return null; const c = tone === 'bad' ? 'border-red-300 bg-red-50' : tone === 'good' ? 'border-emerald-300 bg-emerald-50' : 'border-black/20 bg-[#fafafa]'; return <section><SectionTitle icon={Icon} label={label} /><div className={`mt-3 rounded-xl border-2 p-4 ${c}`}><p className="whitespace-pre-wrap text-sm leading-7 md:text-[15px]">{text}</p></div></section> }
function StartPanel({ sop, showMaskReminder }) { return <section className="mx-3 overflow-hidden rounded-2xl border-2 border-black bg-white md:mx-0"><div className="border-b-2 border-black bg-black p-4 text-white"><div className="flex gap-3"><Sparkles className="h-5 w-5" /><div><p className="text-[10px] font-black uppercase tracking-[.16em] text-[#f7b500]">Before you start</p><p className="mt-1 text-sm leading-6">{sop.summary || sop.purpose}</p></div></div></div><div className="grid gap-3 p-4 lg:grid-cols-2">{sop.purpose ? <MiniInfo icon={Target} label="目的 / PURPOSE" text={sop.purpose} /> : null}{sop.scope ? <MiniInfo icon={BookOpen} label="范围 / SCOPE" text={sop.scope} /> : null}{showMaskReminder ? <div className="flex gap-3 rounded-xl border-2 border-black bg-[#fff4bf] p-3 lg:col-span-2"><ShieldAlert className="h-5 w-5" /><div><b>员工必须自行准备口罩</b><p className="text-sm">Self-prepared face mask required.</p></div></div> : null}{sop.safety_notes ? <div className="flex gap-3 rounded-xl border-2 border-amber-400 bg-amber-50 p-3 lg:col-span-2"><ShieldAlert className="h-5 w-5" /><div><b>安全提醒 / SAFETY</b><p className="mt-1 whitespace-pre-wrap text-sm leading-6">{sop.safety_notes}</p></div></div> : null}</div></section> }
function GuideNav({ guide, index, active, complete, onClick }) { return <button onClick={onClick} className={`flex w-full items-center gap-3 rounded-xl border-2 p-3 text-left ${active ? 'border-black bg-[#fff0ad]' : 'border-transparent bg-[#f5f5f5]'}`}><span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-xs font-black ${complete ? 'bg-emerald-600 text-white' : active ? 'bg-black text-white' : 'bg-white text-black'}`}>{complete ? <Check className="h-4 w-4" /> : guide.kind === 'attention' ? '!' : guide.kind === 'pass' ? '✓' : guide.kind === 'reference' ? '📷' : guide.number || index + 1}</span><span className="line-clamp-2 text-xs font-bold leading-5">{guide.title}</span></button> }
function SectionTitle({ icon: Icon, label, inverse = false }) { return <div className="flex items-center gap-2"><Icon className="h-4 w-4" /><b className={`text-[10px] uppercase tracking-[.13em] ${inverse ? 'text-white' : 'text-black/70'}`}>{label}</b><span className={`h-px flex-1 ${inverse ? 'bg-white/30' : 'bg-black/15'}`} /></div> }
function MiniInfo({ icon: Icon, label, text }) { return <div className="rounded-xl border-2 border-black/15 p-3"><div className="flex gap-2"><Icon className="h-4 w-4" /><b className="text-[10px] uppercase tracking-wide">{label}</b></div><p className="mt-2 whitespace-pre-wrap text-sm leading-6">{text}</p></div> }
function InfoPanel({ icon: Icon, title, children }) { return <section className="rounded-2xl border-2 border-black bg-white p-4"><SectionTitle icon={Icon} label={title} /><div className="mt-3 text-sm leading-6">{children}</div></section> }
