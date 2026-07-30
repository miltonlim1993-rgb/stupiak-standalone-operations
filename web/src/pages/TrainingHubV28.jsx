import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { opsClient } from '@/api/opsClient'
import { useAuth } from '@/lib/AuthContext'
import { parseOutletIds } from '@/lib/outlets'
import { ROLE_LEVEL } from '@/lib/ops-helpers'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  ArrowRight,
  BookOpen,
  CheckCircle2,
  ChevronRight,
  ClipboardCheck,
  GraduationCap,
  LayoutGrid,
  Loader2,
  Search,
  ShieldCheck,
  Sparkles,
  UserRoundCheck,
} from 'lucide-react'

const truthy = (value) => value === true || String(value).toLowerCase() === 'true'
const csv = (value) => String(value || '').split(',').map((item) => item.trim()).filter(Boolean)

function courseProgress(progress) {
  return Math.max(0, Math.min(100, Number(progress?.progress_percent || 0)))
}

function stationLabel(sop) {
  return String(sop?.station || sop?.category || 'General / 通用').trim() || 'General / 通用'
}

export default function TrainingHubV28() {
  const { user } = useAuth()
  const navigate = useNavigate()
  const outletIds = parseOutletIds(user)
  const canManage = (ROLE_LEVEL[user?.role] || 0) >= ROLE_LEVEL.manager
  const [tab, setTab] = useState('path')
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [data, setData] = useState({
    courses: [], lessons: [], sops: [], assignments: [], progress: [], acknowledgements: [],
  })

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError('')
    Promise.all([
      opsClient.entities.TrainingCourse.list('category,title', 1000),
      opsClient.entities.TrainingLesson.list('course_id,lesson_order', 3000),
      opsClient.entities.SOP.list('category,station,sop_code', 1000),
      opsClient.entities.TrainingAssignment.list('due_date', 3000),
      opsClient.entities.TrainingProgress.list('updated_at', 3000),
      opsClient.entities.TrainingAcknowledgement.list('acknowledged_at', 3000),
    ]).then(([courses, lessons, sops, assignments, progress, acknowledgements]) => {
      if (!cancelled) setData({ courses, lessons, sops, assignments, progress, acknowledgements })
    }).catch((err) => {
      if (!cancelled) setError(err.message || 'Unable to load training')
    }).finally(() => {
      if (!cancelled) setLoading(false)
    })
    return () => { cancelled = true }
  }, [])

  const visibleCourses = useMemo(() => (data.courses || []).filter((course) => {
    if (!truthy(course.active)) return false
    const targets = csv(course.target_outlet_ids)
    const roles = csv(course.required_roles)
    const outletOk = !targets.length || outletIds.some((id) => targets.includes(id))
    const roleOk = canManage || !roles.length || roles.includes(user?.role)
    return outletOk && roleOk
  }), [data.courses, outletIds.join(','), user?.role, canManage])

  const visibleSops = useMemo(() => (data.sops || []).filter((sop) => {
    if (!truthy(sop.active)) return false
    const targets = csv(sop.outlet_ids)
    const roles = csv(sop.required_roles)
    const outletOk = !targets.length || outletIds.some((id) => targets.includes(id))
    const roleOk = canManage || !roles.length || roles.includes(user?.role)
    return outletOk && roleOk
  }), [data.sops, outletIds.join(','), user?.role, canManage])

  const email = String(user?.email || '').toLowerCase()
  const myAssignments = (data.assignments || []).filter((row) => String(row.user_email || '').toLowerCase() === email)
  const myProgress = (data.progress || []).filter((row) => String(row.user_email || '').toLowerCase() === email)
  const myAcknowledgements = (data.acknowledgements || []).filter((row) => String(row.user_email || '').toLowerCase() === email)
  const assignedIds = new Set(myAssignments.map((row) => String(row.course_id)))
  const myCourses = visibleCourses.filter((course) => assignedIds.has(String(course.id)) || truthy(course.required))
  const learningCourses = myCourses.length ? myCourses : visibleCourses
  const completedCourses = myProgress.filter((row) => String(row.status).toLowerCase() === 'completed').length
  const query = search.trim().toLowerCase()

  const filteredCourses = learningCourses.filter((course) => !query || `${course.title} ${course.description} ${course.category}`.toLowerCase().includes(query))
  const filteredSops = visibleSops.filter((sop) => !query || `${sop.sop_code} ${sop.title} ${sop.summary} ${sop.station} ${sop.category}`.toLowerCase().includes(query))
  const groupedSops = filteredSops.reduce((groups, sop) => {
    const key = stationLabel(sop)
    if (!groups[key]) groups[key] = []
    groups[key].push(sop)
    return groups
  }, {})

  function progressFor(courseId) {
    return myProgress.find((row) => String(row.course_id) === String(courseId))
  }

  function openCourse(course) {
    const lessons = (data.lessons || [])
      .filter((row) => String(row.course_id) === String(course.id) && truthy(row.active))
      .sort((a, b) => Number(a.lesson_order || 0) - Number(b.lesson_order || 0))
    const firstSop = lessons.find((lesson) => String(lesson.sop_id || '').trim())
    if (firstSop?.sop_id) navigate(`/sop/${firstSop.sop_id}`)
    else navigate('/training/manage')
  }

  return (
    <div data-training-hub="onboarding-responsive-v28" className="min-h-full bg-[#f4efe3] pb-24 md:px-4 md:pb-10 xl:px-6">
      <div className="mx-auto max-w-[1500px]">
        <section className="overflow-hidden border-b-2 border-black bg-[#f7b500] md:mt-3 md:rounded-3xl md:border-2">
          <div className="h-2 bg-black" />
          <div className="grid gap-5 px-4 py-5 md:grid-cols-[minmax(0,1fr)_auto] md:px-7 md:py-7">
            <div className="max-w-3xl">
              <div className="flex items-center gap-2 text-[10px] font-black uppercase tracking-[0.18em] text-black">
                <Sparkles className="h-4 w-4" /> Stupiak's Learning Path
              </div>
              <h1 className="mt-2 text-2xl font-black leading-tight text-black md:text-4xl">培训中心 / Training</h1>
              <p className="mt-2 max-w-2xl text-sm font-medium leading-6 text-black/75 md:text-base">
                从入职基础开始，再进入岗位 SOP。每次只学习一个清楚步骤，不需要放大整张海报。
              </p>
            </div>
            <div className="flex items-end gap-2">
              <Button className="h-11 border-2 border-black bg-black px-4 font-bold text-white hover:bg-black/85" onClick={() => navigate('/training/manage')}>
                完整课程 <ArrowRight className="ml-2 h-4 w-4" />
              </Button>
            </div>
          </div>
        </section>

        <section className="grid grid-cols-3 gap-2 px-3 py-3 md:grid-cols-3 md:gap-4 md:px-0 md:py-4">
          <StatCard icon={GraduationCap} value={learningCourses.length} label="我的课程 / Courses" />
          <StatCard icon={CheckCircle2} value={completedCourses} label="已完成 / Completed" />
          <StatCard icon={ShieldCheck} value={myAcknowledgements.length} label="已阅读 SOP / Read" />
        </section>

        <div className="sticky top-0 z-30 border-y-2 border-black bg-[#f4efe3]/95 px-3 py-3 backdrop-blur md:top-2 md:rounded-2xl md:border-2 md:px-4">
          <div className="grid gap-2 md:grid-cols-[auto_minmax(280px,1fr)_auto] md:items-center">
            <div className="grid grid-cols-2 rounded-xl border-2 border-black bg-white p-1">
              <button type="button" onClick={() => setTab('path')} className={`rounded-lg px-4 py-2 text-xs font-black ${tab === 'path' ? 'bg-black text-white' : 'text-black'}`}>
                入职与培训
              </button>
              <button type="button" onClick={() => setTab('sops')} className={`rounded-lg px-4 py-2 text-xs font-black ${tab === 'sops' ? 'bg-black text-white' : 'text-black'}`}>
                SOP Library
              </button>
            </div>
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-black/50" />
              <Input value={search} onChange={(event) => setSearch(event.target.value)} className="h-11 border-2 border-black bg-white pl-9" placeholder={tab === 'sops' ? '搜索岗位、SOP code 或名称' : '搜索课程'} />
            </div>
            {canManage ? (
              <Button variant="outline" className="hidden h-11 border-2 border-black bg-white font-bold md:flex" onClick={() => navigate('/training/manage')}>
                <UserRoundCheck className="mr-2 h-4 w-4" /> 管理培训
              </Button>
            ) : null}
          </div>
        </div>

        {error ? <div className="mx-3 mt-4 rounded-2xl border-2 border-red-500 bg-red-50 p-4 text-sm text-red-800 md:mx-0">{error}</div> : null}
        {loading ? <div className="flex min-h-[45dvh] items-center justify-center"><Loader2 className="h-7 w-7 animate-spin" /></div> : null}

        {!loading && tab === 'path' ? (
          <section className="px-3 py-4 md:px-0">
            <SectionHeading icon={ClipboardCheck} eyebrow="START HERE" title="入职与岗位培训" description="先完成基础课程，再跟随对应岗位的 SOP 实际操作。" />
            {filteredCourses.length ? (
              <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                {filteredCourses.map((course, index) => (
                  <CourseCard key={course.id} course={course} index={index} progress={progressFor(course.id)} onOpen={() => openCourse(course)} />
                ))}
              </div>
            ) : <EmptyState text="目前没有分配给这个账号的培训课程。" />}
          </section>
        ) : null}

        {!loading && tab === 'sops' ? (
          <section className="space-y-6 px-3 py-4 md:px-0">
            <SectionHeading icon={BookOpen} eyebrow="WORK STANDARD" title="岗位 SOP" description="选择岗位后逐步阅读；手机、Tablet 与 Desktop 使用不同的学习布局。" />
            {Object.keys(groupedSops).length ? Object.entries(groupedSops).map(([station, rows]) => (
              <div key={station}>
                <div className="mb-3 flex items-center justify-between border-b-2 border-black pb-2">
                  <h2 className="text-base font-black text-black">{station}</h2>
                  <span className="rounded-full bg-black px-2.5 py-1 text-[10px] font-bold text-white">{rows.length} SOP</span>
                </div>
                <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                  {rows.map((sop) => {
                    const read = myAcknowledgements.some((row) => String(row.sop_id) === String(sop.id) && String(row.acknowledged_version) === String(sop.version_label))
                    return <SopCard key={sop.id} sop={sop} read={read} onOpen={() => navigate(`/sop/${sop.id}`)} />
                  })}
                </div>
              </div>
            )) : <EmptyState text="找不到符合条件的 SOP。" />}
          </section>
        ) : null}
      </div>
    </div>
  )
}

function StatCard({ icon: Icon, value, label }) {
  return (
    <div className="rounded-2xl border-2 border-black bg-white p-3 md:p-4">
      <Icon className="h-4 w-4 text-black" />
      <p className="mt-2 text-xl font-black text-black md:text-2xl">{value}</p>
      <p className="mt-0.5 text-[9px] font-bold leading-4 text-black/55 md:text-xs">{label}</p>
    </div>
  )
}

function SectionHeading({ icon: Icon, eyebrow, title, description }) {
  return (
    <div className="flex items-start gap-3">
      <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border-2 border-black bg-[#f7b500]"><Icon className="h-5 w-5" /></span>
      <div><p className="text-[10px] font-black tracking-[0.18em] text-black/55">{eyebrow}</p><h2 className="text-xl font-black text-black md:text-2xl">{title}</h2><p className="mt-1 text-sm text-black/60">{description}</p></div>
    </div>
  )
}

function CourseCard({ course, index, progress, onOpen }) {
  const pct = courseProgress(progress)
  return (
    <button type="button" onClick={onOpen} className="group overflow-hidden rounded-2xl border-2 border-black bg-white text-left shadow-[4px_4px_0_#111] transition-transform active:translate-x-1 active:translate-y-1 active:shadow-none">
      <div className="flex items-center justify-between border-b-2 border-black bg-[#f7b500] px-4 py-3">
        <span className="text-xs font-black text-black">MODULE {String(index + 1).padStart(2, '0')}</span>
        <span className="rounded-full bg-black px-2.5 py-1 text-[10px] font-bold text-white">{pct}%</span>
      </div>
      <div className="p-4">
        <h3 className="text-base font-black leading-5 text-black">{course.title}</h3>
        <p className="mt-2 line-clamp-3 text-sm leading-5 text-black/60">{course.description || 'Training module'}</p>
        <div className="mt-4 h-2 overflow-hidden rounded-full border border-black bg-white"><div className="h-full bg-black" style={{ width: `${pct}%` }} /></div>
        <div className="mt-3 flex items-center justify-between text-xs font-bold text-black"><span>{course.estimated_minutes || 0} min</span><span className="flex items-center">开始学习 <ChevronRight className="ml-1 h-4 w-4" /></span></div>
      </div>
    </button>
  )
}

function SopCard({ sop, read, onOpen }) {
  return (
    <button type="button" onClick={onOpen} className="group flex min-h-[150px] flex-col rounded-2xl border-2 border-black bg-white p-4 text-left shadow-[4px_4px_0_#111] transition-transform active:translate-x-1 active:translate-y-1 active:shadow-none">
      <div className="flex items-start justify-between gap-3">
        <span className="rounded-full bg-black px-2.5 py-1 text-[10px] font-black uppercase tracking-wide text-white">{sop.sop_code}</span>
        {read ? <CheckCircle2 className="h-5 w-5 text-emerald-600" /> : <LayoutGrid className="h-5 w-5 text-black/40" />}
      </div>
      <h3 className="mt-4 text-base font-black leading-5 text-black">{sop.title}</h3>
      <p className="mt-2 line-clamp-2 text-xs leading-5 text-black/55">{sop.summary || `${stationLabel(sop)} · Version ${sop.version_label || '-'}`}</p>
      <div className="mt-auto flex items-center justify-between border-t border-black/15 pt-3 text-xs font-bold text-black"><span>Version {sop.version_label || '-'}</span><span className="flex items-center">逐步阅读 <ChevronRight className="ml-1 h-4 w-4" /></span></div>
    </button>
  )
}

function EmptyState({ text }) {
  return <div className="mt-5 rounded-2xl border-2 border-dashed border-black/30 bg-white/60 p-10 text-center text-sm font-medium text-black/55">{text}</div>
}
