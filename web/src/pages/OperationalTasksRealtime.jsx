import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { opsClient } from '@/api/opsClient'
import { useAuth } from '@/lib/AuthContext'
import { parseOutletIds, outletLabel } from '@/lib/outlets'
import { todayStr } from '@/lib/ops-helpers'
import AppDrawer from '@/components/AppDrawer'
import MediaLightbox from '@/components/MediaLightbox'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import {
  AlertTriangle,
  BookOpen,
  Camera,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock,
  ImageOff,
  Loader2,
  Lock,
  RefreshCw,
  Trash2,
} from 'lucide-react'
import { watermarkTaskPhoto } from '@/lib/watermark-image'
import { taskPhotoEntityId } from '@/lib/task-photo-persistence'
import {
  announceTaskPhotoCaptureConsumer,
  subscribeTaskPhotoCapture,
} from '@/lib/task-photo-capture-channel'

const AUTOSAVE_DELAY_MS = 800
const shifts = ['MORNING', 'DAILY', 'NIGHT']
const filters = [['all', '全部'], ['open', '待完成'], ['done', '已完成'], ['locked', '已锁定']]
const cn = (object, key, fallback = '') => object?.[`${key}_cn`] || object?.[key] || fallback
const en = (object, key) => object?.[`${key}_en`] || ''
const flat = (task) => (task.config?.sections || []).flatMap((section) => section.items || [])
const mapResponses = (task) => Object.fromEntries((task.responses || []).map((row) => [String(row.item_id), { ...row }]))

function time(value) {
  if (!value) return ''
  return new Intl.DateTimeFormat('en-MY', {
    timeZone: 'Asia/Kuching',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(value))
}

function recurrenceParts(value) {
  return Object.fromEntries(String(value || '').split(';').filter(Boolean).map((part) => {
    const index = part.indexOf('=')
    return index < 0 ? ['FREQ', part.toUpperCase()] : [part.slice(0, index).toUpperCase(), part.slice(index + 1).toUpperCase()]
  }))
}

function occurs(task, dateText) {
  const parts = recurrenceParts(task.recurrence_rule)
  const frequency = parts.FREQ || 'DAILY'
  const date = new Date(`${dateText}T00:00:00Z`)
  if (frequency === 'DAILY') return true
  if (frequency === 'WEEKLY') return String(parts.BYDAY || '').split(',').includes(['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'][date.getUTCDay()])
  if (frequency === 'MONTHLY') return String(parts.BYMONTHDAY || '1').split(',').map(Number).includes(date.getUTCDate())
  return true
}

function result(item, response) {
  if (response?.value === '' || response?.value == null) return 'incomplete'
  return (item.fail_values || []).map(String).includes(String(response.value)) ? 'fail' : 'pass'
}

function taskStatus(task) {
  const state = String(task.access_state || '').toUpperCase()
  if (state === 'DONE' || String(task.status || '').toLowerCase() === 'done') return '已完成'
  if (state === 'NOT_OPEN') return '未开放'
  if (state === 'LOCKED') return '已锁定'
  if (state === 'OVERDUE') return '已逾时'
  return '可执行'
}

function visible(task, filter) {
  if (filter === 'all') return true
  if (filter === 'done') return String(task.status).toLowerCase() === 'done'
  if (filter === 'locked') return String(task.access_state).toUpperCase() === 'LOCKED'
  return String(task.status).toLowerCase() !== 'done' && String(task.access_state).toUpperCase() !== 'LOCKED'
}

function parseTaskState(record = {}) {
  try {
    const parsed = JSON.parse(String(record.notes || ''))
    if (parsed?.schema === 'operational-checklist-v1') return parsed
  } catch {}
  return null
}

function mergeRealtimeTask(currentTask, record, detail = {}) {
  if (!currentTask || !record) return currentTask
  const state = parseTaskState(record)
  const responses = state
    ? Object.entries(state.responses || {}).map(([itemId, row]) => ({
        item_id: itemId,
        value: row?.value ?? '',
        remark: row?.remark || '',
        corrective_action: row?.corrective_action || '',
      }))
    : currentTask.responses
  const completed = state
    ? flat(currentTask).filter((item) => result(item, state.responses?.[item.id]) !== 'incomplete').length
    : currentTask.checklist_completed
  return {
    ...currentTask,
    ...record,
    config: currentTask.config || {},
    responses,
    completion_notes: state?.completion_notes ?? record.completion_notes ?? currentTask.completion_notes,
    checklist_total: flat(currentTask).length,
    checklist_completed: completed,
    access_state: String(record.status || '').toLowerCase() === 'done' ? 'DONE' : currentTask.access_state,
    __realtime: {
      ...(currentTask.__realtime || {}),
      entity: 'Task',
      entity_id: record.id || detail.entity_id || currentTask.id,
      outlet_id: record.outlet_id || detail.outlet_id || currentTask.outlet_id,
      version: Number(detail.version || record?.__realtime?.version || currentTask?.__realtime?.version || 0),
      updated_at: detail.occurred_at || record.updated_date || currentTask?.__realtime?.updated_at || '',
      deleted_at: record.deleted_at || '',
    },
  }
}

function eventRecord(detail = {}) {
  return detail.record || detail.payload?.record || detail.payload?.task || null
}

function mutationRecord(result, entity) {
  const record = result?.record || null
  if (!record) return null
  return {
    ...record,
    __realtime: {
      entity,
      entity_id: result.entity_id || record.id || '',
      outlet_id: result.outlet_id || record.outlet_id || '',
      version: Number(result.version || 0),
      updated_at: result.committed_at || record.updated_date || '',
      deleted_at: record.deleted_at || '',
      sync_status: result.sync_status || 'pending',
    },
  }
}

function taskPhotoUrl(photo) {
  const driveFileId = String(photo?.drive_file_id || '').trim()
  const version = encodeURIComponent(photo?.updated_date || photo?.captured_at || photo?.id || photo?.file_size || Date.now())
  if (driveFileId) return `${opsClient.apiBaseUrl}/api/files/${encodeURIComponent(driveFileId)}?v=${version}`
  return String(photo?.file_url || '')
}

function TaskEvidenceImage({ photo, onOpen }) {
  const [attempt, setAttempt] = useState(0)
  const [failed, setFailed] = useState(false)
  const source = taskPhotoUrl(photo)
  const withAttempt = source ? `${source}${source.includes('?') ? '&' : '?'}retry=${attempt}` : ''
  if (!source || failed) {
    return (
      <button
        type="button"
        onClick={() => { setFailed(false); setAttempt((value) => value + 1) }}
        className="flex aspect-[4/3] w-full flex-col items-center justify-center gap-2 rounded-xl bg-muted px-3 text-center text-xs font-semibold text-muted-foreground"
      >
        <ImageOff className="h-6 w-6" />
        照片加载失败，点这里重试
      </button>
    )
  }
  return (
    <button type="button" className="block w-full" onClick={onOpen}>
      <img src={withAttempt} onError={() => setFailed(true)} className="aspect-[4/3] w-full rounded-xl object-cover" alt="Task evidence" />
    </button>
  )
}

export default function OperationalTasksRealtime() {
  const { user } = useAuth()
  const navigate = useNavigate()
  const allowed = parseOutletIds(user)
  const [outlets, setOutlets] = useState([])
  const [outletId, setOutletId] = useState(user.outlet_id || allowed[0] || '')
  const [date, setDate] = useState(todayStr())
  const [data, setData] = useState({ tasks: [], task_photos: [] })
  const [selected, setSelected] = useState('')
  const [filter, setFilter] = useState('all')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [lastSyncedAt, setLastSyncedAt] = useState('')
  const [realtimeState, setRealtimeState] = useState('connecting')
  const syncRunning = useRef(false)
  const taskSessionApi = useRef(null)
  const hasLoaded = useRef(false)
  const realtimeWasConnected = useRef(false)

  const load = useCallback(async (refresh = true, { silent = false, suppressError = false } = {}) => {
    if (!outletId || syncRunning.current) return null
    syncRunning.current = true
    if (!silent) setLoading(true)
    if (!suppressError) setError('')
    try {
      const response = await opsClient.tasks.operationalBootstrap({ outletId, date, refresh })
      setData(response || { tasks: [], task_photos: [] })
      setLastSyncedAt(response?.server_time || new Date().toISOString())
      hasLoaded.current = true
      return response
    } catch (loadError) {
      if (!suppressError) setError(loadError?.message || 'Unable to load tasks')
      return null
    } finally {
      syncRunning.current = false
      if (!silent) setLoading(false)
    }
  }, [date, outletId])

  useEffect(() => {
    opsClient.entities.Outlet.list('name', 100)
      .then((rows) => setOutlets((rows || []).filter((row) => allowed.includes(String(row.id)))))
      .catch(() => {})
  }, [user.outlet_ids])

  useEffect(() => {
    if (!outletId) return
    realtimeWasConnected.current = false
    void load(true)
  }, [date, load, outletId])

  useEffect(() => {
    const onRealtimeState = (event) => {
      const detail = event.detail || {}
      if (String(detail.outlet_id || '') !== String(outletId || '')) return
      const next = String(detail.state || 'disconnected')
      setRealtimeState(next)
      if (next === 'connected' && !realtimeWasConnected.current && hasLoaded.current) {
        realtimeWasConnected.current = true
        void load(false, { silent: true, suppressError: true })
      } else if (next !== 'connected') {
        realtimeWasConnected.current = false
      }
    }
    window.addEventListener('chefops:realtime-state', onRealtimeState)
    return () => window.removeEventListener('chefops:realtime-state', onRealtimeState)
  }, [load, outletId])

  useEffect(() => {
    const onRealtime = (event) => {
      const detail = event.detail || {}
      const entity = String(detail.entity || '')
      if (entity !== 'Task' && entity !== 'TaskPhoto') return
      const record = eventRecord(detail)
      if (!record) return
      const eventOutlet = String(record.outlet_id || detail.outlet_id || '')
      if (eventOutlet && eventOutlet !== 'global' && eventOutlet !== String(outletId)) return

      if (entity === 'Task') {
        if (record.due_date && String(record.due_date).slice(0, 10) !== String(date)) return
        event.preventDefault()
        setData((current) => ({
          ...current,
          tasks: current.tasks.map((task) => String(task.id) === String(record.id || detail.entity_id)
            ? mergeRealtimeTask(task, record, detail)
            : task),
        }))
      } else {
        event.preventDefault()
        const photoId = String(record.id || detail.entity_id || '')
        if (!photoId) return
        const deleted = Boolean(record.deleted_at)
          || String(detail.action || '').toLowerCase() === 'deleted'
          || String(record.status || '').toLowerCase() === 'deleted'
        setData((current) => {
          const rows = current.task_photos || []
          const next = deleted
            ? rows.filter((photo) => String(photo.id) !== photoId)
            : rows.some((photo) => String(photo.id) === photoId)
              ? rows.map((photo) => String(photo.id) === photoId ? { ...photo, ...record } : photo)
              : [record, ...rows]
          return { ...current, task_photos: next }
        })
      }
      setLastSyncedAt(detail.occurred_at || new Date().toISOString())
    }
    window.addEventListener('chefops:realtime', onRealtime)
    return () => window.removeEventListener('chefops:realtime', onRealtime)
  }, [date, outletId])

  async function act(id, action, payload = {}) {
    const response = await opsClient.tasks.operationalAction({ task_id: id, outlet_id: outletId, date, action, ...payload })
    setData((current) => ({
      ...current,
      tasks: current.tasks.map((task) => task.id === id ? response.task : task),
    }))
    setLastSyncedAt(response?.server_time || new Date().toISOString())
    return response.task
  }

  const upsertPhoto = useCallback((photo) => {
    if (!photo?.id) return
    setData((current) => {
      const rows = current.task_photos || []
      return {
        ...current,
        task_photos: rows.some((row) => String(row.id) === String(photo.id))
          ? rows.map((row) => String(row.id) === String(photo.id) ? { ...row, ...photo } : row)
          : [photo, ...rows],
      }
    })
  }, [])

  const removePhoto = useCallback((photoId) => {
    setData((current) => ({
      ...current,
      task_photos: (current.task_photos || []).filter((photo) => String(photo.id) !== String(photoId)),
    }))
  }, [])

  const closeSelectedTask = useCallback(async () => {
    const ok = await taskSessionApi.current?.flush?.()
    if (ok === false) return
    taskSessionApi.current = null
    setSelected('')
  }, [])

  const tasks = useMemo(() => (data.tasks || []).filter((task) => occurs(task, date)), [data.tasks, date])
  const chosen = tasks.find((task) => task.id === selected)
  const outlet = outlets.find((row) => String(row.id) === String(outletId))

  return (
    <div className="mx-auto max-w-lg space-y-4 p-4 pb-24">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold">今日任务</h1>
          <p className="text-xs text-muted-foreground">Daily Tasks · {outletLabel(outlet, outletId)}</p>
          <p className="mt-1 text-[10px] text-muted-foreground">
            {realtimeState === 'connected' ? '实时连接 · ' : '重新连接中 · '}
            {lastSyncedAt ? `最后同步 ${time(lastSyncedAt)}` : '等待同步'}
          </p>
        </div>
        <Button size="icon" variant="outline" onClick={() => void load(true)} disabled={loading} aria-label="Refresh current tasks">
          <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
        </Button>
      </div>

      {outlets.length > 1 ? (
        <select className="h-10 w-full rounded-md border bg-background px-3" value={outletId} onChange={(event) => setOutletId(event.target.value)}>
          {outlets.map((item) => <option key={item.id} value={item.id}>{outletLabel(item, item.id)}</option>)}
        </select>
      ) : null}
      <Input type="date" value={date} onChange={(event) => setDate(event.target.value)} />
      <div className="flex gap-2 overflow-auto">
        {filters.map(([value, label]) => (
          <button key={value} type="button" onClick={() => setFilter(value)} className={`whitespace-nowrap rounded-full px-3 py-1.5 text-xs font-semibold ${filter === value ? 'bg-primary text-primary-foreground' : 'bg-muted'}`}>{label}</button>
        ))}
      </div>
      {error ? <div className="rounded-xl bg-destructive/10 p-3 text-sm text-destructive">{error}</div> : null}
      {loading ? (
        <div className="flex justify-center py-12"><Loader2 className="animate-spin" /></div>
      ) : shifts.map((shift) => {
        const rows = tasks.filter((task) => String(task.config?.schedule?.shift_id || task.period).toUpperCase() === shift && visible(task, filter))
        if (!rows.length) return null
        return (
          <section key={shift} className="space-y-2">
            <div className="border-b pb-2">
              <b className="text-sm">{shift === 'MORNING' ? '早班' : shift === 'NIGHT' ? '晚班' : '日间'}</b>
              <span className="ml-2 text-xs text-muted-foreground">{rows.length} tasks</span>
            </div>
            {rows.map((task) => (
              <TaskCard
                key={task.id}
                task={task}
                onOpen={async () => {
                  if (task.status === 'pending' && ['OPEN', 'OVERDUE'].includes(String(task.access_state).toUpperCase())) await act(task.id, 'start')
                  setSelected(task.id)
                }}
              />
            ))}
          </section>
        )
      })}

      <AppDrawer
        open={Boolean(chosen)}
        onOpenChange={(open) => { if (!open) void closeSelectedTask() }}
        title={chosen ? cn(chosen.config, 'title', chosen.title) : '任务'}
        subtitle={chosen ? en(chosen.config, 'title') : ''}
        heightClass="h-[94dvh]"
      >
        {chosen ? (
          <TaskForm
            key={chosen.id}
            task={chosen}
            outletId={outletId}
            outletName={outletLabel(outlet, outletId)}
            photos={(data.task_photos || []).filter((photo) => photo.task_id === chosen.id && !photo.deleted_at && String(photo.status || 'active').toLowerCase() !== 'deleted')}
            onAct={(action, payload) => act(chosen.id, action, payload)}
            onPhotoCommitted={upsertPhoto}
            onPhotoDeleted={removePhoto}
            openSop={(id) => navigate(`/sop/${id}`)}
            error={setError}
            sessionApiRef={taskSessionApi}
          />
        ) : null}
      </AppDrawer>
    </div>
  )
}

function TaskCard({ task, onOpen }) {
  const items = flat(task)
  const done = Number(task.checklist_completed || 0)
  const locked = ['NOT_OPEN', 'LOCKED'].includes(String(task.access_state).toUpperCase())
  return (
    <button type="button" onClick={onOpen} className="w-full rounded-2xl border bg-card p-4 text-left shadow-sm">
      <div className="flex gap-3">
        <span className={`flex h-10 w-10 items-center justify-center rounded-xl ${locked ? 'bg-muted' : 'bg-primary/15'}`}>{locked ? <Lock className="h-5 w-5" /> : <Clock className="h-5 w-5 text-primary" />}</span>
        <div className="min-w-0 flex-1">
          <b className="block text-sm">{cn(task.config, 'title', task.title)}</b>
          <span className="block text-xs text-muted-foreground">{en(task.config, 'title')}</span>
          <span className="mt-1 block text-[11px] text-muted-foreground">{time(task.opens_at)}–{time(task.due_at)} · {task.config?.estimated_minutes || 0} min</span>
        </div>
        <span className="rounded-full bg-muted px-2 py-1 text-[10px] font-semibold">{taskStatus(task)}</span>
      </div>
      <div className="mt-3 flex items-center gap-2">
        <div className="h-1.5 flex-1 rounded bg-muted"><div className="h-full rounded bg-primary" style={{ width: `${items.length ? done / items.length * 100 : 0}%` }} /></div>
        <span className="text-[11px]">{done}/{items.length}</span><ChevronRight className="h-4 w-4" />
      </div>
    </button>
  )
}

function SaveState({ state }) {
  if (state.phase === 'saving') return <span className="text-[11px] font-medium text-muted-foreground">同步中…</span>
  if (state.phase === 'pending') return <span className="text-[11px] font-medium text-amber-700">待同步</span>
  if (state.phase === 'error') return <span className="text-[11px] font-medium text-rose-700">同步失败 · 点保存重试</span>
  return <span className="text-[11px] font-medium text-emerald-700">已同步{state.at ? ` ${time(state.at)}` : ''}</span>
}

function TaskForm({ task, outletId, outletName, photos, onAct, onPhotoCommitted, onPhotoDeleted, openSop, error, sessionApiRef }) {
  const config = task.config || {}
  const groups = task.photo_requirements || config.photo_groups || []
  const input = useRef({})
  const localPhotoUrls = useRef(new Map())
  const responsesRef = useRef(mapResponses(task))
  const notesRef = useRef(task.completion_notes || '')
  const dirtyItems = useRef(new Map())
  const dirtyNotes = useRef(0)
  const revision = useRef(0)
  const saveTimer = useRef(null)
  const saveInFlight = useRef(null)
  const [responses, setResponses] = useState(() => mapResponses(task))
  const [notes, setNotes] = useState(task.completion_notes || '')
  const [saveState, setSaveState] = useState({ phase: 'saved', at: task.updated_date || '' })
  const [completing, setCompleting] = useState(false)
  const [uploading, setUploading] = useState('')
  const [deleting, setDeleting] = useState('')
  const [localPhotos, setLocalPhotos] = useState([])
  const [groupErrors, setGroupErrors] = useState({})
  const [viewer, setViewer] = useState(null)
  const readonly = ['NOT_OPEN', 'LOCKED', 'DONE'].includes(String(task.access_state).toUpperCase())
  const sop = task.sop_id || config.sop_id

  const releaseLocalPhoto = useCallback((id) => {
    const url = localPhotoUrls.current.get(id)
    if (url) URL.revokeObjectURL(url)
    localPhotoUrls.current.delete(id)
  }, [])

  const hasDirtyDraft = () => dirtyItems.current.size > 0 || dirtyNotes.current > 0

  function queueAutosave(delay = AUTOSAVE_DELAY_MS) {
    window.clearTimeout(saveTimer.current)
    saveTimer.current = window.setTimeout(() => { void flushDraft() }, delay)
  }

  function update(id, patch) {
    const nextRevision = ++revision.current
    const next = {
      ...responsesRef.current,
      [id]: {
        item_id: id,
        value: '',
        remark: '',
        corrective_action: '',
        ...(responsesRef.current[id] || {}),
        ...patch,
      },
    }
    responsesRef.current = next
    setResponses(next)
    dirtyItems.current.set(String(id), nextRevision)
    setSaveState({ phase: 'pending', at: '' })
    queueAutosave()
  }

  function updateNotes(value) {
    const nextRevision = ++revision.current
    notesRef.current = value
    setNotes(value)
    dirtyNotes.current = nextRevision
    setSaveState({ phase: 'pending', at: '' })
    queueAutosave()
  }

  async function flushDraft() {
    window.clearTimeout(saveTimer.current)
    if (saveInFlight.current) {
      const ok = await saveInFlight.current
      if (!ok) return false
      return hasDirtyDraft() ? flushDraft() : true
    }
    if (!hasDirtyDraft()) return true

    const itemSnapshot = [...dirtyItems.current.entries()]
    const notesSnapshot = dirtyNotes.current
    const responsePatches = itemSnapshot.map(([id]) => responsesRef.current[id]).filter(Boolean).map((row) => ({ ...row }))
    const payload = { response_patches: responsePatches }
    if (notesSnapshot) payload.completion_notes_patch = notesRef.current

    const run = (async () => {
      setSaveState({ phase: 'saving', at: '' })
      try {
        const updated = await onAct('save', payload)
        for (const [id, savedRevision] of itemSnapshot) {
          if (dirtyItems.current.get(id) === savedRevision) dirtyItems.current.delete(id)
        }
        if (notesSnapshot && dirtyNotes.current === notesSnapshot) dirtyNotes.current = 0
        setSaveState(hasDirtyDraft()
          ? { phase: 'pending', at: '' }
          : { phase: 'saved', at: updated?.updated_date || updated?.__realtime?.updated_at || new Date().toISOString() })
        return true
      } catch (saveError) {
        setSaveState({ phase: 'error', at: '' })
        error(saveError?.message || 'Unable to save task')
        return false
      } finally {
        saveInFlight.current = null
      }
    })()
    saveInFlight.current = run
    return run
  }

  useEffect(() => {
    const incoming = mapResponses(task)
    const next = { ...incoming }
    for (const id of dirtyItems.current.keys()) {
      if (responsesRef.current[id]) next[id] = responsesRef.current[id]
    }
    responsesRef.current = next
    setResponses(next)
    if (!dirtyNotes.current) {
      const value = task.completion_notes || ''
      notesRef.current = value
      setNotes(value)
    }
  }, [task.id, task.updated_date, task.__realtime?.version])

  sessionApiRef.current = { flush: flushDraft }

  useEffect(() => () => {
    sessionApiRef.current = null
    window.clearTimeout(saveTimer.current)
    localPhotoUrls.current.forEach((url) => URL.revokeObjectURL(url))
    localPhotoUrls.current.clear()
    if (hasDirtyDraft()) void flushDraft()
  }, [])

  useEffect(() => {
    const onHidden = () => { if (document.visibilityState === 'hidden' && hasDirtyDraft()) void flushDraft() }
    const onOnline = () => { if (hasDirtyDraft()) queueAutosave(100) }
    const onCameraError = (event) => {
      const groupId = String(event.detail?.groupId || '')
      const taskId = String(event.detail?.taskId || '')
      if (taskId && taskId !== String(task.id)) return
      if (groupId) setGroupErrors((current) => ({ ...current, [groupId]: String(event.detail?.message || '无法打开相机') }))
    }
    document.addEventListener('visibilitychange', onHidden)
    window.addEventListener('online', onOnline)
    window.addEventListener('chefops:task-photo-inline-error', onCameraError)
    return () => {
      document.removeEventListener('visibilitychange', onHidden)
      window.removeEventListener('online', onOnline)
      window.removeEventListener('chefops:task-photo-inline-error', onCameraError)
    }
  })

  useEffect(() => {
    const unsubscribe = subscribeTaskPhotoCapture((event) => {
      const detail = event.detail || {}
      if (String(detail.taskId || '') !== String(task.id)) return
      if (detail.outletId && String(detail.outletId) !== String(outletId)) return
      const group = groups.find((row) => String(row.id) === String(detail.groupId || ''))
      if (!group || !(detail.file instanceof File)) return
      event.preventDefault()
      void upload(group, detail.file)
    })
    announceTaskPhotoCaptureConsumer(task.id)
    return unsubscribe
  }, [groups, outletId, task.id])

  function removeLocalPhoto(id) {
    releaseLocalPhoto(id)
    setLocalPhotos((current) => current.filter((photo) => photo.id !== id))
  }

  async function upload(group, file, existingLocal = null) {
    if (!file) return
    const localId = existingLocal?.id || `task-photo-local-${crypto.randomUUID()}`
    if (!existingLocal) {
      const url = URL.createObjectURL(file)
      localPhotoUrls.current.set(localId, url)
      setLocalPhotos((current) => [...current, { id: localId, groupId: group.id, file, url, prepared: null, uploaded: null, serverId: '', phase: 'processing', error: '' }])
    } else {
      setLocalPhotos((current) => current.map((photo) => photo.id === localId ? { ...photo, phase: photo.uploaded ? 'registering' : 'processing', error: '' } : photo))
    }
    setGroupErrors((current) => ({ ...current, [group.id]: '' }))
    setUploading(group.id)

    try {
      let prepared = existingLocal?.prepared || null
      if (!prepared) {
        prepared = await watermarkTaskPhoto(file, { capturedAt: new Date() })
        setLocalPhotos((current) => current.map((photo) => photo.id === localId ? { ...photo, prepared, phase: 'uploading' } : photo))
      }
      let uploaded = existingLocal?.uploaded || null
      if (!uploaded) {
        uploaded = await opsClient.integrations.Core.UploadFile({ file: prepared.file, folderType: 'Task Checklist Photos', outletName, outletId })
        setLocalPhotos((current) => current.map((photo) => photo.id === localId ? { ...photo, prepared, uploaded, phase: 'registering' } : photo))
      }

      const photoPayload = {
        outlet_id: outletId,
        task_id: task.id,
        template_id: task.template_id,
        photo_type: `checklist:${group.id}`,
        drive_file_id: uploaded.drive_file_id || '',
        file_name: uploaded.file_name || prepared.file.name,
        file_url: uploaded.file_url || '',
        caption: cn(group, 'name'),
        status: 'active',
        mime_type: uploaded.mime_type || prepared.file.type,
        file_size: Number(uploaded.file_size || prepared.file.size),
        captured_at: prepared.capturedAt,
        watermark_text: prepared.watermarkText,
      }
      const serverId = taskPhotoEntityId(photoPayload)
      setLocalPhotos((current) => current.map((photo) => photo.id === localId ? { ...photo, prepared, uploaded, serverId, phase: 'registering' } : photo))

      const mutation = await opsClient.realtime.mutate({
        entity: 'TaskPhoto', entity_id: serverId, outlet_id: outletId, operation: 'create', payload: { ...photoPayload, id: serverId },
      }, { queueOffline: false })
      const savedPhoto = mutationRecord(mutation, 'TaskPhoto')
      if (!savedPhoto) throw new Error('照片登记失败')
      onPhotoCommitted(savedPhoto)
      removeLocalPhoto(localId)
    } catch (uploadError) {
      setLocalPhotos((current) => current.map((photo) => photo.id === localId ? { ...photo, phase: 'error', error: uploadError?.message || '照片处理失败' } : photo))
    } finally {
      setUploading('')
      if (input.current[group.id]) input.current[group.id].value = ''
    }
  }

  async function removePhoto(photo) {
    if (!confirm('删除这张照片并重新拍摄？')) return
    setDeleting(photo.id)
    try {
      await opsClient.realtime.mutate({
        entity: 'TaskPhoto', entity_id: photo.id, outlet_id: outletId, operation: 'delete', payload: { ...photo, outlet_id: outletId, __realtime: undefined },
      }, { queueOffline: false })
      onPhotoDeleted(photo.id)
    } catch (deleteError) {
      error(deleteError?.message || '无法删除照片')
    } finally {
      setDeleting('')
    }
  }

  async function completeTask() {
    if (localPhotos.length) {
      error(localPhotos.some((photo) => photo.phase === 'error') ? '有照片保存失败，请先重试或删除失败照片。' : '照片仍在上传，请完成后再提交任务。')
      return
    }
    if (!await flushDraft()) return
    setCompleting(true)
    try { await onAct('complete', {}) }
    catch (completeError) { error(completeError?.message || 'Unable to complete task') }
    finally { setCompleting(false) }
  }

  return (
    <>
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="min-h-0 flex-1 space-y-4 overflow-auto p-4 pb-8">
          <div className="flex items-center justify-between gap-3 rounded-2xl border bg-muted/25 p-3">
            <div><b>{cn(config.schedule, 'shift_name')}</b><p className="text-xs text-muted-foreground">开放 {time(task.opens_at)} · 截止 {time(task.due_at)}</p></div>
            <SaveState state={saveState} />
          </div>

          {cn(config, 'completion_standard') ? <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-3"><b className="text-xs">完成标准</b><p className="mt-1 text-sm leading-6">{cn(config, 'completion_standard')}</p></div> : null}
          {sop ? <button type="button" onClick={() => openSop(sop)} className="flex w-full items-center gap-3 rounded-2xl border p-3 text-left"><BookOpen className="h-5 w-5 text-primary" /><span className="flex-1"><b className="block text-sm">不确定怎样做？查看标准做法</b><small className="text-muted-foreground">SOP guide</small></span><ChevronRight className="h-4 w-4" /></button> : null}
          {readonly && String(task.access_state).toUpperCase() !== 'DONE' ? <div className="flex gap-2 rounded-xl bg-amber-50 p-3 text-sm"><AlertTriangle className="h-4 w-4" />任务未开放或已锁定。</div> : null}

          {(config.sections || []).map((section) => (
            <section key={section.id} className="space-y-2">
              <div><b className="text-sm">{cn(section, 'name')}</b><p className="text-[11px] text-muted-foreground">{en(section, 'name')}</p></div>
              {(section.items || []).map((item) => <Item key={item.id} item={item} response={responses[item.id] || { item_id: item.id, value: '' }} readonly={readonly} update={(patch) => update(item.id, patch)} standard={cn(config, 'completion_standard')} />)}
            </section>
          ))}

          {groups.length ? (
            <section className="space-y-2">
              <div><b className="text-sm">照片留证</b><p className="text-[11px] text-muted-foreground">拍照后独立上传并以 D1 回应为准，不刷新整张 Task。</p></div>
              {groups.map((group) => {
                const rows = photos.filter((photo) => photo.photo_type === `checklist:${group.id}`)
                const localRows = localPhotos.filter((photo) => photo.groupId === group.id)
                const displayCount = rows.length + localRows.length
                const required = String(group.rule).toUpperCase() === 'REQUIRED' || flat(task).filter((item) => item.photo_group_id === group.id).some((item) => result(item, responses[item.id]) === 'fail')
                const minimum = Number(group.min_photos || 1)
                const maximum = Number(group.max_photos || 1)
                return (
                  <div key={group.id} className="rounded-2xl border p-3" data-task-photo-ui data-task-photo-group={group.id}>
                    <div className="flex justify-between gap-2">
                      <div><b className="text-sm">{cn(group, 'name')}</b><p className="text-xs text-muted-foreground">{cn(group, 'sample_caption')}</p></div>
                      <small className="whitespace-nowrap">{required ? (displayCount < minimum ? `还需 ${minimum - displayCount} 张` : `已完成 · ${displayCount}/${maximum} 张`) : `异常时拍 · ${displayCount}/${maximum} 张`}</small>
                    </div>
                    {groupErrors[group.id] ? <p className="mt-2 rounded-lg bg-rose-50 px-2.5 py-2 text-xs font-medium text-rose-700">{groupErrors[group.id]}</p> : null}
                    {(rows.length || localRows.length) ? (
                      <div className="mt-2 grid grid-cols-2 gap-2">
                        {rows.map((photo) => (
                          <div key={photo.id} className="relative" data-task-photo-ui>
                            <TaskEvidenceImage photo={photo} onOpen={() => setViewer({ src: taskPhotoUrl(photo), title: photo.caption || 'Task evidence' })} />
                            {!readonly ? <button type="button" disabled={deleting === photo.id} onClick={() => void removePhoto(photo)} className="absolute right-1 top-1 rounded-full bg-black/70 p-2 text-white disabled:opacity-60" aria-label="Delete photo">{deleting === photo.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <Trash2 className="h-3 w-3" />}</button> : null}
                          </div>
                        ))}
                        {localRows.map((photo) => (
                          <div key={photo.id} className="relative" data-task-photo-ui>
                            <button type="button" className="block w-full" onClick={() => setViewer({ src: photo.url, title: '刚拍摄的任务照片' })}><img src={photo.url} className="aspect-[4/3] w-full rounded-xl object-cover" alt="刚拍摄的任务照片" /></button>
                            {photo.phase !== 'error' ? (
                              <div className="absolute inset-x-1 bottom-1 rounded-lg bg-black/65 px-2 py-1 text-center text-[10px] font-semibold text-white">{photo.phase === 'processing' ? '处理中…' : photo.phase === 'uploading' ? '上传中…' : '登记中…'}</div>
                            ) : (
                              <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 rounded-xl bg-black/70 p-2 text-center"><span className="text-[10px] font-semibold text-white">{photo.error || '照片保存失败'}</span><div className="flex gap-2"><button type="button" onClick={() => void upload(group, photo.file, photo)} className="rounded-lg bg-white px-3 py-1.5 text-xs font-bold text-slate-900">重试</button><button type="button" onClick={() => removeLocalPhoto(photo.id)} className="rounded-lg border border-white/70 px-3 py-1.5 text-xs font-bold text-white">删除</button></div></div>
                            )}
                          </div>
                        ))}
                      </div>
                    ) : null}
                    {!readonly ? (
                      <><Button size="sm" variant="outline" className="mt-2" data-task-photo-ui disabled={uploading === group.id || displayCount >= maximum} onClick={() => input.current[group.id]?.click()}><Camera className="mr-1 h-4 w-4" />{displayCount ? `加拍照片 ${displayCount}/${maximum}` : '拍照'}</Button><input ref={(node) => { input.current[group.id] = node }} type="file" accept="image/*" capture="environment" className="hidden" data-task-photo-input data-task-photo-group={group.id} data-task-photo-task-id={task.id} data-task-photo-outlet-id={outletId} onChange={(event) => void upload(group, event.target.files?.[0])} /></>
                    ) : null}
                  </div>
                )
              })}
            </section>
          ) : null}
          <Textarea rows={3} value={notes} disabled={readonly} onChange={(event) => updateNotes(event.target.value)} placeholder="异常或交接备注（选填）" />
        </div>

        {!readonly ? (
          <div className="grid grid-cols-2 gap-2 border-t bg-background p-4">
            <Button variant="outline" onClick={() => void flushDraft()} disabled={saveState.phase === 'saving'}>保存进度</Button>
            <Button onClick={() => void completeTask()} disabled={completing || saveState.phase === 'saving'}>{completing ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <CheckCircle2 className="mr-1 h-4 w-4" />}完成任务</Button>
          </div>
        ) : null}
      </div>
      <MediaLightbox open={Boolean(viewer)} onOpenChange={(open) => { if (!open) setViewer(null) }} src={viewer?.src || ''} title={viewer?.title || 'Task photo'} type="image" />
    </>
  )
}

function Item({ item, response, readonly, update, standard }) {
  const failed = result(item, response) === 'fail'
  const type = String(item.response_type || '').toUpperCase()
  const options = item.options || []
  return (
    <div className={`rounded-2xl border p-3 ${failed ? 'border-rose-300 bg-rose-50' : 'bg-card'}`}>
      <div className="flex gap-2"><span className={`flex h-6 w-6 items-center justify-center rounded-full border ${result(item, response) === 'pass' ? 'bg-emerald-500 text-white' : ''}`}>{result(item, response) === 'pass' ? <Check className="h-4 w-4" /> : null}</span><div className="flex-1"><b className="block text-sm">{cn(item, 'name')}</b><small className="text-muted-foreground">{en(item, 'name')}</small></div></div>
      <div className="mt-3">
        {type === 'TEXT' ? <Textarea rows={3} disabled={readonly} value={response.value || ''} onChange={(event) => update({ value: event.target.value })} placeholder={cn(item, 'placeholder', '填写数量与状态说明')} />
          : type === 'CHECKBOX' ? <button type="button" disabled={readonly} onClick={() => update({ value: response.value === 'Done' ? '' : 'Done' })} className={`w-full rounded-xl border p-2.5 text-sm font-semibold ${response.value === 'Done' ? 'border-emerald-500 bg-emerald-50' : ''}`}>{response.value === 'Done' ? '✓ 已完成 / Done' : '完成这一项 / Mark done'}</button>
            : <div className={`grid gap-2 ${options.length > 2 ? 'grid-cols-3' : 'grid-cols-2'}`}>{options.map((option) => <button key={option} type="button" disabled={readonly} onClick={() => update({ value: option })} className={`rounded-xl border p-2 text-xs font-semibold ${response.value === option ? (item.fail_values || []).includes(option) ? 'border-rose-500 bg-rose-50' : 'border-primary bg-primary/10' : ''}`}>{option}</button>)}</div>}
      </div>
      {(cn(item, 'instruction') || standard) ? <details className="mt-2 rounded-xl bg-muted/30 p-2"><summary className="flex cursor-pointer list-none justify-between text-xs font-semibold">查看简单说明<ChevronDown className="h-4 w-4" /></summary><p className="mt-2 text-xs leading-5">{cn(item, 'instruction')}</p><p className="mt-2 text-xs"><b>及格：</b>{cn(item, 'completion_standard') || standard}</p></details> : null}
      {failed ? <div className="mt-2 space-y-2"><Input value={response.remark || ''} onChange={(event) => update({ remark: event.target.value })} placeholder="异常说明" /><Textarea rows={2} value={response.corrective_action || ''} onChange={(event) => update({ corrective_action: event.target.value })} placeholder="怎样处理／已通知谁" /></div> : null}
    </div>
  )
}
