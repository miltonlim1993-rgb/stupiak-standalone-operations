import { useEffect, useMemo, useRef, useState } from 'react'
import { opsClient } from '@/api/opsClient'
import { useAuth } from '@/lib/AuthContext'
import { outletLabel, parseOutletIds } from '@/lib/outlets'
import { todayStr, formatDate } from '@/lib/ops-helpers'
import {
  AlertTriangle,
  Bath,
  CalendarCheck2,
  Camera,
  CheckCircle2,
  ChefHat,
  ChevronRight,
  ClipboardCheck,
  Clock,
  FileImage,
  Loader2,
  Lock,
  Moon,
  PackageCheck,
  Play,
  RefreshCw,
  Save,
  ShieldCheck,
  Sparkles,
  Sunrise,
  Thermometer,
  Trash2,
  Wrench,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import AppDrawer from '@/components/AppDrawer'
import MediaLightbox from '@/components/MediaLightbox'
import PageNotifications from '@/components/PageNotifications'
import { createMediaDraftId, listMediaDrafts, removeMediaDraft, saveMediaDraft } from '@/lib/media-drafts'
import { resolveMediaRule } from '@/lib/media-rules'
import { watermarkTaskPhoto } from '@/lib/watermark-image'

const FILTERS = [
  { value: 'all', label: 'All' },
  { value: 'open', label: 'Open' },
  { value: 'in_progress', label: 'In progress' },
  { value: 'done', label: 'Done' },
  { value: 'missed', label: 'Missed' },
]

const SHIFT_ORDER = ['MORNING', 'DAILY', 'NIGHT']
const CACHE_VERSION = 'v2.9.0'

const TASK_VISUALS = {
  'kitchen-opening': ChefHat,
  'toilet-cleaning': Bath,
  'outlet-standards': ShieldCheck,
}

const SECTION_VISUALS = {
  thermometer: Thermometer,
  package: PackageCheck,
  sparkles: Sparkles,
  wrench: Wrench,
}

function cacheKey(outletId, date) {
  return `chefops.operational-tasks.${CACHE_VERSION}:${String(outletId || '')}:${String(date || '')}`
}

function readCache(outletId, date) {
  try {
    const parsed = JSON.parse(localStorage.getItem(cacheKey(outletId, date)) || 'null')
    return parsed?.data ? parsed : null
  } catch {
    return null
  }
}

function writeCache(outletId, date, data) {
  try {
    localStorage.setItem(cacheKey(outletId, date), JSON.stringify({ savedAt: Date.now(), data }))
  } catch {}
}

function accessLabel(value) {
  const state = String(value || '').toUpperCase()
  if (state === 'NOT_OPEN') return 'Not open'
  if (state === 'OVERDUE') return 'Overdue'
  if (state === 'LOCKED') return 'Missed / locked'
  if (state === 'DONE') return 'Done'
  return 'Open'
}

function accessClass(value) {
  const state = String(value || '').toUpperCase()
  if (state === 'OPEN') return 'bg-emerald-100 text-emerald-800'
  if (state === 'OVERDUE') return 'bg-amber-100 text-amber-800'
  if (state === 'DONE') return 'bg-sky-100 text-sky-800'
  if (state === 'LOCKED') return 'bg-rose-100 text-rose-800'
  return 'bg-muted text-muted-foreground'
}

function shiftMeta(shiftId) {
  const value = String(shiftId || '').toUpperCase()
  if (value === 'MORNING') return { label: 'Morning', Icon: Sunrise }
  if (value === 'NIGHT') return { label: 'Night', Icon: Moon }
  if (value === 'DAILY') return { label: 'Daily', Icon: CalendarCheck2 }
  return { label: value || 'Tasks', Icon: Clock }
}

function statusMatches(task, filter) {
  if (filter === 'all') return true
  if (filter === 'done') return String(task.status || '').toLowerCase() === 'done'
  if (filter === 'in_progress') return String(task.status || '').toLowerCase() === 'in_progress'
  if (filter === 'missed') return String(task.access_state || '').toUpperCase() === 'LOCKED'
  if (filter === 'open') return ['OPEN', 'OVERDUE'].includes(String(task.access_state || '').toUpperCase())
    && String(task.status || '').toLowerCase() !== 'done'
  return true
}

function timeText(iso) {
  if (!iso) return ''
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  return new Intl.DateTimeFormat('en-MY', {
    timeZone: 'Asia/Kuala_Lumpur',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
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

function currentResponseMap(task) {
  return Object.fromEntries((task?.responses || []).map((row) => [String(row.item_id), { ...row }]))
}

function itemResult(item, response) {
  const raw = response?.value
  if (raw === '' || raw === null || raw === undefined) return 'incomplete'
  if (String(raw).toUpperCase() === 'N/A') return item.allow_na ? 'na' : 'fail'
  if (String(item.response_type || '').toUpperCase() === 'TEMPERATURE') {
    const value = Number(raw)
    if (!Number.isFinite(value)) return 'fail'
    if (item.min_value !== undefined && item.min_value !== null && value < Number(item.min_value)) return 'fail'
    if (item.max_value !== undefined && item.max_value !== null && value > Number(item.max_value)) return 'fail'
    return 'pass'
  }
  const failValues = (item.fail_values || []).map(String)
  return failValues.includes(String(raw)) ? 'fail' : 'pass'
}

function groupRequired(group, task, responses) {
  if (group.required === true) return true
  const rule = String(group.rule || '').toUpperCase()
  if (rule === 'REQUIRED') return true
  const items = (task.config?.sections || []).flatMap((section) => section.items || [])
    .filter((item) => String(item.photo_group_id || '') === String(group.id || ''))
  if (rule === 'ON_FAIL') return items.some((item) => itemResult(item, responses[item.id]) === 'fail')
  if (rule === 'REQUIRED_IF_APPLICABLE') {
    return items.some((item) => {
      const value = responses[item.id]?.value
      return value !== undefined && value !== '' && String(value).toUpperCase() !== 'N/A'
    })
  }
  if (rule === 'REQUIRED_DAY') {
    const dayCodes = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA']
    const selected = new Date(`${task.due_date}T00:00:00Z`)
    return (group.required_days || []).includes(dayCodes[selected.getUTCDay()])
  }
  return false
}

export default function Tasks() {
  const { user } = useAuth()
  const assignedOutletIds = parseOutletIds(user)
  const [outlets, setOutlets] = useState([])
  const [selectedOutletId, setSelectedOutletId] = useState(() => {
    const primary = String(user?.outlet_id || '')
    return assignedOutletIds.includes(primary) ? primary : assignedOutletIds[0] || ''
  })
  const [selectedDate, setSelectedDate] = useState(todayStr())
  const [data, setData] = useState({
    tasks: [],
    task_photos: [],
    template_photos: [],
    server_time: new Date().toISOString(),
    source_control: 'SHEET',
  })
  const [filter, setFilter] = useState('all')
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState('')
  const [selectedTaskId, setSelectedTaskId] = useState('')
  const [mediaRules, setMediaRules] = useState([])

  useEffect(() => {
    opsClient.entities.Outlet.list('name', 100)
      .then((rows) => {
        const visible = (rows || []).filter((row) => assignedOutletIds.includes(String(row.id)))
        setOutlets(visible)
        setSelectedOutletId((current) => visible.some((row) => String(row.id) === String(current))
          ? current
          : visible[0]?.id || '')
      })
      .catch(() => setOutlets([]))
  }, [user?.outlet_id, user?.outlet_ids])

  useEffect(() => {
    if (selectedOutletId) loadData()
  }, [selectedOutletId, selectedDate])

  useEffect(() => {
    opsClient.entities.MediaRule.filter({ module: 'task' }, 'outlet_id', 50)
      .then(setMediaRules)
      .catch(() => setMediaRules([]))
  }, [selectedOutletId])

  async function loadData({ force = false, quiet = false } = {}) {
    const cached = !force ? readCache(selectedOutletId, selectedDate) : null
    if (cached && !quiet) {
      setData(cached.data)
      setLoading(false)
    } else if (!quiet) {
      setLoading(true)
    }

    setRefreshing(true)
    setError('')
    try {
      const next = await opsClient.tasks.operationalBootstrap({
        outletId: selectedOutletId,
        date: selectedDate,
        refresh: force,
      })
      setData(next)
      writeCache(selectedOutletId, selectedDate, next)
      setSelectedTaskId((current) => current && next.tasks.some((task) => String(task.id) === String(current)) ? current : '')
    } catch (err) {
      if (!cached) setError(err.message || 'Unable to load operational tasks')
    } finally {
      setRefreshing(false)
      if (!quiet) setLoading(false)
    }
  }

  async function runAction(taskId, action, payload = {}) {
    setError('')
    const result = await opsClient.tasks.operationalAction({
      task_id: taskId,
      outlet_id: selectedOutletId,
      date: selectedDate,
      action,
      ...payload,
    })
    setData((current) => {
      const next = {
        ...current,
        tasks: current.tasks.map((task) => String(task.id) === String(result.task.id) ? result.task : task),
        server_time: result.server_time || current.server_time,
      }
      writeCache(selectedOutletId, selectedDate, next)
      return next
    })
    return result.task
  }

  const selectedOutlet = outlets.find((row) => String(row.id) === String(selectedOutletId))
  const filtered = data.tasks.filter((task) => statusMatches(task, filter))
  const grouped = useMemo(() => SHIFT_ORDER.map((shiftId) => ({
    shiftId,
    tasks: filtered.filter((task) => String(task.config?.schedule?.shift_id || '').toUpperCase() === shiftId),
  })).filter((group) => group.tasks.length), [filtered])
  const selectedTask = data.tasks.find((task) => String(task.id) === String(selectedTaskId))

  return (
    <div className="chefops-page tasks-page mx-auto max-w-lg space-y-4 p-4 pb-24">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h1 className="text-xl font-heading font-bold">Tasks</h1>
            <span className="rounded-full bg-muted px-2 py-1 text-[10px] font-medium text-muted-foreground">Sheet controlled</span>
          </div>
          <p className="truncate text-xs text-muted-foreground">{outletLabel(selectedOutlet, selectedOutletId)}</p>
        </div>
        <Button size="icon" variant="outline" onClick={() => loadData({ force: true })} disabled={refreshing}>
          <RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} />
        </Button>
      </div>

      <PageNotifications page="/tasks" limit={2} />

      <div className="chefops-sticky-tools chefops-tasks-toolbar space-y-2.5">
        {outlets.length > 1 && (
          <select
            className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
            value={selectedOutletId}
            onChange={(event) => setSelectedOutletId(event.target.value)}
          >
            {outlets.map((outlet) => <option key={outlet.id} value={outlet.id}>{outletLabel(outlet, outlet.id)}</option>)}
          </select>
        )}

        <Input type="date" value={selectedDate} onChange={(event) => setSelectedDate(event.target.value)} />

        <div className="chefops-hide-scrollbar flex gap-2 overflow-x-auto pb-0.5">
          {FILTERS.map(({ value, label }) => (
            <button
              key={value}
              type="button"
              onClick={() => setFilter(value)}
              className={`whitespace-nowrap rounded-full px-3 py-1.5 text-xs font-medium ${filter === value ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground'}`}
            >
              {label}
              {value !== 'all' && <span className="ml-1 opacity-70">({data.tasks.filter((task) => statusMatches(task, value)).length})</span>}
            </button>
          ))}
        </div>
      </div>

      {error && <div className="rounded-xl border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</div>}

      {loading ? (
        <div className="flex justify-center py-12"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
      ) : grouped.length === 0 ? (
        <div className="rounded-2xl border border-dashed px-4 py-12 text-center">
          <ClipboardCheck className="mx-auto mb-3 h-10 w-10 text-muted-foreground" />
          <p className="text-sm font-medium">No operational tasks for this date</p>
          <p className="mt-1 text-xs text-muted-foreground">Recurring checklists are controlled from TaskTemplates in the Master Sheet.</p>
        </div>
      ) : (
        <div className="space-y-5">
          {grouped.map(({ shiftId, tasks }) => {
            const { label, Icon } = shiftMeta(shiftId)
            return (
              <section key={shiftId} className="space-y-2">
                <div className="flex items-center gap-2 border-b pb-2">
                  <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-primary/15"><Icon className="h-4 w-4 text-primary" /></span>
                  <div>
                    <h2 className="text-sm font-semibold">{label}</h2>
                    <p className="text-[11px] text-muted-foreground">{tasks.length} checklist{tasks.length === 1 ? '' : 's'}</p>
                  </div>
                </div>
                <div className="space-y-2">
                  {tasks.map((task) => (
                    <TaskCard
                      key={task.id}
                      task={task}
                      onOpen={() => setSelectedTaskId(task.id)}
                      onStart={() => runAction(task.id, 'start').catch((err) => setError(err.message))}
                    />
                  ))}
                </div>
              </section>
            )
          })}
        </div>
      )}

      <AppDrawer
        open={Boolean(selectedTask)}
        onOpenChange={(open) => !open && setSelectedTaskId('')}
        title={selectedTask?.title || 'Checklist'}
        subtitle={selectedTask ? `${selectedTask.config?.schedule?.shift_name || ''} · ${formatDate(selectedTask.due_date)}` : ''}
        heightClass="h-[94dvh]"
      >
        {selectedTask && (
          <ChecklistForm
            task={selectedTask}
            outletId={selectedOutletId}
            outletName={outletLabel(selectedOutlet, selectedOutletId)}
            taskPhotos={photosForTask(data.task_photos, selectedTask.id)}
            mediaRule={resolveMediaRule(mediaRules, 'task', selectedOutletId)}
            samples={samplesForTemplate(data.template_photos, selectedTask.template_id, selectedOutletId)}
            onAction={async (action, payload) => {
              const updated = await runAction(selectedTask.id, action, payload)
              setSelectedTaskId(updated.id)
            }}
            onPhotosChanged={() => loadData({ quiet: true, force: true })}
            onError={(message) => setError(message)}
          />
        )}
      </AppDrawer>
    </div>
  )
}

function TaskCard({ task, onOpen, onStart }) {
  const TaskIcon = TASK_VISUALS[task.config?.icon_key] || ClipboardCheck
  const locked = ['NOT_OPEN', 'LOCKED', 'DONE'].includes(String(task.access_state || '').toUpperCase())
  const canStart = String(task.status || '').toLowerCase() === 'pending' && !locked
  return (
    <article className="overflow-hidden rounded-2xl border bg-card">
      <button type="button" onClick={onOpen} className="flex w-full items-start gap-3 p-3 text-left">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-muted"><TaskIcon className="h-5 w-5" /></span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold">{task.title}</p>
          <p className="mt-0.5 truncate text-xs text-muted-foreground">{task.station || task.description}</p>
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${accessClass(task.access_state)}`}>{accessLabel(task.access_state)}</span>
            <span className="inline-flex items-center gap-1 text-[10px] text-muted-foreground">
              <Clock className="h-3 w-3" /> {timeText(task.opens_at)}–{timeText(task.due_at)}
            </span>
            <span className="text-[10px] text-muted-foreground">{task.checklist_completed || 0}/{task.checklist_total || 0}</span>
            {(task.required_photo_count || 0) > 0 && <span className="inline-flex items-center gap-1 text-[10px] text-violet-700"><Camera className="h-3 w-3" /> {task.submitted_photo_count || 0}/{task.required_photo_count}</span>}
          </div>
        </div>
        <ChevronRight className="mt-1 h-4 w-4 shrink-0 text-muted-foreground" />
      </button>
      <div className="flex gap-2 border-t px-3 py-2">
        {canStart && <Button size="sm" variant="outline" onClick={onStart}><Play className="mr-1 h-4 w-4" /> Start</Button>}
        <Button size="sm" variant={canStart ? 'outline' : 'default'} onClick={onOpen}>
          {String(task.access_state).toUpperCase() === 'LOCKED' ? <Lock className="mr-1 h-4 w-4" /> : <ClipboardCheck className="mr-1 h-4 w-4" />}
          {String(task.access_state).toUpperCase() === 'LOCKED' ? 'View checklist' : 'Open checklist'}
        </Button>
      </div>
    </article>
  )
}

function ChecklistForm({ task, outletId, outletName, taskPhotos, mediaRule, samples, onAction, onPhotosChanged, onError }) {
  const [responses, setResponses] = useState(() => currentResponseMap(task))
  const [completionNotes, setCompletionNotes] = useState(task.completion_notes || '')
  const [saving, setSaving] = useState(false)
  const [uploadingDraftIds, setUploadingDraftIds] = useState([])
  const [pendingDrafts, setPendingDrafts] = useState([])
  const fileInputs = useRef({})
  const draftScopeKey = String(task.id)

  useEffect(() => {
    setResponses(currentResponseMap(task))
    setCompletionNotes(task.completion_notes || '')
  }, [task.id, task.updated_date, task.version])

  useEffect(() => {
    let cancelled = false
    listMediaDrafts({ module: 'task', scopeKey: draftScopeKey })
      .then((rows) => { if (!cancelled) setPendingDrafts(rows) })
      .catch(() => undefined)
    return () => { cancelled = true }
  }, [draftScopeKey])

  const readonly = ['NOT_OPEN', 'LOCKED', 'DONE'].includes(String(task.access_state || '').toUpperCase())
  const sections = task.config?.sections || []
  const groups = task.config?.photo_groups || []
  const allItems = sections.flatMap((section) => section.items || [])
  const completed = allItems.filter((item) => itemResult(item, responses[item.id]) !== 'incomplete').length

  function updateResponse(itemId, patch) {
    setResponses((current) => ({
      ...current,
      [itemId]: {
        item_id: itemId,
        value: '',
        remark: '',
        corrective_action: '',
        ...current[itemId],
        ...patch,
      },
    }))
  }

  function responseArray() {
    return Object.values(responses).map((row) => ({
      item_id: row.item_id,
      value: row.value ?? '',
      remark: row.remark || '',
      corrective_action: row.corrective_action || '',
    }))
  }

  async function save(action) {
    setSaving(true)
    try {
      await onAction(action, {
        responses: responseArray(),
        completion_notes: completionNotes,
      })
    } catch (err) {
      onError(err.message || `Unable to ${action} checklist`)
    } finally {
      setSaving(false)
    }
  }

  function groupLimit(group) {
    return Math.max(1, Math.min(Number(group.max_photos || mediaRule.max_files || 1), Number(mediaRule.max_files || group.max_photos || 1)))
  }

  function pendingForGroup(groupId) {
    return pendingDrafts.filter((draft) => String(draft.meta?.group_id || '') === String(groupId))
  }

  async function uploadDraft(draft, group) {
    if (!draft?.file || uploadingDraftIds.includes(draft.id)) return
    setUploadingDraftIds((current) => [...current, draft.id])
    try {
      const uploaded = draft.meta?.uploaded || await opsClient.integrations.Core.UploadFile({
        file: draft.file,
        folderType: 'Task Checklist Photos',
        outletName,
        outletId,
      })
      if (!draft.meta?.uploaded) {
        await saveMediaDraft({
          ...draft,
          scopeKey: draftScopeKey,
          meta: { ...draft.meta, uploaded },
        })
      }
      await opsClient.entities.TaskPhoto.create({
        outlet_id: outletId,
        task_id: task.id,
        template_id: task.template_id,
        photo_type: `checklist:${group.id}`,
        drive_file_id: uploaded.drive_file_id || '',
        file_name: uploaded.file_name || draft.file.name,
        file_url: uploaded.file_url || '',
        caption: group.name,
        status: 'active',
        mime_type: uploaded.mime_type || draft.file.type || 'image/jpeg',
        file_size: Number(uploaded.file_size || draft.file.size || 0),
        captured_at: draft.meta?.captured_at || '',
        watermark_text: draft.meta?.watermark_text || '',
        draft_id: draft.id,
      }, { year: Number(String(task.due_date).slice(0, 4)) })
      await removeMediaDraft(draft.id)
      setPendingDrafts((current) => current.filter((row) => row.id !== draft.id))
      await onPhotosChanged()
    } catch (err) {
      onError(`${err.message || 'Unable to upload photo'}. The photo is still saved on this device.`)
      const rows = await listMediaDrafts({ module: 'task', scopeKey: draftScopeKey }).catch(() => [])
      setPendingDrafts(rows)
    } finally {
      setUploadingDraftIds((current) => current.filter((id) => id !== draft.id))
    }
  }

  async function captureGroup(group, sourceFile) {
    if (!sourceFile) return
    const uploadedRows = taskPhotos.filter((row) => row.photo_type === `checklist:${group.id}`)
    const localRows = pendingForGroup(group.id)
    const limit = groupLimit(group)
    if (uploadedRows.length + localRows.length >= limit) {
      onError(`${group.name} allows a maximum of ${limit} photo${limit === 1 ? '' : 's'}`)
      return
    }
    if (!String(sourceFile.type || '').startsWith('image/')) {
      onError('Task evidence only accepts an on-site photo')
      return
    }
    const maxBytes = Number(mediaRule.max_file_mb || 10) * 1024 * 1024
    if (Number(sourceFile.size || 0) > maxBytes) {
      onError(`${sourceFile.name || 'Photo'} is larger than ${mediaRule.max_file_mb || 10} MB`)
      return
    }

    try {
      const stamped = await watermarkTaskPhoto(sourceFile, { capturedAt: new Date() })
      const id = createMediaDraftId('task-photo')
      const draft = await saveMediaDraft({
        id,
        module: 'task',
        scopeKey: draftScopeKey,
        file: stamped.file,
        meta: {
          group_id: group.id,
          group_name: group.name,
          captured_at: stamped.capturedAt,
          watermark_text: stamped.watermarkText,
        },
      })
      setPendingDrafts((current) => [...current, draft])
      await uploadDraft(draft, group)
    } catch (err) {
      onError(err.message || 'Unable to prepare the captured photo')
    } finally {
      if (fileInputs.current[group.id]) fileInputs.current[group.id].value = ''
    }
  }

  async function deleteUploadedPhoto(row) {
    if (!row?.id || !window.confirm('Delete this task photo?')) return
    try {
      await opsClient.entities.TaskPhoto.delete(row.id, { year: Number(String(task.due_date).slice(0, 4)) })
      await onPhotosChanged()
    } catch (err) {
      onError(err.message || 'Unable to delete photo')
    }
  }

  async function deletePendingPhoto(draft) {
    if (!window.confirm('Delete this saved photo draft?')) return
    await removeMediaDraft(draft.id).catch(() => undefined)
    setPendingDrafts((current) => current.filter((row) => row.id !== draft.id))
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-4 pb-6">
        <div className="rounded-2xl border bg-muted/30 p-3">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-sm font-semibold">{task.config?.schedule?.shift_name}</p>
              <p className="mt-1 text-xs text-muted-foreground">
                Open {timeText(task.opens_at)} · Due {timeText(task.due_at)} · Lock {timeText(task.locks_at)}
              </p>
            </div>
            <span className={`rounded-full px-2 py-1 text-[10px] font-medium ${accessClass(task.access_state)}`}>{accessLabel(task.access_state)}</span>
          </div>
          <div className="mt-3 h-2 overflow-hidden rounded-full bg-muted">
            <div className="h-full bg-primary" style={{ width: `${allItems.length ? Math.round((completed / allItems.length) * 100) : 0}%` }} />
          </div>
          <p className="mt-1 text-right text-[10px] text-muted-foreground">{completed}/{allItems.length} completed</p>
        </div>

        {samples.length > 0 && (
          <section className="space-y-2">
            <h3 className="text-sm font-semibold">Sample standard</h3>
            <div className="grid grid-cols-2 gap-2">
              {samples.map((row) => <PhotoTile key={row.id || row.file_url} row={row} />)}
            </div>
          </section>
        )}

        {readonly && String(task.access_state).toUpperCase() !== 'DONE' && (
          <div className="flex gap-2 rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            This checklist is read-only because it is not open or has passed its final lock time.
          </div>
        )}

        {sections.map((section) => {
          const SectionIcon = SECTION_VISUALS[section.icon_key] || ClipboardCheck
          return (
            <section key={section.id} className="space-y-2">
              <div className="flex items-center gap-2 border-b pb-2">
                <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-primary/15"><SectionIcon className="h-4 w-4 text-primary" /></span>
                <h3 className="text-sm font-semibold">{section.name}</h3>
              </div>
              <div className="space-y-2">
                {(section.items || []).map((item) => (
                  <ChecklistItem
                    key={item.id}
                    item={item}
                    response={responses[item.id] || { item_id: item.id, value: '', remark: '', corrective_action: '' }}
                    readonly={readonly}
                    onChange={(patch) => updateResponse(item.id, patch)}
                  />
                ))}
              </div>
            </section>
          )
        })}

        <section className="space-y-2">
          <div className="flex items-center gap-2 border-b pb-2">
            <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-violet-100 text-violet-700"><Camera className="h-4 w-4" /></span>
            <div>
              <h3 className="text-sm font-semibold">Photo evidence</h3>
              <p className="text-[11px] text-muted-foreground">On-site camera only · date/time watermark · limits controlled by Sheet.</p>
            </div>
          </div>

          {groups.map((group) => {
            const required = groupRequired(group, task, responses)
            const rows = taskPhotos.filter((row) => row.photo_type === `checklist:${group.id}`)
            const drafts = pendingForGroup(group.id)
            const limit = groupLimit(group)
            return (
              <div key={group.id} className="rounded-2xl border p-3">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-sm font-semibold">{group.name}</p>
                    <p className="mt-1 text-xs leading-5 text-muted-foreground">{group.sample_caption}</p>
                  </div>
                  <span className={`shrink-0 rounded-full px-2 py-1 text-[10px] font-medium ${required ? 'bg-violet-100 text-violet-800' : 'bg-muted text-muted-foreground'}`}>
                    {required ? `Required ${rows.length}/${group.min_photos || 1}` : `${rows.length + drafts.length}/${limit}`}
                  </span>
                </div>
                {(rows.length > 0 || drafts.length > 0) && (
                  <div className="mt-3 grid grid-cols-2 gap-2">
                    {rows.map((row) => <PhotoTile key={row.id || row.file_url} row={row} onDelete={!readonly ? () => deleteUploadedPhoto(row) : null} />)}
                    {drafts.map((draft) => (
                      <PendingPhotoTile
                        key={draft.id}
                        draft={draft}
                        uploading={uploadingDraftIds.includes(draft.id)}
                        onRetry={() => uploadDraft(draft, group)}
                        onDelete={() => deletePendingPhoto(draft)}
                      />
                    ))}
                  </div>
                )}
                {!readonly && (
                  <>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="mt-3"
                      disabled={rows.length + drafts.length >= limit}
                      onClick={() => fileInputs.current[group.id]?.click()}
                    >
                      <Camera className="mr-1 h-4 w-4" />
                      Take photo
                    </Button>
                    <input
                      ref={(node) => { fileInputs.current[group.id] = node }}
                      className="hidden"
                      type="file"
                      accept="image/*"
                      capture="environment"
                      onChange={(event) => captureGroup(group, event.target.files?.[0])}
                    />
                  </>
                )}
              </div>
            )
          })}
        </section>

        <div className="space-y-1.5">
          <Label>Completion notes</Label>
          <Textarea
            value={completionNotes}
            onChange={(event) => setCompletionNotes(event.target.value)}
            rows={3}
            disabled={readonly}
            placeholder="Optional summary or handover note"
          />
        </div>
      </div>

      {!readonly && (
        <div className="grid grid-cols-2 gap-2 border-t bg-background p-4 pb-[calc(1rem+env(safe-area-inset-bottom))]">
          <Button variant="outline" disabled={saving} onClick={() => save('save')}>
            {saving ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Save className="mr-1 h-4 w-4" />}
            Save progress
          </Button>
          <Button disabled={saving} onClick={() => save('complete')}>
            {saving ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <CheckCircle2 className="mr-1 h-4 w-4" />}
            Complete
          </Button>
        </div>
      )}
    </div>
  )
}

function ChecklistItem({ item, response, readonly, onChange }) {
  const result = itemResult(item, response)
  const isFail = result === 'fail'
  return (
    <div className={`rounded-2xl border p-3 ${isFail ? 'border-rose-300 bg-rose-50/50' : 'bg-card'}`}>
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium leading-5">{item.name}</p>
          {item.instruction && <p className="mt-1 text-xs leading-5 text-muted-foreground">{item.instruction}</p>}
        </div>
        {result === 'pass' && <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600" />}
        {result === 'fail' && <AlertTriangle className="h-4 w-4 shrink-0 text-rose-600" />}
      </div>

      <div className="mt-3">
        {String(item.response_type).toUpperCase() === 'TEMPERATURE' ? (
          <div className="flex items-center gap-2">
            <Input
              type="number"
              step="0.1"
              value={response.value ?? ''}
              disabled={readonly}
              onChange={(event) => onChange({ value: event.target.value })}
              placeholder="Actual temperature"
            />
            <span className="text-sm text-muted-foreground">{item.unit || ''}</span>
          </div>
        ) : (
          <div className="grid grid-cols-3 gap-2">
            {(item.options || []).map((option) => (
              <button
                key={option}
                type="button"
                disabled={readonly}
                onClick={() => onChange({ value: option })}
                className={`rounded-xl border px-2 py-2 text-xs font-medium ${String(response.value) === String(option) ? 'border-primary bg-primary/15 text-foreground' : 'bg-background text-muted-foreground'} disabled:opacity-60`}
              >
                {option}
              </button>
            ))}
          </div>
        )}
      </div>

      <Input
        className="mt-2"
        value={response.remark || ''}
        disabled={readonly}
        onChange={(event) => onChange({ remark: event.target.value })}
        placeholder="Remark (optional)"
      />

      {isFail && (
        <Textarea
          className="mt-2"
          value={response.corrective_action || ''}
          disabled={readonly}
          onChange={(event) => onChange({ corrective_action: event.target.value })}
          placeholder="Corrective action is required"
          rows={2}
        />
      )}
    </div>
  )
}

function PhotoTile({ row, onDelete = null }) {
  const url = photoUrl(row)
  const [open, setOpen] = useState(false)
  const title = row.caption || row.file_name || 'Task photo'
  return (
    <>
      <div className="relative overflow-hidden rounded-xl border bg-muted">
        <button type="button" onClick={() => url && setOpen(true)} className="block w-full text-left">
          {url ? <img src={url} alt={title} className="h-32 w-full object-cover" /> : <div className="flex h-32 items-center justify-center"><FileImage className="h-8 w-8 text-muted-foreground" /></div>}
          <p className="truncate p-2 pr-10 text-[11px]">{title}</p>
        </button>
        {onDelete ? (
          <button
            type="button"
            onClick={onDelete}
            className="absolute right-2 top-2 flex h-8 w-8 items-center justify-center rounded-full bg-black/70 text-white"
            aria-label="Delete task photo"
          >
            <Trash2 className="h-4 w-4" />
          </button>
        ) : null}
      </div>
      <MediaLightbox open={open} onOpenChange={setOpen} src={url || ''} title={title} type="image" />
    </>
  )
}

function PendingPhotoTile({ draft, uploading, onRetry, onDelete }) {
  const [url, setUrl] = useState('')
  useEffect(() => {
    const next = draft?.file ? URL.createObjectURL(draft.file) : ''
    setUrl(next)
    return () => { if (next) URL.revokeObjectURL(next) }
  }, [draft?.id, draft?.file])
  return (
    <div className="relative overflow-hidden rounded-xl border border-amber-300 bg-amber-50">
      {url ? <img src={url} alt="Saved task photo draft" className="h-32 w-full object-cover" /> : <div className="flex h-32 items-center justify-center"><FileImage className="h-8 w-8 text-amber-700" /></div>}
      <div className="space-y-1 p-2">
        <p className="truncate text-[11px] font-medium text-amber-900">Saved on this device</p>
        <div className="flex gap-1">
          <button type="button" onClick={onRetry} disabled={uploading} className="flex-1 rounded-lg bg-amber-600 px-2 py-1.5 text-[10px] font-semibold text-white disabled:opacity-50">
            {uploading ? 'Uploading…' : 'Retry upload'}
          </button>
          <button type="button" onClick={onDelete} disabled={uploading} className="flex h-7 w-7 items-center justify-center rounded-lg border border-amber-300 text-amber-900 disabled:opacity-50" aria-label="Delete saved photo draft">
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    </div>
  )
}

