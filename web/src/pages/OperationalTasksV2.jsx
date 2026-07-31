import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { opsClient } from '@/api/opsClient'
import { useAuth } from '@/lib/AuthContext'
import { parseOutletIds, outletLabel } from '@/lib/outlets'
import { todayStr } from '@/lib/ops-helpers'
import AppDrawer from '@/components/AppDrawer'
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
    return index < 0
      ? ['FREQ', part.toUpperCase()]
      : [part.slice(0, index).toUpperCase(), part.slice(index + 1).toUpperCase()]
  }))
}

function occurs(task, dateText) {
  const parts = recurrenceParts(task.recurrence_rule)
  const frequency = parts.FREQ || 'DAILY'
  const date = new Date(`${dateText}T00:00:00Z`)
  if (frequency === 'DAILY') return true
  if (frequency === 'WEEKLY') {
    return String(parts.BYDAY || '').split(',').includes(['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'][date.getUTCDay()])
  }
  if (frequency === 'MONTHLY') {
    return String(parts.BYMONTHDAY || '1').split(',').map(Number).includes(date.getUTCDate())
  }
  return true
}

function result(item, response) {
  if (response?.value === '' || response?.value == null) return 'incomplete'
  return (item.fail_values || []).map(String).includes(String(response.value)) ? 'fail' : 'pass'
}

function status(task) {
  const state = String(task.access_state || '').toUpperCase()
  if (state === 'DONE') return '已完成'
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

function taskPhotoUrl(photo) {
  const driveFileId = String(photo?.drive_file_id || '').trim()
  const version = encodeURIComponent(photo?.updated_date || photo?.captured_at || photo?.id || photo?.file_size || Date.now())
  if (driveFileId) {
    return `${opsClient.apiBaseUrl}/api/files/${encodeURIComponent(driveFileId)}?v=${version}`
  }
  return String(photo?.file_url || '')
}

function TaskEvidenceImage({ photo }) {
  const [source, setSource] = useState('')
  const [failed, setFailed] = useState(false)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    const requestUrl = taskPhotoUrl(photo)
    if (!requestUrl) {
      setFailed(true)
      return undefined
    }

    let active = true
    let objectUrl = ''
    const controller = new AbortController()
    setSource('')
    setFailed(false)

    const load = async () => {
      try {
        const response = await fetch(requestUrl, {
          credentials: 'include',
          cache: 'no-store',
          headers: { Accept: 'image/*' },
          signal: controller.signal,
        })
        if (!response.ok) throw new Error(`Photo request failed (${response.status})`)
        const blob = await response.blob()
        if (!blob.size) throw new Error('Empty photo response')
        objectUrl = URL.createObjectURL(blob)
        if (active) setSource(objectUrl)
      } catch (error) {
        if (error?.name !== 'AbortError' && active) setFailed(true)
      }
    }

    load()
    return () => {
      active = false
      controller.abort()
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [attempt, photo?.id, photo?.drive_file_id, photo?.updated_date, photo?.captured_at, photo?.file_size])

  if (source) {
    return <img src={source} className="aspect-[4/3] w-full rounded-xl object-cover" alt="Task evidence" />
  }

  if (failed) {
    return (
      <button
        type="button"
        onClick={() => setAttempt((value) => value + 1)}
        className="flex aspect-[4/3] w-full flex-col items-center justify-center gap-2 rounded-xl bg-muted px-3 text-center text-xs font-semibold text-muted-foreground"
      >
        <ImageOff className="h-6 w-6" />
        照片加载失败，点这里重试
      </button>
    )
  }

  return (
    <div className="flex aspect-[4/3] w-full items-center justify-center rounded-xl bg-muted">
      <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
    </div>
  )
}

export default function OperationalTasksV2() {
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
  const syncRunning = useRef(false)
  const lastForcedAt = useRef(0)

  const load = useCallback(async (refresh = true, { silent = false } = {}) => {
    if (!outletId || syncRunning.current) return
    syncRunning.current = true
    if (!silent) setLoading(true)
    setError('')
    try {
      const response = await opsClient.tasks.operationalBootstrap({ outletId, date, refresh })
      setData(response || { tasks: [], task_photos: [] })
      setLastSyncedAt(response?.server_time || new Date().toISOString())
      if (refresh) lastForcedAt.current = Date.now()
    } catch (loadError) {
      setError(loadError?.message || 'Unable to load tasks')
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
    // Always bypass the old Task/Data Package cache on first entry or date/outlet change.
    load(true)
  }, [date, load, outletId])

  useEffect(() => {
    if (!outletId || selected) return undefined

    const syncWhenActive = () => {
      if (document.visibilityState !== 'visible') return
      const force = Date.now() - lastForcedAt.current >= 60_000
      load(force, { silent: true })
    }

    const interval = window.setInterval(() => load(false, { silent: true }), 45_000)
    window.addEventListener('focus', syncWhenActive)
    window.addEventListener('online', syncWhenActive)
    document.addEventListener('visibilitychange', syncWhenActive)
    return () => {
      window.clearInterval(interval)
      window.removeEventListener('focus', syncWhenActive)
      window.removeEventListener('online', syncWhenActive)
      document.removeEventListener('visibilitychange', syncWhenActive)
    }
  }, [load, outletId, selected])

  async function act(id, action, payload = {}) {
    const response = await opsClient.tasks.operationalAction({
      task_id: id,
      outlet_id: outletId,
      date,
      action,
      ...payload,
    })
    setData((current) => ({
      ...current,
      tasks: current.tasks.map((task) => task.id === id ? response.task : task),
    }))
    return response.task
  }

  const tasks = useMemo(() => (data.tasks || []).filter((task) => occurs(task, date)), [data.tasks, date])
  const chosen = tasks.find((task) => task.id === selected)
  const outlet = outlets.find((row) => String(row.id) === String(outletId))

  return (
    <div className="mx-auto max-w-lg space-y-4 p-4 pb-24">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold">今日任务</h1>
          <p className="text-xs text-muted-foreground">Daily Tasks · {outletLabel(outlet, outletId)}</p>
          {lastSyncedAt ? <p className="mt-1 text-[10px] text-muted-foreground">自动同步 {time(lastSyncedAt)}</p> : null}
        </div>
        <Button size="icon" variant="outline" onClick={() => load(true)} disabled={loading} aria-label="Refresh current tasks">
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
          <button
            key={value}
            type="button"
            onClick={() => setFilter(value)}
            className={`whitespace-nowrap rounded-full px-3 py-1.5 text-xs font-semibold ${filter === value ? 'bg-primary text-primary-foreground' : 'bg-muted'}`}
          >
            {label}
          </button>
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
        onOpenChange={(open) => !open && setSelected('')}
        title={chosen ? cn(chosen.config, 'title', chosen.title) : '任务'}
        subtitle={chosen ? en(chosen.config, 'title') : ''}
        heightClass="h-[94dvh]"
      >
        {chosen ? (
          <TaskForm
            task={chosen}
            outletId={outletId}
            outletName={outletLabel(outlet, outletId)}
            photos={(data.task_photos || []).filter((photo) => (
              photo.task_id === chosen.id
              && !photo.deleted_at
              && String(photo.status || 'active').toLowerCase() !== 'deleted'
            ))}
            onAct={async (action, payload) => {
              const updated = await act(chosen.id, action, payload)
              setSelected(updated.id)
            }}
            reload={() => load(false)}
            openSop={(id) => navigate(`/sop/${id}`)}
            error={setError}
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
        <span className={`flex h-10 w-10 items-center justify-center rounded-xl ${locked ? 'bg-muted' : 'bg-primary/15'}`}>
          {locked ? <Lock className="h-5 w-5" /> : <Clock className="h-5 w-5 text-primary" />}
        </span>
        <div className="min-w-0 flex-1">
          <b className="block text-sm">{cn(task.config, 'title', task.title)}</b>
          <span className="block text-xs text-muted-foreground">{en(task.config, 'title')}</span>
          <span className="mt-1 block text-[11px] text-muted-foreground">{time(task.opens_at)}–{time(task.due_at)} · {task.config?.estimated_minutes || 0} min</span>
        </div>
        <span className="rounded-full bg-muted px-2 py-1 text-[10px] font-semibold">{status(task)}</span>
      </div>
      <div className="mt-3 flex items-center gap-2">
        <div className="h-1.5 flex-1 rounded bg-muted">
          <div className="h-full rounded bg-primary" style={{ width: `${items.length ? done / items.length * 100 : 0}%` }} />
        </div>
        <span className="text-[11px]">{done}/{items.length}</span>
        <ChevronRight className="h-4 w-4" />
      </div>
    </button>
  )
}

function TaskForm({ task, outletId, outletName, photos, onAct, reload, openSop, error }) {
  const config = task.config || {}
  const groups = task.photo_requirements || config.photo_groups || []
  const input = useRef({})
  const [responses, setResponses] = useState(() => mapResponses(task))
  const [notes, setNotes] = useState(task.completion_notes || '')
  const [busy, setBusy] = useState(false)
  const [uploading, setUploading] = useState('')
  const [deleting, setDeleting] = useState('')
  const readonly = ['NOT_OPEN', 'LOCKED', 'DONE'].includes(String(task.access_state).toUpperCase())
  const sop = task.sop_id || config.sop_id

  useEffect(() => {
    setResponses(mapResponses(task))
    setNotes(task.completion_notes || '')
  }, [task.id, task.version, task.updated_date])

  const update = (id, patch) => setResponses((current) => ({
    ...current,
    [id]: {
      item_id: id,
      value: '',
      remark: '',
      corrective_action: '',
      ...(current[id] || {}),
      ...patch,
    },
  }))

  async function save(action) {
    setBusy(true)
    try {
      await onAct(action, { responses: Object.values(responses), completion_notes: notes })
    } catch (saveError) {
      error(saveError?.message || 'Unable to save task')
    } finally {
      setBusy(false)
    }
  }

  async function upload(group, file) {
    if (!file) return
    setUploading(group.id)
    try {
      const watermarked = await watermarkTaskPhoto(file, { capturedAt: new Date() })
      const uploaded = await opsClient.integrations.Core.UploadFile({
        file: watermarked.file,
        folderType: 'Task Evidence',
        outletName,
        outletId,
      })
      await opsClient.entities.TaskPhoto.create({
        outlet_id: outletId,
        task_id: task.id,
        template_id: task.template_id,
        photo_type: `checklist:${group.id}`,
        drive_file_id: uploaded.drive_file_id || '',
        file_name: uploaded.file_name || watermarked.file.name,
        file_url: uploaded.file_url || '',
        caption: cn(group, 'name'),
        status: 'active',
        mime_type: uploaded.mime_type || watermarked.file.type,
        file_size: Number(uploaded.file_size || watermarked.file.size),
        captured_at: watermarked.capturedAt,
        watermark_text: watermarked.watermarkText,
      }, { year: Number(task.due_date.slice(0, 4)) })
      await reload()
    } catch (uploadError) {
      error(uploadError?.message || 'Unable to upload photo')
    } finally {
      setUploading('')
      if (input.current[group.id]) input.current[group.id].value = ''
    }
  }

  async function removePhoto(photo) {
    if (!confirm('删除这张照片并重新拍摄？')) return
    setDeleting(photo.id)
    try {
      try {
        await opsClient.entities.TaskPhoto.delete(photo.id, { year: Number(task.due_date.slice(0, 4)) })
      } catch {
        await opsClient.entities.TaskPhoto.update(photo.id, { status: 'deleted' }, { year: Number(task.due_date.slice(0, 4)) })
      }
      await reload()
    } catch (deleteError) {
      error(deleteError?.message || '无法删除照片')
    } finally {
      setDeleting('')
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 space-y-4 overflow-auto p-4 pb-8">
        <div className="rounded-2xl border bg-muted/25 p-3">
          <b>{cn(config.schedule, 'shift_name')}</b>
          <p className="text-xs text-muted-foreground">开放 {time(task.opens_at)} · 截止 {time(task.due_at)}</p>
        </div>

        {cn(config, 'completion_standard') ? (
          <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-3">
            <b className="text-xs">完成标准</b>
            <p className="mt-1 text-sm leading-6">{cn(config, 'completion_standard')}</p>
          </div>
        ) : null}

        {sop ? (
          <button type="button" onClick={() => openSop(sop)} className="flex w-full items-center gap-3 rounded-2xl border p-3 text-left">
            <BookOpen className="h-5 w-5 text-primary" />
            <span className="flex-1">
              <b className="block text-sm">不确定怎样做？查看标准做法</b>
              <small className="text-muted-foreground">SOP guide</small>
            </span>
            <ChevronRight className="h-4 w-4" />
          </button>
        ) : null}

        {readonly && String(task.access_state).toUpperCase() !== 'DONE' ? (
          <div className="flex gap-2 rounded-xl bg-amber-50 p-3 text-sm"><AlertTriangle className="h-4 w-4" />任务未开放或已锁定。</div>
        ) : null}

        {(config.sections || []).map((section) => (
          <section key={section.id} className="space-y-2">
            <div>
              <b className="text-sm">{cn(section, 'name')}</b>
              <p className="text-[11px] text-muted-foreground">{en(section, 'name')}</p>
            </div>
            {(section.items || []).map((item) => (
              <Item
                key={item.id}
                item={item}
                response={responses[item.id] || { item_id: item.id, value: '' }}
                readonly={readonly}
                update={(patch) => update(item.id, patch)}
                standard={cn(config, 'completion_standard')}
              />
            ))}
          </section>
        ))}

        {groups.length ? (
          <section className="space-y-2">
            <div>
              <b className="text-sm">照片留证</b>
              <p className="text-[11px] text-muted-foreground">只在规则要求时拍摄。</p>
            </div>
            {groups.map((group) => {
              const rows = photos.filter((photo) => photo.photo_type === `checklist:${group.id}`)
              const required = String(group.rule).toUpperCase() === 'REQUIRED'
                || flat(task).filter((item) => item.photo_group_id === group.id).some((item) => result(item, responses[item.id]) === 'fail')
              const minimum = Number(group.min_photos || 1)
              const maximum = Number(group.max_photos || 1)
              return (
                <div key={group.id} className="rounded-2xl border p-3">
                  <div className="flex justify-between gap-2">
                    <div>
                      <b className="text-sm">{cn(group, 'name')}</b>
                      <p className="text-xs text-muted-foreground">{cn(group, 'sample_caption')}</p>
                    </div>
                    <small className="whitespace-nowrap">
                      {required
                        ? rows.length < minimum
                          ? `还需 ${minimum - rows.length} 张`
                          : `已完成 · ${rows.length}/${maximum} 张`
                        : `异常时拍 · ${rows.length}/${maximum} 张`}
                    </small>
                  </div>

                  {rows.length ? (
                    <div className="mt-2 grid grid-cols-2 gap-2">
                      {rows.map((photo) => (
                        <div key={photo.id} className="relative">
                          <TaskEvidenceImage photo={photo} />
                          {!readonly ? (
                            <button
                              type="button"
                              disabled={deleting === photo.id}
                              onClick={() => removePhoto(photo)}
                              className="absolute right-1 top-1 rounded-full bg-black/70 p-2 text-white disabled:opacity-60"
                              aria-label="Delete photo"
                            >
                              {deleting === photo.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <Trash2 className="h-3 w-3" />}
                            </button>
                          ) : null}
                        </div>
                      ))}
                    </div>
                  ) : null}

                  {!readonly ? (
                    <>
                      <Button
                        size="sm"
                        variant="outline"
                        className="mt-2"
                        disabled={uploading === group.id || rows.length >= maximum}
                        onClick={() => input.current[group.id]?.click()}
                      >
                        {uploading === group.id ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Camera className="mr-1 h-4 w-4" />}
                        {rows.length ? `加拍照片 ${rows.length}/${maximum}` : '拍照'}
                      </Button>
                      <input
                        ref={(node) => { input.current[group.id] = node }}
                        type="file"
                        accept="image/*"
                        capture="environment"
                        className="hidden"
                        onChange={(event) => upload(group, event.target.files?.[0])}
                      />
                    </>
                  ) : null}
                </div>
              )
            })}
          </section>
        ) : null}

        <Textarea rows={3} value={notes} disabled={readonly} onChange={(event) => setNotes(event.target.value)} placeholder="异常或交接备注（选填）" />
      </div>

      {!readonly ? (
        <div className="grid grid-cols-2 gap-2 border-t bg-background p-4">
          <Button variant="outline" onClick={() => save('save')} disabled={busy}>保存进度</Button>
          <Button onClick={() => save('complete')} disabled={busy}><CheckCircle2 className="mr-1 h-4 w-4" />完成任务</Button>
        </div>
      ) : null}
    </div>
  )
}

function Item({ item, response, readonly, update, standard }) {
  const failed = result(item, response) === 'fail'
  const type = String(item.response_type || '').toUpperCase()
  const options = item.options || []
  return (
    <div className={`rounded-2xl border p-3 ${failed ? 'border-rose-300 bg-rose-50' : 'bg-card'}`}>
      <div className="flex gap-2">
        <span className={`flex h-6 w-6 items-center justify-center rounded-full border ${result(item, response) === 'pass' ? 'bg-emerald-500 text-white' : ''}`}>
          {result(item, response) === 'pass' ? <Check className="h-4 w-4" /> : null}
        </span>
        <div className="flex-1">
          <b className="block text-sm">{cn(item, 'name')}</b>
          <small className="text-muted-foreground">{en(item, 'name')}</small>
        </div>
      </div>

      <div className="mt-3">
        {type === 'TEXT' ? (
          <Textarea rows={3} disabled={readonly} value={response.value || ''} onChange={(event) => update({ value: event.target.value })} placeholder={cn(item, 'placeholder', '填写数量与状态说明')} />
        ) : type === 'CHECKBOX' ? (
          <button
            type="button"
            disabled={readonly}
            onClick={() => update({ value: response.value === 'Done' ? '' : 'Done' })}
            className={`w-full rounded-xl border p-2.5 text-sm font-semibold ${response.value === 'Done' ? 'border-emerald-500 bg-emerald-50' : ''}`}
          >
            {response.value === 'Done' ? '✓ 已完成 / Done' : '完成这一项 / Mark done'}
          </button>
        ) : (
          <div className={`grid gap-2 ${options.length > 2 ? 'grid-cols-3' : 'grid-cols-2'}`}>
            {options.map((option) => (
              <button
                key={option}
                type="button"
                disabled={readonly}
                onClick={() => update({ value: option })}
                className={`rounded-xl border p-2 text-xs font-semibold ${response.value === option ? (item.fail_values || []).includes(option) ? 'border-rose-500 bg-rose-50' : 'border-primary bg-primary/10' : ''}`}
              >
                {option}
              </button>
            ))}
          </div>
        )}
      </div>

      {(cn(item, 'instruction') || standard) ? (
        <details className="mt-2 rounded-xl bg-muted/30 p-2">
          <summary className="flex cursor-pointer list-none justify-between text-xs font-semibold">查看简单说明<ChevronDown className="h-4 w-4" /></summary>
          <p className="mt-2 text-xs leading-5">{cn(item, 'instruction')}</p>
          <p className="mt-2 text-xs"><b>及格：</b>{cn(item, 'completion_standard') || standard}</p>
        </details>
      ) : null}

      {failed ? (
        <div className="mt-2 space-y-2">
          <Input value={response.remark || ''} onChange={(event) => update({ remark: event.target.value })} placeholder="异常说明" />
          <Textarea rows={2} value={response.corrective_action || ''} onChange={(event) => update({ corrective_action: event.target.value })} placeholder="怎样处理／已通知谁" />
        </div>
      ) : null}
    </div>
  )
}
