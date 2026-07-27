import { useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle,
  Bath,
  Camera,
  Check,
  CheckCircle2,
  ChevronRight,
  CircleAlert,
  ClipboardCheck,
  Clock3,
  FileImage,
  Languages,
  Loader2,
  Lock,
  Moon,
  PackageCheck,
  Play,
  RefreshCw,
  Save,
  Sunrise,
  Trash2,
  TriangleAlert,
  XCircle,
} from 'lucide-react'

import { opsClient } from '@/api/opsClient'
import AppDrawer from '@/components/AppDrawer'
import MediaLightbox from '@/components/MediaLightbox'
import PageNotifications from '@/components/PageNotifications'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { useAuth } from '@/lib/AuthContext'
import { todayStr } from '@/lib/ops-helpers'
import { outletLabel, parseOutletIds } from '@/lib/outlets'
import { resolveMediaRule } from '@/lib/media-rules'
import { watermarkTaskPhoto } from '@/lib/watermark-image'

const LANGUAGE_KEY = 'chefops.task.content-language.v1'
const ISSUE_TYPES = [
  { value: 'insufficient_stock', cn: '库存不足', en: 'Insufficient Stock' },
  { value: 'equipment_problem', cn: '设备损坏', en: 'Equipment Problem' },
  { value: 'hygiene_issue', cn: '卫生问题', en: 'Hygiene Issue' },
  { value: 'item_not_found', cn: '找不到物品', en: 'Item Not Found' },
  { value: 'other', cn: '其他', en: 'Other' },
]

const STATUS = {
  locked: { cn: '未开放', en: 'Locked', className: 'bg-slate-100 text-slate-700', Icon: Lock },
  pending: { cn: '待完成', en: 'Pending', className: 'bg-amber-100 text-amber-800', Icon: Clock3 },
  in_progress: { cn: '进行中', en: 'In Progress', className: 'bg-sky-100 text-sky-800', Icon: Play },
  completed: { cn: '已完成', en: 'Completed', className: 'bg-emerald-100 text-emerald-800', Icon: CheckCircle2 },
  issue: { cn: '异常', en: 'Issue', className: 'bg-rose-100 text-rose-800', Icon: CircleAlert },
  overdue: { cn: '逾期', en: 'Overdue', className: 'bg-orange-100 text-orange-800', Icon: TriangleAlert },
}

function languageInitial() {
  const saved = String(localStorage.getItem(LANGUAGE_KEY) || 'bilingual')
  return ['cn', 'en', 'bilingual'].includes(saved) ? saved : 'bilingual'
}

function TextPair({ cn = '', en = '', mode = 'bilingual', className = '', enClassName = '' }) {
  const chinese = String(cn || '').trim()
  const english = String(en || '').trim()
  const fallback = chinese || english
  if (mode === 'cn') return <span className={className}>{chinese || english}</span>
  if (mode === 'en') return <span className={className}>{english || chinese}</span>
  if (!chinese || !english || chinese.toLowerCase() === english.toLowerCase()) return <span className={className}>{fallback}</span>
  return (
    <span className={`block ${className}`}>
      <span className="block">{chinese}</span>
      <span className={`mt-0.5 block text-[0.88em] text-muted-foreground ${enClassName}`}>{english}</span>
    </span>
  )
}

function taskTitle(task) {
  return {
    cn: task?.display?.task_name_cn || task?.display?.name_cn || '',
    en: task?.display?.task_name_en || task?.display?.name_en || task?.title || '',
  }
}

function taskInstruction(task) {
  return {
    cn: task?.display?.instruction_cn || '',
    en: task?.display?.instruction_en || task?.description || '',
  }
}

function contentPrimary(pair, mode) {
  const chinese = String(pair?.cn || '').trim()
  const english = String(pair?.en || '').trim()
  return mode === 'en' ? english || chinese : chinese || english
}

function contentSecondary(pair, mode) {
  if (mode !== 'bilingual') return ''
  const chinese = String(pair?.cn || '').trim()
  const english = String(pair?.en || '').trim()
  if (!chinese || !english || chinese.toLowerCase() === english.toLowerCase()) return ''
  return english
}

function timeText(iso, timeZone = 'Asia/Kuching') {
  if (!iso) return ''
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  return new Intl.DateTimeFormat('en-MY', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  }).format(date)
}

function photoUrl(row) {
  if (row?.file_url) return row.file_url
  if (row?.drive_file_id) return `${opsClient.apiBaseUrl}/api/files/${encodeURIComponent(row.drive_file_id)}`
  return ''
}

function photosForTask(rows, taskId) {
  return (rows || []).filter((row) => String(row.task_id || '') === String(taskId || '') && !row.deleted_at)
}

function samplesForTemplate(rows, templateId, outletId) {
  return (rows || []).filter((row) => (
    String(row.template_id || '') === String(templateId || '')
    && !row.deleted_at
    && (row.enabled === true || String(row.enabled).toLowerCase() === 'true')
    && (!row.outlet_id || String(row.outlet_id) === String(outletId))
  ))
}

function responseMap(task) {
  return Object.fromEntries((task?.responses || []).map((row) => [String(row.item_id), { ...row }]))
}

function isAnswered(item, response) {
  const value = response?.value
  if (value === '' || value === null || value === undefined) return false
  if (String(item.response_type || '').toUpperCase() === 'QUANTITY') return Number.isFinite(Number(value))
  return true
}

function shiftLabel(id) {
  if (id === 'MORNING') return { cn: '早班', en: 'Morning', Icon: Sunrise }
  if (id === 'NIGHT') return { cn: '晚班', en: 'Evening', Icon: Moon }
  return { cn: '全部', en: 'All', Icon: ClipboardCheck }
}

function statusMeta(task) {
  return STATUS[task?.status_key] || STATUS.pending
}

function shiftTasks(tasks, shift) {
  if (shift === 'ALL') return tasks
  return tasks.filter((task) => String(task.shift_id || '').toUpperCase() === shift)
}

function progressFor(data, shift) {
  return data?.progress?.[shift] || { total: 0, completed: 0, pending: 0, in_progress: 0, locked: 0, issue: 0, overdue: 0 }
}

export default function TasksV3() {
  const { user } = useAuth()
  const assigned = parseOutletIds(user)
  const [outlets, setOutlets] = useState([])
  const [outletId, setOutletId] = useState(() => assigned.includes(String(user?.outlet_id || '')) ? String(user.outlet_id) : assigned[0] || '')
  const [date, setDate] = useState(todayStr())
  const [language, setLanguage] = useState(languageInitial)
  const [shift, setShift] = useState('ALL')
  const [shiftChosen, setShiftChosen] = useState(false)
  const [data, setData] = useState({ tasks: [], task_photos: [], template_photos: [], progress: {}, current_shift_id: 'ALL' })
  const [mediaRules, setMediaRules] = useState([])
  const [selectedTaskId, setSelectedTaskId] = useState('')
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    opsClient.entities.Outlet.list('name', 100)
      .then((rows) => {
        const visible = (rows || []).filter((row) => assigned.includes(String(row.id)))
        setOutlets(visible)
        setOutletId((current) => visible.some((row) => String(row.id) === String(current)) ? current : visible[0]?.id || '')
      })
      .catch(() => setOutlets([]))
  }, [user?.outlet_id, user?.outlet_ids])

  useEffect(() => {
    localStorage.setItem(LANGUAGE_KEY, language)
  }, [language])

  useEffect(() => {
    if (!outletId) return
    opsClient.entities.MediaRule.filter({ module: 'task', outlet_id: outletId }, 'outlet_id', 50)
      .then(setMediaRules)
      .catch(() => setMediaRules([]))
  }, [outletId])

  useEffect(() => {
    if (outletId) load()
  }, [outletId, date])

  async function load({ force = false, quiet = false } = {}) {
    if (!quiet) setLoading(true)
    setRefreshing(true)
    setError('')
    try {
      const next = await opsClient.tasks.workflowBootstrap({ outletId, date, refresh: force })
      setData(next)
      if (!shiftChosen) setShift(['MORNING', 'NIGHT'].includes(next.current_shift_id) ? next.current_shift_id : 'ALL')
      setSelectedTaskId((current) => current && next.tasks.some((task) => String(task.id) === String(current)) ? current : '')
    } catch (loadError) {
      setError(loadError.message || 'Unable to load tasks')
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }

  async function taskAction(task, action, payload = {}) {
    const result = await opsClient.tasks.workflowAction({
      task_id: task.id,
      outlet_id: outletId,
      date,
      action,
      ...payload,
    })
    setData((current) => ({
      ...current,
      server_time: result.server_time || current.server_time,
      tasks: current.tasks.map((row) => String(row.id) === String(result.task.id) ? result.task : row),
    }))
    await load({ quiet: true })
    return result.task
  }

  const selectedOutlet = outlets.find((row) => String(row.id) === String(outletId))
  const selectedTask = data.tasks.find((row) => String(row.id) === String(selectedTaskId))
  const visibleTasks = useMemo(() => shiftTasks(data.tasks, shift), [data.tasks, shift])
  const progress = progressFor(data, shift)

  return (
    <div className="chefops-page mx-auto w-full max-w-xl space-y-4 p-4 pb-28">
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-xl font-heading font-bold">Tasks</h1>
          <p className="truncate text-xs text-muted-foreground">{outletLabel(selectedOutlet, outletId)} · Server-time controlled</p>
        </div>
        <div className="flex gap-2">
          <LanguageButton language={language} setLanguage={setLanguage} />
          <Button size="icon" variant="outline" onClick={() => load({ force: true })} disabled={refreshing}>
            <RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} />
          </Button>
        </div>
      </header>

      <PageNotifications page="/tasks" limit={3} />

      {outlets.length > 1 ? (
        <select value={outletId} onChange={(event) => setOutletId(event.target.value)} className="h-11 w-full rounded-xl border border-input bg-background px-3 text-sm">
          {outlets.map((outlet) => <option key={outlet.id} value={outlet.id}>{outletLabel(outlet, outlet.id)}</option>)}
        </select>
      ) : null}

      <Input type="date" value={date} onChange={(event) => setDate(event.target.value)} />

      <ShiftTabs shift={shift} language={language} onChange={(value) => { setShiftChosen(true); setShift(value) }} data={data} />
      <ShiftProgress progress={progress} shift={shift} language={language} />

      {error ? <div className="rounded-xl border border-rose-300 bg-rose-50 px-3 py-2 text-sm text-rose-800">{error}</div> : null}

      {loading ? (
        <div className="flex justify-center py-16"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
      ) : visibleTasks.length ? (
        <div className="space-y-2">
          {visibleTasks.map((task) => (
            <TaskCard
              key={task.id}
              task={task}
              language={language}
              onOpen={() => setSelectedTaskId(task.id)}
              onStart={() => taskAction(task, 'start').catch((actionError) => setError(actionError.message))}
            />
          ))}
        </div>
      ) : (
        <div className="rounded-2xl border border-dashed p-10 text-center">
          <ClipboardCheck className="mx-auto h-10 w-10 text-muted-foreground" />
          <p className="mt-3 text-sm font-semibold">No tasks are configured for this shift.</p>
          <p className="mt-1 text-xs text-muted-foreground">Select another shift or refresh the task list.</p>
        </div>
      )}

      <AppDrawer
        open={Boolean(selectedTask)}
        onOpenChange={(open) => !open && setSelectedTaskId('')}
        title={selectedTask ? contentPrimary(taskTitle(selectedTask), language) : 'Task'}
        subtitle={selectedTask ? contentSecondary(taskTitle(selectedTask), language) : ''}
        heightClass="h-[96dvh]"
      >
        {selectedTask ? (
          <TaskDetail
            task={selectedTask}
            taskPhotos={photosForTask(data.task_photos, selectedTask.id)}
            samples={samplesForTemplate(data.template_photos, selectedTask.template_id, outletId)}
            outletId={outletId}
            outletName={outletLabel(selectedOutlet, outletId)}
            language={language}
            mediaRule={resolveMediaRule(mediaRules, 'task', outletId)}
            onAction={(action, payload) => taskAction(selectedTask, action, payload)}
            onRefresh={() => load({ force: true, quiet: true })}
            onError={setError}
          />
        ) : null}
      </AppDrawer>
    </div>
  )
}

function LanguageButton({ language, setLanguage }) {
  const next = language === 'bilingual' ? 'cn' : language === 'cn' ? 'en' : 'bilingual'
  const label = language === 'bilingual' ? 'Content: 中+EN' : language === 'cn' ? 'Content: 中文' : 'Content: EN'
  return (
    <Button
      size="sm"
      variant="outline"
      className="h-10 rounded-xl px-3 text-xs"
      title="Task content language"
      onClick={() => setLanguage(next)}
    >
      <Languages className="mr-1.5 h-4 w-4" /> {label}
    </Button>
  )
}

function ShiftTabs({ shift, language, onChange, data }) {
  return (
    <div className="grid grid-cols-3 gap-2 rounded-2xl bg-muted/60 p-1.5">
      {['MORNING', 'NIGHT', 'ALL'].map((id) => {
        const meta = shiftLabel(id)
        const count = progressFor(data, id).total
        return (
          <button key={id} type="button" onClick={() => onChange(id)} className={`rounded-xl px-2 py-2 text-xs font-semibold ${shift === id ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground'}`}>
            <TextPair cn={meta.cn} en={meta.en} mode="en" />
            <span className="mt-0.5 block text-[10px] opacity-70">{count}</span>
          </button>
        )
      })}
    </div>
  )
}

function ShiftProgress({ progress, shift, language }) {
  const meta = shiftLabel(shift)
  const done = Number(progress.completed || 0)
  const total = Number(progress.total || 0)
  const percent = total ? Math.round((done / total) * 100) : 0
  return (
    <section className="rounded-2xl border bg-card p-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <span className="font-semibold">{meta.en} Tasks Progress</span>
          <p className="mt-1 text-xs text-muted-foreground">{done} / {total} completed</p>
        </div>
        <span className="text-2xl font-bold">{percent}%</span>
      </div>
      <div className="mt-3 h-2 overflow-hidden rounded-full bg-muted"><div className="h-full rounded-full bg-primary" style={{ width: `${percent}%` }} /></div>
      <div className="mt-3 grid grid-cols-4 gap-2 text-center">
        <ProgressMetric cn="待完成" en="Pending" value={Number(progress.pending || 0) + Number(progress.in_progress || 0)} language={language} />
        <ProgressMetric cn="未开放" en="Locked" value={progress.locked || 0} language={language} />
        <ProgressMetric cn="异常" en="Issues" value={progress.issue || 0} language={language} warning />
        <ProgressMetric cn="逾期" en="Overdue" value={progress.overdue || 0} language={language} warning />
      </div>
    </section>
  )
}

function ProgressMetric({ cn, en, value, language, warning = false }) {
  return <div className={`rounded-xl px-2 py-2 ${warning && value ? 'bg-rose-50 text-rose-800' : 'bg-muted/60'}`}><p className="text-lg font-bold">{value}</p><TextPair cn={cn} en={en} mode="en" className="text-[10px]" /></div>
}

function TaskCard({ task, language, onOpen, onStart }) {
  const meta = statusMeta(task)
  const Icon = String(task.config?.icon_key || '').includes('toilet') ? Bath : String(task.config?.icon_key || '').includes('opening') ? PackageCheck : ClipboardCheck
  const title = taskTitle(task)
  const instruction = taskInstruction(task)
  const canStart = task.status_key === 'pending' && task.can_start
  return (
    <article className="overflow-hidden rounded-2xl border bg-card">
      <button type="button" onClick={onOpen} className="flex w-full items-start gap-3 p-3 text-left">
        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary"><Icon className="h-5 w-5" /></span>
        <div className="min-w-0 flex-1">
          <TextPair cn={title.cn} en={title.en} mode={language} className="text-sm font-semibold leading-5" />
          <TextPair cn={instruction.cn} en={instruction.en} mode={language} className="mt-1 line-clamp-2 text-xs leading-5 text-muted-foreground" />
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${meta.className}`}><TextPair cn={meta.cn} en={meta.en} mode="en" /></span>
            <span className="text-[10px] text-muted-foreground">{task.shift_name_en || task.shift_id}</span>
            <span className="inline-flex items-center gap-1 text-[10px] text-muted-foreground"><Clock3 className="h-3 w-3" /> {timeText(task.opens_at, task.timezone)}–{timeText(task.due_at, task.timezone)}</span>
            {task.required_photo_count > 0 ? <span className="inline-flex items-center gap-1 text-[10px] text-violet-700"><Camera className="h-3 w-3" /> {task.submitted_photo_count || 0}/{task.required_photo_count}</span> : null}
          </div>
          {task.status_key === 'locked' ? <TextPair cn={task.lock_reason_cn} en={task.lock_reason_en} mode="en" className="mt-2 text-xs font-medium text-amber-700" /> : null}
        </div>
        <ChevronRight className="mt-1 h-4 w-4 shrink-0 text-muted-foreground" />
      </button>
      <div className="flex gap-2 border-t px-3 py-2">
        {canStart ? <Button size="sm" variant="outline" onClick={onStart}><Play className="mr-1 h-4 w-4" /> <span>Start Task</span></Button> : null}
        <Button size="sm" variant={canStart ? 'outline' : 'default'} onClick={onOpen}><ClipboardCheck className="mr-1 h-4 w-4" /> <span>Open Task</span></Button>
      </div>
    </article>
  )
}

function TaskDetail({ task, taskPhotos, samples, outletId, outletName, language, mediaRule, onAction, onRefresh, onError }) {
  const [responses, setResponses] = useState(() => responseMap(task))
  const [notes, setNotes] = useState(task.completion_notes || '')
  const [busy, setBusy] = useState('')
  const [outcomeMode, setOutcomeMode] = useState('')
  const [reason, setReason] = useState('')
  const [issueType, setIssueType] = useState('')
  const [sampleOpen, setSampleOpen] = useState(null)
  const inputs = useRef({})

  useEffect(() => {
    setResponses(responseMap(task))
    setNotes(task.completion_notes || '')
    setOutcomeMode('')
    setReason('')
    setIssueType('')
  }, [task.id, task.version, task.updated_date])

  const readonly = ['locked', 'completed', 'issue'].includes(task.status_key) || task.can_submit === false
  const sections = task.config?.sections || []
  const items = sections.flatMap((section) => section.items || [])
  const answered = items.filter((item) => isAnswered(item, responses[item.id])).length
  const groups = task.config?.photo_groups || []
  const issuePhotos = taskPhotos.filter((row) => String(row.photo_type || '').startsWith('issue'))

  function update(itemId, patch) {
    setResponses((current) => ({
      ...current,
      [itemId]: { item_id: itemId, value: '', remark: '', corrective_action: '', ...current[itemId], ...patch },
    }))
  }

  function payload() {
    return {
      responses: Object.values(responses).map((row) => ({
        item_id: row.item_id,
        value: row.value ?? '',
        remark: row.remark || '',
        corrective_action: row.corrective_action || '',
      })),
      completion_notes: notes,
    }
  }

  async function save(action, extra = {}) {
    setBusy(action)
    try {
      await onAction(action, { ...payload(), ...extra })
    } catch (actionError) {
      onError(actionError.message || 'Unable to submit task')
    } finally {
      setBusy('')
    }
  }

  async function capture(photoType, file, caption) {
    if (!file) return
    if (!String(file.type || '').startsWith('image/')) return onError('Only on-site photos are accepted')
    const maxBytes = Number(mediaRule.max_file_mb || 10) * 1024 * 1024
    if (Number(file.size || 0) > maxBytes) return onError(`Photo is larger than ${mediaRule.max_file_mb || 10} MB`)
    setBusy(`photo:${photoType}`)
    try {
      const stamped = await watermarkTaskPhoto(file, { capturedAt: new Date() })
      const uploaded = await opsClient.integrations.Core.UploadFile({ file: stamped.file, folderType: 'Task Checklist Photos', outletName, outletId })
      await opsClient.entities.TaskPhoto.create({
        outlet_id: outletId,
        task_id: task.id,
        template_id: task.template_id,
        photo_type: photoType,
        drive_file_id: uploaded.drive_file_id || '',
        file_name: uploaded.file_name || stamped.file.name,
        file_url: uploaded.file_url || '',
        caption,
        status: 'active',
        mime_type: uploaded.mime_type || stamped.file.type || 'image/jpeg',
        file_size: Number(uploaded.file_size || stamped.file.size || 0),
        captured_at: stamped.capturedAt,
        watermark_text: stamped.watermarkText,
      }, { year: Number(String(task.due_date).slice(0, 4)) })
      await onRefresh()
    } catch (captureError) {
      onError(captureError.message || 'Unable to upload photo')
    } finally {
      setBusy('')
      if (inputs.current[photoType]) inputs.current[photoType].value = ''
    }
  }

  async function removePhoto(row) {
    if (!window.confirm('Remove this photo?')) return
    try {
      await opsClient.entities.TaskPhoto.delete(row.id, { year: Number(String(task.due_date).slice(0, 4)) })
      await onRefresh()
    } catch (removeError) {
      onError(removeError.message || 'Unable to remove photo')
    }
  }

  const title = taskTitle(task)
  const instruction = taskInstruction(task)
  const status = statusMeta(task)

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-4 pb-8">
        <section className="rounded-2xl border bg-muted/30 p-4">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <TextPair cn={title.cn} en={title.en} mode={language} className="text-base font-bold" />
              <p className="mt-2 text-xs text-muted-foreground">{task.shift_name_en} · {timeText(task.opens_at, task.timezone)}–{timeText(task.due_at, task.timezone)} · {task.timezone}</p>
            </div>
            <span className={`shrink-0 rounded-full px-2 py-1 text-[10px] font-semibold ${status.className}`}><TextPair cn={status.cn} en={status.en} mode="en" /></span>
          </div>
          <div className="mt-3 h-2 overflow-hidden rounded-full bg-muted"><div className="h-full rounded-full bg-primary" style={{ width: `${items.length ? Math.round((answered / items.length) * 100) : 0}%` }} /></div>
          <p className="mt-1 text-right text-[10px] text-muted-foreground">{answered}/{items.length}</p>
        </section>

        <DetailBlock titleCn="操作说明" titleEn="Instruction" language={language} cn={instruction.cn} en={instruction.en} />
        {(task.display?.completion_standard_cn || task.display?.completion_standard_en) ? <DetailBlock titleCn="完成标准" titleEn="Completion Standard" language={language} cn={task.display?.completion_standard_cn} en={task.display?.completion_standard_en} /> : null}

        <section className="rounded-2xl border p-4">
          <h3 className="text-sm font-semibold"><span>Photo Requirement</span></h3>
          <p className="mt-2 text-sm"><TextPair
            cn={task.photo_requirement === 'required' ? '必须上传照片' : task.photo_requirement === 'issue_only' ? '出现异常时需要照片' : '不需要照片'}
            en={task.photo_requirement === 'required' ? 'Photo Required' : task.photo_requirement === 'issue_only' ? 'Photo Required for Issues' : 'No Photo Required'}
            mode="en"
          /></p>
          {samples.length ? (
            <div className="mt-3 grid grid-cols-2 gap-2">
              {samples.map((sample) => <SampleButton key={sample.id || sample.file_url} sample={sample} language={language} onOpen={() => setSampleOpen(sample)} />)}
            </div>
          ) : null}
        </section>

        {task.status_key === 'locked' ? <div className="rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900"><TextPair cn={task.lock_reason_cn} en={task.lock_reason_en} mode="en" /></div> : null}
        {task.status_key === 'issue' ? <OutcomeSummary task={task} language={language} /> : null}

        {sections.map((section) => (
          <section key={section.id} className="space-y-2">
            <div className="border-b pb-2"><TextPair cn={section.name_cn} en={section.name_en || section.name} mode={language} className="text-sm font-semibold" /></div>
            {(section.items || []).map((item) => (
              <TaskItem key={item.id} item={item} response={responses[item.id] || { item_id: item.id, value: '', remark: '', corrective_action: '' }} readonly={readonly} language={language} onChange={(patch) => update(item.id, patch)} />
            ))}
          </section>
        ))}

        {groups.length ? (
          <section className="space-y-3">
            <h3 className="border-b pb-2 text-sm font-semibold"><span>Task Photos</span></h3>
            {groups.map((group, index) => {
              const type = `checklist:${group.id}`
              const rows = taskPhotos.filter((row) => row.photo_type === type)
              const requirement = task.photo_requirements?.find((row) => String(row.id) === String(group.id))
              return (
                <PhotoGroup
                  key={group.id}
                  number={`${index + 1}/${groups.length}`}
                  group={group}
                  rows={rows}
                  required={Boolean(requirement?.required)}
                  minPhotos={Number(group.min_photos || 1)}
                  readonly={readonly}
                  language={language}
                  busy={busy === `photo:${type}`}
                  inputRef={(node) => {
                    inputs.current[type] = node
                  }}
                  onOpenCamera={() => inputs.current[type]?.click()}
                  onCapture={(file) => capture(
                    type,
                    file,
                    group.name_en || group.name,
                  )}
                  onRemove={removePhoto}
                />
              )
            })}
          </section>
        ) : null}

        {!readonly ? (
          <section className="space-y-2 rounded-2xl border border-rose-200 bg-rose-50/40 p-4">
            <h3 className="text-sm font-semibold text-rose-900"><span>Issue Photo</span></h3>
            <p className="text-xs leading-5 text-rose-800"><span>At least one on-site photo is required when reporting an issue.</span></p>
            {issuePhotos.length ? <div className="grid grid-cols-2 gap-2">{issuePhotos.map((row) => <PhotoTile key={row.id} row={row} onRemove={() => removePhoto(row)} />)}</div> : null}
            <Button type="button" size="sm" variant="outline" onClick={() => inputs.current.issue?.click()} disabled={busy === 'photo:issue'}>
              {busy === 'photo:issue' ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Camera className="mr-1 h-4 w-4" />} <span>Take Issue Photo</span>
            </Button>
            <input ref={(node) => { inputs.current.issue = node }} className="hidden" type="file" accept="image/*" capture="environment" onChange={(event) => capture(`issue:${issueType || 'general'}`, event.target.files?.[0], 'Task issue evidence')} />
          </section>
        ) : null}

        {!readonly ? (
          <div className="space-y-1.5"><Label><span>Completion Notes</span></Label><Textarea value={notes} onChange={(event) => setNotes(event.target.value)} rows={3} /></div>
        ) : null}

        {outcomeMode ? (
          <OutcomeForm mode={outcomeMode} issueType={issueType} setIssueType={setIssueType} reason={reason} setReason={setReason} language={language} issuePhotoCount={issuePhotos.length} busy={busy} onCancel={() => setOutcomeMode('')} onSubmit={() => save(outcomeMode === 'issue' ? 'report_issue' : 'unable', { issue_type: issueType, reason })} />
        ) : null}
      </div>

      {!readonly && !outcomeMode ? (
        <div className="space-y-2 border-t bg-background p-4 pb-[calc(1rem+env(safe-area-inset-bottom))]">
          <div className="grid grid-cols-2 gap-2">
            <Button variant="outline" disabled={Boolean(busy)} onClick={() => save('save')}>{busy === 'save' ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Save className="mr-1 h-4 w-4" />} <span>Save Progress</span></Button>
            <Button disabled={Boolean(busy)} onClick={() => save('complete')}>{busy === 'complete' ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Check className="mr-1 h-4 w-4" />} <span>Complete</span></Button>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <Button variant="outline" className="border-rose-300 text-rose-700" disabled={Boolean(busy)} onClick={() => setOutcomeMode('issue')}><AlertTriangle className="mr-1 h-4 w-4" /> <span>Report Issue</span></Button>
            <Button variant="outline" disabled={Boolean(busy)} onClick={() => setOutcomeMode('unable')}><XCircle className="mr-1 h-4 w-4" /> <span>Unable</span></Button>
          </div>
        </div>
      ) : null}

      <MediaLightbox open={Boolean(sampleOpen)} onOpenChange={(open) => !open && setSampleOpen(null)} src={sampleOpen ? photoUrl(sampleOpen) : ''} title={sampleOpen?.caption || 'Sample photo'} type="image" />
    </div>
  )
}

function DetailBlock({ titleCn, titleEn, language, cn, en }) {
  if (!cn && !en) return null
  return <section className="rounded-2xl border p-4"><h3 className="text-sm font-semibold"><TextPair cn={titleCn} en={titleEn} mode="en" /></h3><TextPair cn={cn} en={en} mode={language} className="mt-2 whitespace-pre-line text-sm leading-6" /></section>
}

function OutcomeSummary({ task, language }) {
  const type = ISSUE_TYPES.find((row) => row.value === task.issue_type)
  return <div className="rounded-2xl border border-rose-300 bg-rose-50 p-4 text-rose-900"><p className="font-semibold">{task.outcome === 'unable' ? 'Unable to Complete' : 'Issue Reported'}</p>{type ? <p className="mt-2 text-sm">{type.en}</p> : null}<p className="mt-2 whitespace-pre-line text-sm">{task.issue_reason}</p></div>
}

function TaskItem({ item, response, readonly, language, onChange }) {
  const type = String(item.response_type || 'STATUS').toUpperCase()
  const isFail = (item.fail_values || []).map(String).includes(String(response.value || ''))
  return (
    <div className={`rounded-2xl border p-3 ${isFail ? 'border-rose-300 bg-rose-50/50' : 'bg-card'}`}>
      <TextPair cn={item.name_cn} en={item.name_en || item.name} mode={language} className="text-sm font-semibold leading-5" />
      <TextPair cn={item.instruction_cn} en={item.instruction_en || item.instruction} mode={language} className="mt-1 text-xs leading-5 text-muted-foreground" />
      {(item.completion_standard_cn || item.completion_standard_en) ? <TextPair cn={item.completion_standard_cn} en={item.completion_standard_en} mode={language} className="mt-2 rounded-lg bg-muted/60 p-2 text-xs leading-5" /> : null}

      <div className="mt-3">
        {['CHECKBOX', 'STEP', 'BOOLEAN'].includes(type) ? (
          <button type="button" disabled={readonly} onClick={() => onChange({ value: response.value ? '' : 'Done' })} className={`flex w-full items-center gap-3 rounded-xl border p-3 text-left ${response.value ? 'border-emerald-400 bg-emerald-50' : 'bg-background'}`}><span className={`flex h-6 w-6 items-center justify-center rounded-md border ${response.value ? 'border-emerald-600 bg-emerald-600 text-white' : ''}`}>{response.value ? <Check className="h-4 w-4" /> : null}</span><span>Step completed</span></button>
        ) : type === 'TEMPERATURE' || type === 'QUANTITY' ? (
          <div className="space-y-2"><div className="flex items-center gap-2"><Input type="number" step={type === 'TEMPERATURE' ? '0.1' : 'any'} value={response.value ?? ''} disabled={readonly} onChange={(event) => onChange({ value: event.target.value })} placeholder={type === 'TEMPERATURE' ? 'Actual temperature' : 'Actual quantity'} /><span className="text-sm text-muted-foreground">{item.unit || ''}</span></div>{(item.options || []).length ? <OptionGrid options={item.options} value={response.remark} readonly={readonly} onSelect={(value) => onChange({ remark: value })} /> : null}</div>
        ) : (
          <OptionGrid options={item.options || []} value={response.value} readonly={readonly} onSelect={(value) => onChange({ value })} />
        )}
      </div>

      {!['QUANTITY'].includes(type) ? <Input className="mt-2" value={response.remark || ''} disabled={readonly} onChange={(event) => onChange({ remark: event.target.value })} placeholder="Remark" /> : null}
      {isFail ? <Textarea className="mt-2" value={response.corrective_action || ''} disabled={readonly} onChange={(event) => onChange({ corrective_action: event.target.value })} placeholder="Corrective action" rows={2} /> : null}
    </div>
  )
}

function OptionGrid({ options, value, readonly, onSelect }) {
  const columns = Math.min(Math.max((options || []).length, 2), 3)
  return <div className={`grid gap-2 ${columns === 2 ? 'grid-cols-2' : 'grid-cols-3'}`}>{(options || []).map((option) => <button key={option} type="button" disabled={readonly} onClick={() => onSelect(option)} className={`rounded-xl border px-2 py-2 text-xs font-medium ${String(value) === String(option) ? 'border-primary bg-primary/15' : 'bg-background text-muted-foreground'} disabled:opacity-60`}>{option}</button>)}</div>
}

function PhotoGroup({
  number,
  group,
  rows,
  required,
  minPhotos,
  readonly,
  language,
  busy,
  inputRef,
  onOpenCamera,
  onCapture,
  onRemove,
}) {
  return (
    <div className="rounded-2xl border p-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-semibold">
            <span className="mr-1 text-muted-foreground">{number}</span>
            <TextPair
              cn={group.name_cn}
              en={group.name_en || group.name}
              mode={language}
            />
          </p>

          <TextPair
            cn={group.sample_caption_cn}
            en={group.sample_caption_en || group.sample_caption}
            mode={language}
            className="mt-1 text-xs leading-5 text-muted-foreground"
          />
        </div>

        <span
          className={`shrink-0 rounded-full px-2 py-1 text-[10px] font-semibold ${
            required
              ? 'bg-violet-100 text-violet-800'
              : 'bg-muted text-muted-foreground'
          }`}
        >
          {required ? `${rows.length}/${minPhotos} Required` : `${rows.length}`}
        </span>
      </div>

      {rows.length ? (
        <div className="mt-3 grid grid-cols-2 gap-2">
          {rows.map((row) => (
            <PhotoTile
              key={row.id}
              row={row}
              onRemove={!readonly ? () => onRemove(row) : null}
            />
          ))}
        </div>
      ) : null}

      {!readonly ? (
        <>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="mt-3"
            disabled={busy}
            onClick={onOpenCamera}
          >
            {busy ? (
              <Loader2 className="mr-1 h-4 w-4 animate-spin" />
            ) : (
              <Camera className="mr-1 h-4 w-4" />
            )}
            <span>
              {rows.length ? 'Retake / Add Photo' : 'Take Photo'}
            </span>
          </Button>

          <input
            ref={inputRef}
            className="hidden"
            type="file"
            accept="image/*"
            capture="environment"
            onChange={(event) => onCapture(event.target.files?.[0])}
          />
        </>
      ) : null}
    </div>
  )
}

function SampleButton({ sample, language, onOpen }) {
  const url = photoUrl(sample)
  return <button type="button" onClick={onOpen} className="overflow-hidden rounded-xl border bg-muted text-left">{url ? <img src={url} alt={sample.caption || 'Sample'} className="h-28 w-full object-cover" /> : <div className="flex h-28 items-center justify-center"><FileImage className="h-8 w-8 text-muted-foreground" /></div>}<div className="p-2"><TextPair cn={sample.caption_cn || '查看标准照片'} en={sample.caption_en || sample.caption || 'View Sample Photo'} mode={language} className="text-[11px] font-medium" /></div></button>
}

function PhotoTile({ row, onRemove }) {
  const [open, setOpen] = useState(false)
  const url = photoUrl(row)
  return <><div className="relative overflow-hidden rounded-xl border bg-muted"><button type="button" onClick={() => setOpen(true)} className="block w-full">{url ? <img src={url} alt={row.caption || 'Task photo'} className="h-32 w-full object-cover" /> : <div className="flex h-32 items-center justify-center"><FileImage className="h-8 w-8 text-muted-foreground" /></div>}</button>{onRemove ? <button type="button" onClick={onRemove} className="absolute right-2 top-2 flex h-8 w-8 items-center justify-center rounded-full bg-black/70 text-white"><Trash2 className="h-4 w-4" /></button> : null}</div><MediaLightbox open={open} onOpenChange={setOpen} src={url} title={row.caption || row.file_name || 'Task photo'} type="image" /></>
}

function OutcomeForm({ mode, issueType, setIssueType, reason, setReason, language, issuePhotoCount, busy, onCancel, onSubmit }) {
  const issue = mode === 'issue'
  const disabled = Boolean(busy) || reason.trim().length < 3 || (issue && (!issueType || issuePhotoCount < 1))
  return <section className="space-y-3 rounded-2xl border border-rose-300 bg-rose-50 p-4"><h3 className="font-semibold text-rose-900">{issue ? 'Report Issue' : 'Unable to Complete'}</h3>{issue ? <div><Label>Issue Type</Label><select value={issueType} onChange={(event) => setIssueType(event.target.value)} className="mt-1 h-11 w-full rounded-xl border border-input bg-background px-3 text-sm"><option value="">Select</option>{ISSUE_TYPES.map((type) => <option key={type.value} value={type.value}>{type.en}</option>)}</select></div> : null}<div><Label>Reason</Label><Textarea className="mt-1 bg-background" value={reason} onChange={(event) => setReason(event.target.value)} rows={4} placeholder="Required" /></div>{issue ? <p className={`text-xs ${issuePhotoCount ? 'text-emerald-700' : 'text-rose-700'}`}>{issuePhotoCount ? `✓ ${issuePhotoCount} issue photo uploaded` : 'Issue photo required'}</p> : <p className="text-xs text-rose-800">Leader or Manager will be notified automatically. This task will not count as completed.</p>}<div className="grid grid-cols-2 gap-2"><Button variant="outline" onClick={onCancel} disabled={Boolean(busy)}>Cancel</Button><Button onClick={onSubmit} disabled={disabled}>{busy ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <AlertTriangle className="mr-1 h-4 w-4" />} Submit</Button></div></section>
}
