import { ArrowRight, CheckCircle2, Image as ImageIcon, Sparkles } from 'lucide-react'

const PALETTE = [
  { bg: '#FFF0B5', accent: '#F5B400', ink: '#4A3700' },
  { bg: '#DDF4E6', accent: '#2F9E5B', ink: '#17462A' },
  { bg: '#DDEEFF', accent: '#3B82F6', ink: '#173A63' },
  { bg: '#FBE1D8', accent: '#D95D39', ink: '#642B1B' },
  { bg: '#EEE4FF', accent: '#8B5CF6', ink: '#41256F' },
  { bg: '#ECEFF3', accent: '#667085', ink: '#303846' },
]

function bilingualParts(value) {
  const text = String(value || '').trim()
  const parts = text.split(/\s+\/\s+/)
  if (parts.length < 2) return [text, '']
  return [parts[0].trim(), parts.slice(1).join(' / ').trim()]
}

function cleanItem(value, locale) {
  let text = String(value || '')
    .replace(/[()（）]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/[。.!]+$/g, '')
    .trim()

  if (locale === 'zh') {
    text = text.replace(/^(确认|检查|清除|清洁|清洗|处理|把|先|按|使用|放置|取出|完成|开始|移走|补充|擦掉|刷洗|拍摄|站在|从|再|最后)\s*/u, '')
  } else {
    text = text.replace(/^(confirm|check|remove|clean|wash|handle|use|place|take|start|move|transfer|return|fit|wipe|scrub|follow|keep|photograph|restore)\s+/i, '')
  }

  if (text.length > 34) text = `${text.slice(0, 31).trim()}…`
  return text
}

function splitItems(text, locale) {
  const sentence = String(text || '').split(locale === 'zh' ? /[。！？]/ : /[.!?]/)[0]
  const splitter = locale === 'zh'
    ? /[、，；→]|然后|再|最后/u
    : /,|;|→|\bthen\b|\band\b|\bfinally\b/i

  return sentence
    .replace(/[:：]/g, locale === 'zh' ? '，' : ',')
    .split(splitter)
    .map((item) => cleanItem(item, locale))
    .filter((item) => item.length > 1)
}

function visualItems(step) {
  const [zhInstruction, enInstruction] = bilingualParts(step?.instruction)
  const [zhTitle, enTitle] = bilingualParts(step?.step_title)
  const zhItems = splitItems(zhInstruction, 'zh')
  const enItems = splitItems(enInstruction, 'en')
  const count = Math.min(6, Math.max(zhItems.length, enItems.length))
  const items = []

  for (let index = 0; index < count; index += 1) {
    const label = zhItems[index] || enItems[index] || zhTitle || enTitle || `步骤 ${index + 1}`
    const sub = enItems[index] && enItems[index] !== label ? enItems[index] : ''
    const key = `${label}|${sub}`.toLowerCase()
    if (!items.some((item) => `${item.label}|${item.sub}`.toLowerCase() === key)) {
      items.push({ label, sub })
    }
  }

  if (items.length < 3) {
    const fallbacks = [
      { label: zhTitle || '当前步骤', sub: enTitle || 'Current step' },
      { label: '按顺序完成', sub: 'Follow the order' },
      { label: '最后确认', sub: 'Final check' },
    ]
    fallbacks.forEach((item) => {
      if (items.length < 3 && !items.some((row) => row.label === item.label)) items.push(item)
    })
  }

  return items.slice(0, 6)
}

function modeFor(step) {
  const source = `${step?.step_title || ''} ${step?.instruction || ''}`
  return /→|\bthen\b|\bfirst\b|\bafter\b|\bbefore\b|\bfollow\b|先|再|然后|最后|完成后/i.test(source)
    ? 'flow'
    : 'grid'
}

function colorFor(item, index) {
  const source = `${item.label} ${item.sub}`.toLowerCase()
  if (/lettuce|green|clean|ready|dry|safe|guest|整洁|干净|安全|完成|归位/.test(source)) return PALETTE[1]
  if (/water|rinse|freezer|chiller|toilet|basin|mop|frost|ice|wash|水|冰|冷柜|厕所|洗手盆|拖把|冲洗/.test(source)) return PALETTE[2]
  if (/meat|pork|beef|chicken|grease|oil|patty|肉|油|肉饼/.test(source)) return PALETTE[3]
  if (/report|photo|label|record|通知|报告|照片|标签|记录/.test(source)) return PALETTE[4]
  if (/bin|trash|waste|rubbish|垃圾|残渣|废物/.test(source)) return PALETTE[5]
  return PALETTE[index % PALETTE.length]
}

function TileVisual({ items }) {
  return (
    <div className="mt-4 grid grid-cols-2 gap-2.5 sm:grid-cols-3 md:gap-3">
      {items.map((item, index) => {
        const tone = colorFor(item, index)
        return (
          <div
            key={`${item.label}-${index}`}
            className="relative min-h-[108px] overflow-hidden rounded-xl border border-black/10 bg-white/90 p-3 shadow-sm md:min-h-[126px] md:p-4"
          >
            <div className="absolute -right-5 -top-5 h-16 w-16 rounded-full opacity-30" style={{ background: tone.bg }} />
            <div className="relative flex items-start justify-between gap-2">
              <span
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-sm font-black"
                style={{ background: tone.bg, color: tone.ink }}
              >
                {index + 1}
              </span>
              <span className="mt-1 h-2 w-8 rounded-full" style={{ background: tone.accent }} />
            </div>
            <b className="relative mt-3 block text-sm leading-5 text-slate-950 md:text-[15px]">{item.label}</b>
            {item.sub ? <span className="relative mt-1 block text-[11px] leading-4 text-slate-500 md:text-xs">{item.sub}</span> : null}
          </div>
        )
      })}
    </div>
  )
}

function FlowVisual({ items }) {
  return (
    <div className="mt-4 grid grid-cols-2 gap-2.5 sm:grid-cols-4 md:gap-3">
      {items.slice(0, 4).map((item, index, rows) => {
        const tone = colorFor(item, index)
        return (
          <div key={`${item.label}-${index}`} className="relative">
            <div className="min-h-[126px] rounded-xl border border-black/10 bg-white/90 p-3 shadow-sm md:min-h-[145px] md:p-4">
              <div className="flex items-center justify-between gap-2">
                <span
                  className="flex h-10 w-10 items-center justify-center rounded-full text-base font-black"
                  style={{ background: tone.accent, color: '#FFFFFF' }}
                >
                  {index + 1}
                </span>
                <CheckCircle2 className="h-5 w-5" style={{ color: tone.accent }} />
              </div>
              <b className="mt-4 block text-sm leading-5 text-slate-950 md:text-[15px]">{item.label}</b>
              {item.sub ? <span className="mt-1 block text-[11px] leading-4 text-slate-500 md:text-xs">{item.sub}</span> : null}
            </div>
            {index < rows.length - 1 ? (
              <span className="absolute -right-3 top-1/2 z-10 hidden h-7 w-7 -translate-y-1/2 items-center justify-center rounded-full border bg-white shadow-sm sm:flex">
                <ArrowRight className="h-3.5 w-3.5 text-slate-500" />
              </span>
            ) : null}
          </div>
        )
      })}
    </div>
  )
}

export default function StepVisual({ step, index, total }) {
  const items = visualItems(step)
  const mode = modeFor(step)
  const [zhTitle, enTitle] = bilingualParts(step?.step_title)

  return (
    <section className="border-b bg-[#FFF9E8] p-3 md:p-4">
      <div className="flex items-center gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-[#F5B400]/15 text-[#C98C00]">
          <ImageIcon className="h-4 w-4" />
        </span>
        <span className="shrink-0 text-[11px] font-bold uppercase tracking-[0.14em] text-slate-600">步骤视觉 / STEP VISUAL</span>
        <span className="h-px min-w-6 flex-1 bg-amber-200" />
      </div>

      <div className="relative mt-3 overflow-hidden rounded-2xl border border-amber-300 bg-[#FFFDF6] shadow-sm">
        <div className="absolute -right-16 -top-16 h-44 w-44 rounded-full bg-[#F5B400]/10" />
        <div className="absolute -bottom-20 -left-16 h-44 w-44 rounded-full bg-[#F5B400]/10" />

        <div className="relative min-h-[270px] p-4 md:min-h-[320px] md:p-5">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2 text-[10px] font-black uppercase tracking-[0.18em] text-[#B77900]">
                <Sparkles className="h-3.5 w-3.5" />
                Visual guide · {index + 1}/{Math.max(total, 1)}
              </div>
              <h3 className="mt-2 text-lg font-black leading-6 text-slate-950 md:text-xl">{zhTitle || step?.step_title}</h3>
              {enTitle ? <p className="mt-1 text-xs font-semibold text-slate-500 md:text-sm">{enTitle}</p> : null}
            </div>
            <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-[#F5B400] text-lg font-black text-black shadow-sm">
              {index + 1}
            </span>
          </div>

          {mode === 'flow' ? <FlowVisual items={items} /> : <TileVisual items={items} />}
        </div>
      </div>
    </section>
  )
}
