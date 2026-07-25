import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { opsClient } from '@/api/opsClient'
import { useAuth } from '@/lib/AuthContext'
import { parseOutletIds } from '@/lib/outlets'
import { ROLE_LEVEL } from '@/lib/ops-helpers'
import AppDrawer from '@/components/AppDrawer'
import MediaLightbox from '@/components/MediaLightbox'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Award,
  BookOpen,
  CheckCircle2,
  ChevronRight,
  FileText,
  GraduationCap,
  Loader2,
  Maximize2,
  PlayCircle,
  Search,
  ShieldCheck,
  Upload,
  UsersRound,
} from 'lucide-react'

const TABS = ['my', 'sops', 'team']

function csv(value) {
  return String(value || '').split(',').map((item) => item.trim()).filter(Boolean)
}

function truthy(value) {
  return value === true || String(value).toLowerCase() === 'true'
}

function assetTypeForFile(file) {
  const mime = String(file?.type || '').toLowerCase()
  const name = String(file?.name || '').toLowerCase()
  if (mime.startsWith('image/') || /\.(png|jpe?g|webp|gif|heic|heif|avif)$/.test(name)) return 'image'
  if (mime.startsWith('video/') || /\.(mp4|m4v|mov|webm|ogv|ogg)$/.test(name)) return 'video'
  return 'document'
}

function humanStatus(value) {
  return String(value || 'not_started').replaceAll('_', ' ').replace(/\b\w/g, (m) => m.toUpperCase())
}

function dueLabel(value) {
  if (!value) return ''
  const date = new Date(`${String(value).slice(0, 10)}T00:00:00`)
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
}

export default function Training() {
  const { user } = useAuth()
  const navigate = useNavigate()
  const { sopId } = useParams()
  const canManage = (ROLE_LEVEL[user?.role] || 0) >= ROLE_LEVEL.manager
  const [tab, setTab] = useState('my')
  const [search, setSearch] = useState('')
  const [data, setData] = useState({
    courses: [], lessons: [], sops: [], steps: [], assets: [], assignments: [],
    progress: [], acknowledgements: [], quizzes: [], questions: [], users: [], outlets: [],
  })
  const [selectedCourse, setSelectedCourse] = useState(null)
  const [selectedSop, setSelectedSop] = useState(null)
  const [assignOpen, setAssignOpen] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  async function load() {
    setLoading(true)
    setError('')
    try {
      const requests = [
        opsClient.entities.TrainingCourse.list('category,title', 1000),
        opsClient.entities.TrainingLesson.list('course_id,lesson_order', 3000),
        opsClient.entities.SOP.list('category,sop_code', 1000),
        opsClient.entities.SOPStep.list('sop_id,step_order', 3000),
        opsClient.entities.SOPAsset.list('sop_id,step_id,display_order', 3000),
        opsClient.entities.TrainingAssignment.list('due_date', 3000),
        opsClient.entities.TrainingProgress.list('updated_at', 3000),
        opsClient.entities.TrainingAcknowledgement.list('acknowledged_at', 3000),
        opsClient.entities.TrainingQuiz.list('course_id', 1000),
        opsClient.entities.TrainingQuestion.list('quiz_id,question_order', 3000),
        canManage ? opsClient.entities.User.list('full_name', 1000).catch(() => []) : Promise.resolve([]),
        opsClient.entities.Outlet.list('name', 100).catch(() => []),
      ]
      const [courses, lessons, sops, steps, assets, assignments, progress, acknowledgements, quizzes, questions, users, outlets] = await Promise.all(requests)
      const next = { courses, lessons, sops, steps, assets, assignments, progress, acknowledgements, quizzes, questions, users, outlets }
      setData(next)
      if (sopId) setSelectedSop((sops || []).find((row) => row.id === sopId) || null)
    } catch (err) {
      setError(err.message || 'Unable to load training')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [sopId])

  const outletIds = parseOutletIds(user)
  const visibleCourses = useMemo(() => (data.courses || []).filter((course) => {
    if (!truthy(course.active)) return false
    const targets = csv(course.target_outlet_ids)
    const roles = csv(course.required_roles)
    const outletOk = !targets.length || outletIds.some((id) => targets.includes(id))
    const roleOk = canManage || !roles.length || roles.includes(user?.role)
    return outletOk && roleOk
  }), [data.courses, outletIds.join(','), user?.role])

  const visibleSops = useMemo(() => (data.sops || []).filter((sop) => {
    if (!truthy(sop.active)) return false
    const targets = csv(sop.outlet_ids)
    const roles = csv(sop.required_roles)
    const outletOk = !targets.length || outletIds.some((id) => targets.includes(id))
    const roleOk = canManage || !roles.length || roles.includes(user?.role)
    return outletOk && roleOk
  }), [data.sops, outletIds.join(','), user?.role])

  const myAssignments = useMemo(() => (data.assignments || []).filter((row) => String(row.user_email || '').toLowerCase() === String(user?.email || '').toLowerCase()), [data.assignments, user?.email])
  const myProgress = useMemo(() => (data.progress || []).filter((row) => String(row.user_email || '').toLowerCase() === String(user?.email || '').toLowerCase()), [data.progress, user?.email])
  const myAcks = useMemo(() => (data.acknowledgements || []).filter((row) => String(row.user_email || '').toLowerCase() === String(user?.email || '').toLowerCase()), [data.acknowledgements, user?.email])

  const assignedCourseIds = new Set(myAssignments.map((row) => row.course_id))
  const myCourses = visibleCourses.filter((course) => assignedCourseIds.has(course.id) || truthy(course.required))
  const completed = myProgress.filter((row) => row.status === 'completed').length
  const acknowledged = myAcks.length

  function progressFor(courseId, email = user?.email) {
    return (data.progress || []).find((row) => row.course_id === courseId && String(row.user_email || '').toLowerCase() === String(email || '').toLowerCase())
  }

  function assignmentFor(courseId, email = user?.email) {
    return (data.assignments || []).find((row) => row.course_id === courseId && String(row.user_email || '').toLowerCase() === String(email || '').toLowerCase())
  }

  const query = search.trim().toLowerCase()
  const searchedCourses = myCourses.filter((course) => !query || `${course.title} ${course.description} ${course.category}`.toLowerCase().includes(query))
  const searchedSops = visibleSops.filter((sop) => !query || `${sop.sop_code} ${sop.title} ${sop.summary} ${sop.station}`.toLowerCase().includes(query))

  return (
    <div className="chefops-page training-page mx-auto max-w-lg space-y-4 p-4 pb-24">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-heading font-bold">SOP & Training</h1>
          <p className="mt-0.5 text-xs text-muted-foreground">Read standards, complete courses and acknowledge the current SOP version.</p>
        </div>
        {canManage && <Button size="sm" variant="outline" onClick={() => setAssignOpen(true)}><UsersRound className="mr-1 h-4 w-4" /> Assign</Button>}
      </div>

      <div className="grid grid-cols-3 gap-2">
        <Kpi icon={GraduationCap} label="Courses" value={myCourses.length} />
        <Kpi icon={Award} label="Completed" value={completed} />
        <Kpi icon={ShieldCheck} label="SOP Read" value={acknowledged} />
      </div>

      <div className="chefops-sticky-tools chefops-training-toolbar space-y-2.5">
        <div className="flex rounded-xl bg-muted p-1">
          {TABS.filter((value) => value !== 'team' || canManage).map((value) => (
            <button key={value} type="button" onClick={() => setTab(value)} className={`flex-1 rounded-lg px-2 py-2 text-xs font-semibold ${tab === value ? 'bg-background shadow-sm' : 'text-muted-foreground'}`}>
              {value === 'my' ? 'My Training' : value === 'sops' ? 'SOP Library' : 'Team'}
            </button>
          ))}
        </div>

        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder={tab === 'sops' ? 'Search SOP code, title or station' : 'Search courses'} className="pl-9" />
        </div>
      </div>

      {error && <div className="rounded-xl border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</div>}
      {loading ? <div className="flex justify-center py-12"><Loader2 className="h-6 w-6 animate-spin" /></div> : null}

      {!loading && tab === 'my' && (
        <div className="space-y-3">
          {searchedCourses.length ? searchedCourses.map((course) => {
            const progress = progressFor(course.id)
            const assignment = assignmentFor(course.id)
            return <CourseCard key={course.id} course={course} progress={progress} assignment={assignment} onClick={() => setSelectedCourse(course)} />
          }) : <Empty text="No courses assigned or required for this profile." />}
        </div>
      )}

      {!loading && tab === 'sops' && (
        <div className="space-y-3">
          {searchedSops.length ? searchedSops.map((sop) => {
            const read = myAcks.some((row) => row.sop_id === sop.id && String(row.acknowledged_version) === String(sop.version_label))
            return <SopCard key={sop.id} sop={sop} read={read} onClick={() => { setSelectedSop(sop); navigate(`/sop/${sop.id}`) }} />
          }) : <Empty text="No SOP matches this search." />}
        </div>
      )}

      {!loading && tab === 'team' && canManage && (
        <TeamProgress assignments={data.assignments || []} progress={data.progress || []} courses={data.courses || []} />
      )}

      <AppDrawer open={Boolean(selectedCourse)} onOpenChange={(open) => !open && setSelectedCourse(null)} title={selectedCourse?.title || 'Course'} subtitle={selectedCourse?.category || ''} heightClass="h-[92dvh]">
        {selectedCourse && <CourseDrawer course={selectedCourse} data={data} user={user} onChanged={load} />}
      </AppDrawer>

      <AppDrawer open={Boolean(selectedSop)} onOpenChange={(open) => { if (!open) { setSelectedSop(null); if (sopId) navigate('/training') } }} title={selectedSop?.sop_code || 'SOP'} subtitle={selectedSop?.title || ''} fullScreen>
        {selectedSop && <SopDrawer sop={selectedSop} data={data} user={user} canManage={canManage} acknowledgements={myAcks} onChanged={load} />}
      </AppDrawer>

      <AppDrawer open={assignOpen} onOpenChange={setAssignOpen} title="Assign training" subtitle="Assign a course to a user and outlet." heightClass="h-auto max-h-[88dvh]">
        <AssignmentForm data={data} user={user} onDone={() => { setAssignOpen(false); load() }} />
      </AppDrawer>
    </div>
  )
}

function Kpi({ icon: Icon, label, value }) {
  return <div className="rounded-xl border bg-card p-3"><Icon className="mb-2 h-4 w-4 text-primary" /><p className="text-lg font-bold">{value}</p><p className="text-[10px] text-muted-foreground">{label}</p></div>
}

function CourseCard({ course, progress, assignment, onClick }) {
  const pct = Math.max(0, Math.min(100, Number(progress?.progress_percent || 0)))
  return (
    <button type="button" onClick={onClick} className="w-full rounded-2xl border bg-card p-4 text-left active:scale-[0.99]">
      <div className="flex items-start gap-3">
        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-primary/15"><GraduationCap className="h-5 w-5 text-primary" /></span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-semibold">{course.title}</span>
          <span className="mt-1 block text-xs leading-5 text-muted-foreground">{course.description}</span>
        </span>
        <ChevronRight className="mt-1 h-4 w-4 text-muted-foreground" />
      </div>
      <div className="mt-3 h-2 overflow-hidden rounded-full bg-muted"><div className="h-full rounded-full bg-primary" style={{ width: `${pct}%` }} /></div>
      <div className="mt-2 flex items-center justify-between text-[11px] text-muted-foreground">
        <span>{pct}% · {humanStatus(progress?.status)}</span>
        <span>{assignment?.due_date ? `Due ${dueLabel(assignment.due_date)}` : `${course.estimated_minutes || 0} min`}</span>
      </div>
    </button>
  )
}

function SopCard({ sop, read, onClick }) {
  return (
    <button type="button" onClick={onClick} className="flex w-full items-start gap-3 rounded-2xl border bg-card p-4 text-left active:scale-[0.99]">
      <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-muted"><FileText className="h-5 w-5" /></span>
      <span className="min-w-0 flex-1"><span className="text-[10px] font-semibold uppercase tracking-wide text-primary">{sop.sop_code}</span><span className="mt-0.5 block text-sm font-semibold">{sop.title}</span><span className="mt-1 block text-xs text-muted-foreground">{sop.station} · Version {sop.version_label}</span></span>
      {read ? <CheckCircle2 className="mt-1 h-5 w-5 text-emerald-500" /> : <ChevronRight className="mt-1 h-4 w-4 text-muted-foreground" />}
    </button>
  )
}

function CourseDrawer({ course, data, user, onChanged }) {
  const lessons = (data.lessons || []).filter((row) => row.course_id === course.id && truthy(row.active)).sort((a, b) => Number(a.lesson_order) - Number(b.lesson_order))
  const assignment = (data.assignments || []).find((row) => row.course_id === course.id && String(row.user_email).toLowerCase() === String(user.email).toLowerCase())
  const progress = (data.progress || []).find((row) => row.course_id === course.id && String(row.user_email).toLowerCase() === String(user.email).toLowerCase())
  const [activeLesson, setActiveLesson] = useState(() => lessons.find((row) => row.id === progress?.current_lesson_id) || lessons[0] || null)
  const [saving, setSaving] = useState(false)
  const [answers, setAnswers] = useState({})
  const [result, setResult] = useState(null)
  const quiz = (data.quizzes || []).find((row) => row.course_id === course.id && truthy(row.active))
  const questions = (data.questions || []).filter((row) => row.quiz_id === quiz?.id && truthy(row.active)).sort((a, b) => Number(a.question_order) - Number(b.question_order))

  async function saveProgress(percent, lessonId, score = progress?.score || 0) {
    const status = percent >= 100 ? 'completed' : 'in_progress'
    const payload = {
      assignment_id: assignment?.id || '', course_id: course.id, user_email: user.email,
      user_name: user.full_name || user.email, outlet_id: assignment?.outlet_id || user.outlet_id || parseOutletIds(user)[0] || '',
      progress_percent: percent, current_lesson_id: lessonId || '', status,
      completed_at: status === 'completed' ? new Date().toISOString() : '', score: Number(score || 0),
    }
    if (progress?.id) await opsClient.entities.TrainingProgress.update(progress.id, payload)
    else await opsClient.entities.TrainingProgress.create(payload)
    if (assignment?.id && assignment.status !== status) {
      await opsClient.entities.TrainingAssignment.update(assignment.id, { status })
    }
  }

  async function completeLesson() {
    if (!activeLesson) return
    setSaving(true)
    try {
      const index = lessons.findIndex((row) => row.id === activeLesson.id)
      const percent = Math.round(((index + 1) / Math.max(1, lessons.length)) * 100)
      await saveProgress(percent, activeLesson.id)
      const next = lessons[index + 1]
      if (next) setActiveLesson(next)
      await onChanged()
    } finally { setSaving(false) }
  }

  async function submitQuiz() {
    if (!quiz || !questions.length) return
    const correct = questions.filter((question) => String(answers[question.id] || '') === String(question.correct_answer || '')).length
    const score = Math.round((correct / questions.length) * 100)
    const passed = score >= Number(quiz.passing_score || course.passing_score || 80)
    setSaving(true)
    try {
      await opsClient.entities.TrainingAttempt.create({
        quiz_id: quiz.id, course_id: course.id, user_email: user.email,
        user_name: user.full_name || user.email, outlet_id: assignment?.outlet_id || user.outlet_id || parseOutletIds(user)[0] || '',
        score, passed, answers_json: JSON.stringify(answers), started_at: new Date().toISOString(),
      })
      setResult({ score, passed })
      if (passed) await saveProgress(100, activeLesson?.id || '', score)
      await onChanged()
    } finally { setSaving(false) }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4 pb-6">
        <div className="rounded-2xl border bg-muted/30 p-4"><p className="text-sm leading-6">{course.description}</p><div className="mt-3 flex gap-2 text-xs text-muted-foreground"><span>{course.estimated_minutes || 0} min</span><span>·</span><span>Pass {course.passing_score || 80}%</span></div></div>
        <div className="space-y-2">
          {lessons.map((lesson) => <button key={lesson.id} type="button" onClick={() => { setActiveLesson(lesson); setResult(null) }} className={`flex w-full items-center gap-3 rounded-xl border p-3 text-left ${activeLesson?.id === lesson.id ? 'border-primary bg-primary/10' : 'bg-card'}`}><span className="flex h-8 w-8 items-center justify-center rounded-lg bg-muted text-xs font-bold">{lesson.lesson_order}</span><span className="min-w-0 flex-1"><span className="block text-sm font-semibold">{lesson.title}</span><span className="text-[11px] text-muted-foreground">{lesson.lesson_type} · {lesson.estimated_minutes || 0} min</span></span></button>)}
        </div>

        {activeLesson?.lesson_type === 'sop' && <LinkedSopLesson lesson={activeLesson} data={data} />}
        {activeLesson?.lesson_type === 'text' && <div className="rounded-xl border bg-card p-4 text-sm leading-6 whitespace-pre-wrap">{activeLesson.content}</div>}
        {activeLesson?.lesson_type === 'video' && activeLesson.video_url && <video src={activeLesson.video_url} controls className="w-full rounded-xl border" />}
        {activeLesson?.lesson_type === 'quiz' && (
          <div className="space-y-4">
            {questions.map((question) => {
              let options = []
              try { options = JSON.parse(question.options_json || '[]') } catch { options = [] }
              return <div key={question.id} className="rounded-xl border bg-card p-4"><p className="text-sm font-semibold">{question.question_order}. {question.question}</p><div className="mt-3 space-y-2">{options.map((option) => <label key={option} className="flex items-center gap-3 rounded-lg border px-3 py-2 text-sm"><input type="radio" name={question.id} checked={answers[question.id] === option} onChange={() => setAnswers((current) => ({ ...current, [question.id]: option }))} />{option}</label>)}</div></div>
            })}
            {result && <div className={`rounded-xl p-3 text-sm font-semibold ${result.passed ? 'bg-emerald-100 text-emerald-800' : 'bg-red-100 text-red-800'}`}>{result.score}% · {result.passed ? 'Passed' : 'Not passed'}</div>}
            <Button className="w-full" onClick={submitQuiz} disabled={saving || questions.some((q) => !answers[q.id])}>{saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />} Submit quiz</Button>
          </div>
        )}
      </div>
      {activeLesson && activeLesson.lesson_type !== 'quiz' && <div className="border-t bg-background p-4 pb-[calc(1rem+env(safe-area-inset-bottom))]"><Button className="w-full" onClick={completeLesson} disabled={saving}>{saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />} Complete lesson</Button></div>}
    </div>
  )
}

function assetsForStep(data, sopId, stepId) {
  return (data.assets || [])
    .filter((row) => row.sop_id === sopId && row.step_id === stepId && truthy(row.active))
    .sort((a, b) => Number(a.display_order || 0) - Number(b.display_order || 0))
}

function generalAssets(data, sopId) {
  return (data.assets || [])
    .filter((row) => row.sop_id === sopId && !String(row.step_id || '').trim() && truthy(row.active))
    .sort((a, b) => Number(a.display_order || 0) - Number(b.display_order || 0))
}

function LinkedSopLesson({ lesson, data }) {
  const sop = (data.sops || []).find((row) => row.id === lesson.sop_id)
  const steps = (data.steps || [])
    .filter((row) => row.sop_id === lesson.sop_id && truthy(row.active))
    .sort((a, b) => Number(a.step_order) - Number(b.step_order))
  const attachments = generalAssets(data, lesson.sop_id)

  if (!sop) return <Empty text="Linked SOP was not found." />

  return <div className="space-y-4">
    <div className="rounded-2xl border bg-card p-4">
      <p className="text-xs font-semibold text-primary">{sop.sop_code}</p>
      <h3 className="text-base font-bold">{sop.title}</h3>
      <p className="mt-1 text-sm leading-6 text-muted-foreground">{sop.summary}</p>
    </div>

    <div className="space-y-4">
      {steps.map((step) => <SopStepCard key={step.id} step={step} assets={assetsForStep(data, sop.id, step.id)} />)}
    </div>

    {attachments.length ? <GeneralAttachments assets={attachments} /> : null}
  </div>
}

function SopDrawer({ sop, data, user, canManage, acknowledgements, onChanged }) {
  const steps = (data.steps || [])
    .filter((row) => row.sop_id === sop.id && truthy(row.active))
    .sort((a, b) => Number(a.step_order) - Number(b.step_order))
  const assets = (data.assets || [])
    .filter((row) => row.sop_id === sop.id && truthy(row.active))
    .sort((a, b) => Number(a.display_order || 0) - Number(b.display_order || 0))
  const attachments = assets.filter((row) => !String(row.step_id || '').trim())
  const acknowledged = acknowledgements.some((row) => row.sop_id === sop.id && String(row.acknowledged_version) === String(sop.version_label))
  const [saving, setSaving] = useState(false)
  const [uploadStepId, setUploadStepId] = useState('')
  const inputRef = useRef(null)

  async function acknowledge() {
    setSaving(true)
    try {
      await opsClient.entities.TrainingAcknowledgement.create({
        sop_id: sop.id,
        user_email: user.email,
        user_name: user.full_name || user.email,
        outlet_id: user.outlet_id || parseOutletIds(user)[0] || '',
        acknowledged_version: sop.version_label,
        status: 'acknowledged',
      })
      await onChanged()
    } finally {
      setSaving(false)
    }
  }

  async function uploadAsset(file) {
    if (!file) return
    setSaving(true)
    try {
      const uploaded = await opsClient.integrations.Core.UploadFile({
        file,
        folderType: 'Training Assets',
        outletName: 'Training',
      })
      const assetType = assetTypeForFile(file)
      const stepAssets = assets.filter((row) => String(row.step_id || '') === String(uploadStepId || ''))
      await opsClient.entities.SOPAsset.create({
        sop_id: sop.id,
        lesson_id: '',
        step_id: uploadStepId,
        asset_type: assetType,
        display_order: stepAssets.length + 1,
        drive_file_id: uploaded.drive_file_id || '',
        file_name: uploaded.file_name || file.name,
        file_url: uploaded.file_url || '',
        caption: file.name,
        thumbnail_url: '',
        active: true,
      })
      if (inputRef.current) inputRef.current.value = ''
      await onChanged()
    } finally {
      setSaving(false)
    }
  }

  return <div className="flex min-h-0 flex-1 flex-col">
    <div className="min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain p-4 pb-8">
      <div className="rounded-2xl border bg-muted/30 p-4">
        <p className="text-sm font-semibold">{sop.summary}</p>
        <dl className="mt-3 grid grid-cols-2 gap-3 text-xs">
          <div><dt className="text-muted-foreground">Station</dt><dd className="font-medium">{sop.station}</dd></div>
          <div><dt className="text-muted-foreground">Version</dt><dd className="font-medium">{sop.version_label}</dd></div>
          <div><dt className="text-muted-foreground">Effective</dt><dd className="font-medium">{dueLabel(sop.effective_date)}</dd></div>
          <div><dt className="text-muted-foreground">Review</dt><dd className="font-medium">{dueLabel(sop.review_date)}</dd></div>
        </dl>
      </div>

      {sop.purpose ? <Info title="Purpose" text={sop.purpose} /> : null}
      {sop.scope ? <Info title="Scope" text={sop.scope} /> : null}
      {sop.safety_notes ? <div className="rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900"><strong>Safety:</strong> {sop.safety_notes}</div> : null}

      <div className="space-y-4">
        <div>
          <h3 className="font-semibold">Procedure</h3>
          <p className="mt-1 text-xs text-muted-foreground">Each reference image is shown directly under the step it belongs to.</p>
        </div>
        {steps.map((step) => <SopStepCard key={step.id} step={step} assets={assetsForStep(data, sop.id, step.id)} />)}
      </div>

      {attachments.length ? <GeneralAttachments assets={attachments} /> : null}

      {canManage ? <div className="rounded-2xl border border-dashed bg-muted/20 p-3">
        <Label>Attach to</Label>
        <select className="mt-2 h-10 w-full rounded-md border bg-background px-3 text-sm" value={uploadStepId} onChange={(event) => setUploadStepId(event.target.value)}>
          <option value="">General SOP attachment</option>
          {steps.map((step) => <option key={step.id} value={step.id}>Step {step.step_order}: {step.step_title}</option>)}
        </select>
        <button type="button" onClick={() => inputRef.current?.click()} className="mt-3 flex w-full items-center justify-center gap-2 rounded-xl border border-dashed bg-background p-3 text-sm font-medium">
          <Upload className="h-4 w-4" />
          Upload image, video or PDF
        </button>
        <input ref={inputRef} className="hidden" type="file" accept="image/*,video/*,.pdf" onChange={(event) => uploadAsset(event.target.files?.[0])} />
      </div> : null}
    </div>

    <div className="shrink-0 border-t bg-background p-4 pb-[calc(1rem+env(safe-area-inset-bottom))]">
      {acknowledged
        ? <div className="flex items-center justify-center gap-2 rounded-xl bg-emerald-100 p-3 text-sm font-semibold text-emerald-800"><CheckCircle2 className="h-5 w-5" /> Version {sop.version_label} acknowledged</div>
        : <Button className="w-full" onClick={acknowledge} disabled={saving}>{saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null} I have read and understood</Button>}
    </div>
  </div>
}

function SopStepCard({ step, assets = [] }) {
  return <article className="overflow-hidden rounded-2xl border bg-card shadow-sm">
    <div className="p-4">
      <div className="flex items-start gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary text-sm font-bold text-primary-foreground">{step.step_order}</span>
        <div className="min-w-0 flex-1">
          {step.section_title ? <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{step.section_title}</p> : null}
          <h4 className="text-base font-semibold leading-6">{step.step_title}</h4>
        </div>
      </div>

      <div className="mt-4 space-y-3">
        {step.instruction ? <StepInfo label="Rule" text={step.instruction} /> : null}
        {step.warning ? <StepInfo label="Warning" text={step.warning} tone="warning" /> : null}
        {step.quality_check ? <StepInfo label="Check standard" text={step.quality_check} tone="quality" /> : null}
      </div>
    </div>

    {assets.length ? <div className="border-t bg-muted/20 p-3">
      <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Reference for this step</p>
      <div className="sop-step-assets">{assets.map((asset) => <AssetTile key={asset.id} asset={asset} />)}</div>
    </div> : null}
  </article>
}

function StepInfo({ label, text, tone = 'default' }) {
  const style = tone === 'warning'
    ? 'border-red-200 bg-red-50 text-red-800'
    : tone === 'quality'
      ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
      : 'border-border bg-muted/30 text-foreground'
  return <div className={`rounded-xl border p-3 ${style}`}>
    <p className="text-[11px] font-bold uppercase tracking-wide opacity-75">{label}</p>
    <p className="mt-1 whitespace-pre-wrap text-sm leading-6">{text}</p>
  </div>
}

function GeneralAttachments({ assets }) {
  return <div className="space-y-2">
    <div>
      <h3 className="font-semibold">General attachments</h3>
      <p className="mt-1 text-xs text-muted-foreground">Files without a step_id remain here. Step-linked images are not duplicated.</p>
    </div>
    <div className="sop-general-assets">{assets.map((asset) => <AssetTile key={asset.id} asset={asset} />)}</div>
  </div>
}

function AssetTile({ asset }) {
  const [open, setOpen] = useState(false)
  const mediaUrl = String(asset.file_url || '')
  const assetType = String(asset.asset_type || '').trim().toLowerCase()
  const title = asset.caption || asset.file_name || (assetType === 'video' ? 'SOP video' : 'SOP reference image')

  if (assetType === 'image') {
    const previewUrl = asset.thumbnail_url || mediaUrl
    return <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="sop-asset-tile group min-w-0 overflow-hidden rounded-xl border bg-background text-left"
        aria-label={`Open ${title} full screen`}
      >
        <span className="sop-asset-media-frame relative flex w-full items-center justify-center overflow-hidden bg-muted/30">
          <img src={previewUrl} alt={title} loading="lazy" className="sop-asset-image block w-full object-contain transition duration-200 group-hover:scale-[1.01]" />
          <span className="absolute right-2 top-2 inline-flex items-center gap-1 rounded-full bg-black/70 px-2 py-1 text-[10px] font-semibold text-white shadow">
            <Maximize2 className="h-3.5 w-3.5" />
            Enlarge
          </span>
        </span>
        <span className="block break-words p-2 text-[11px] leading-4">{title}</span>
      </button>
      <MediaLightbox open={open} onOpenChange={setOpen} src={mediaUrl} title={title} type="image" />
    </>
  }

  if (assetType === 'video') {
    return <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="sop-asset-tile group min-w-0 overflow-hidden rounded-xl border bg-background text-left"
        aria-label={`Play ${title}`}
      >
        <span className="sop-asset-media-frame relative flex w-full items-center justify-center overflow-hidden bg-black">
          {asset.thumbnail_url
            ? <img src={asset.thumbnail_url} alt="" loading="lazy" className="sop-asset-image block w-full object-cover opacity-80" />
            : <span className="flex min-h-[180px] w-full bg-gradient-to-br from-zinc-950 to-zinc-800" />}
          <span className="absolute inset-0 flex items-center justify-center"><span className="flex h-14 w-14 items-center justify-center rounded-full bg-black/65 text-white shadow-xl"><PlayCircle className="h-8 w-8" /></span></span>
          <span className="absolute right-2 top-2 rounded-full bg-black/70 px-2 py-1 text-[10px] font-semibold text-white">Video SOP</span>
        </span>
        <span className="block break-words p-2 text-[11px] leading-4">{title}</span>
      </button>
      <MediaLightbox open={open} onOpenChange={setOpen} src={mediaUrl} poster={asset.thumbnail_url || ''} title={title} type="video" />
    </>
  }

  return <a href={asset.file_url} target="_blank" rel="noreferrer" className="sop-asset-tile flex min-w-0 items-center gap-2 rounded-xl border bg-background p-3 text-sm"><FileText className="h-4 w-4 shrink-0" /><span className="break-words">{title}</span></a>
}

function Info({ title, text }) {
  return <div className="rounded-xl border bg-card p-4"><h3 className="text-sm font-semibold">{title}</h3><p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-muted-foreground">{text}</p></div>
}

function AssignmentForm({ data, user, onDone }) {
  const assignedOutlets = parseOutletIds(user)
  const eligibleUsers = (data.users || []).filter((row) => row.status === 'active' && parseOutletIds(row).some((id) => assignedOutlets.includes(id)))
  const [courseId, setCourseId] = useState(data.courses?.[0]?.id || '')
  const [email, setEmail] = useState(eligibleUsers[0]?.email || '')
  const targetUser = eligibleUsers.find((row) => row.email === email)
  const allowedTargetOutlets = assignedOutlets.filter((id) => parseOutletIds(targetUser).includes(id))
  const [outletId, setOutletId] = useState(allowedTargetOutlets[0] || '')
  const [dueDate, setDueDate] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!allowedTargetOutlets.includes(outletId)) setOutletId(allowedTargetOutlets[0] || '')
  }, [email, allowedTargetOutlets.join(',')])

  async function submit(event) {
    event.preventDefault()
    const target = eligibleUsers.find((row) => row.email === email)
    if (!courseId || !target || !outletId) return
    setSaving(true)
    setError('')
    try {
      const existing = (data.assignments || []).find((row) => row.course_id === courseId && String(row.user_email).toLowerCase() === email.toLowerCase() && row.status !== 'completed')
      if (existing) throw new Error('This user already has an active assignment for the course.')
      await opsClient.entities.TrainingAssignment.create({ course_id: courseId, user_email: email, user_name: target.full_name || email, outlet_id: outletId, due_date: dueDate, status: 'assigned', required: true })
      onDone()
    } catch (err) {
      setError(err.message || 'Unable to assign course')
    } finally {
      setSaving(false)
    }
  }

  return <form onSubmit={submit} className="space-y-4 p-4 pb-[calc(1rem+env(safe-area-inset-bottom))]"><div className="space-y-1.5"><Label>Course</Label><select className="h-10 w-full rounded-md border bg-background px-3 text-sm" value={courseId} onChange={(e) => setCourseId(e.target.value)}>{(data.courses || []).filter((row) => truthy(row.active)).map((row) => <option key={row.id} value={row.id}>{row.title}</option>)}</select></div><div className="space-y-1.5"><Label>User</Label><select className="h-10 w-full rounded-md border bg-background px-3 text-sm" value={email} onChange={(e) => setEmail(e.target.value)}>{eligibleUsers.map((row) => <option key={row.email} value={row.email}>{row.full_name || row.email} · {row.email}</option>)}</select></div><div className="space-y-1.5"><Label>Outlet</Label><select className="h-10 w-full rounded-md border bg-background px-3 text-sm" value={outletId} onChange={(e) => setOutletId(e.target.value)}>{(data.outlets || []).filter((row) => allowedTargetOutlets.includes(row.id)).map((row) => <option key={row.id} value={row.id}>{row.name || row.id}</option>)}</select></div><div className="space-y-1.5"><Label>Due date</Label><Input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} /></div>{!eligibleUsers.length && <p className="text-sm text-muted-foreground">No active user shares one of your assigned outlets.</p>}{error && <p className="text-sm text-destructive">{error}</p>}<Button className="w-full" type="submit" disabled={saving || !eligibleUsers.length || !outletId}>{saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />} Assign course</Button></form>
}

function TeamProgress({ assignments, progress, courses }) {
  const courseMap = new Map(courses.map((row) => [row.id, row.title]))
  return <div className="space-y-2">{assignments.length ? assignments.map((assignment) => { const row = progress.find((item) => item.assignment_id === assignment.id || (item.course_id === assignment.course_id && item.user_email === assignment.user_email)); return <div key={assignment.id} className="rounded-xl border bg-card p-3"><div className="flex items-start justify-between gap-3"><div><p className="text-sm font-semibold">{assignment.user_name || assignment.user_email}</p><p className="text-xs text-muted-foreground">{courseMap.get(assignment.course_id) || assignment.course_id}</p></div><span className="text-xs font-semibold">{Number(row?.progress_percent || 0)}%</span></div><div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted"><div className="h-full bg-primary" style={{ width: `${Number(row?.progress_percent || 0)}%` }} /></div></div> }) : <Empty text="No training assignments yet." />}</div>
}

function Empty({ text }) { return <div className="rounded-2xl border border-dashed py-10 text-center"><BookOpen className="mx-auto mb-2 h-8 w-8 text-muted-foreground" /><p className="text-sm text-muted-foreground">{text}</p></div> }
