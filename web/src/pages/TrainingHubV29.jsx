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

export default function TrainingHubV29() {
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
    <div data-training-hub="ops-compact-v29" className="min-h-full bg-slate-50 pb-24 md:px-5 md:pb-10 xl:px-6">
      <div className="mx-auto max-w-[1500px] px-4 pt-4 md:px-0 md:pt-5">
        <header className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
          <div>
            <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-amber-600">Learning &amp; work standards</p>
            <h1 className="mt-1 text-2xl font-bold tracking-tight text-slate-950">SOP &amp; Training</h1>
            <p className="mt-1 max-w-2xl text-sm leading-5 text-slate-500">完成入职课程，并按岗位逐步学习当前有效的 SOP。</p>
          </div>
          <div className="flex flex-wrap gap-2">
            {canManage ? (
              <Button variant="outline" className="h-9 border-slate-200 bg-white px-3 text-xs font-semibold" onClick={() => navigate('/training/manage')}>
                <UserRoundCheck className="mr-2 h-4 w-4" /> 管理培训
              </Button>
            ) : null}
            <Button className="h-9 bg-[#f7b500] px-3 text-xs font-semibold text-black hover:bg-[#e9aa00]" onClick={() => navigate('/training/manage')}>
              完整课程 <ArrowRight className="ml-2 h-4 w-4" />
            </Button>
          </div>
        </header>

        <section className="mt-4 grid grid-cols-3 gap-2 md:gap-3">
          <StatCard icon={GraduationCap} value={learningCourses.length} label="我的课程 / Courses" />
          <StatCard icon={CheckCircle2} value={completedCourses} label="已完成 / Completed" />
          <StatCard icon={ShieldCheck} value={myAcknowledgements.length} label="已阅读 SOP / Read" />
        </section>

        <section className="mt-4 rounded-xl border border-slate-200 bg-white p-2 shadow-sm">
          <div className="grid gap-2 md:grid-cols-[auto_minmax(260px,1fr)] md:items-center">
            <div className="grid grid-cols-2 rounded-lg bg-slate-100 p-1">
              <button type="button" onClick={() => setTab('path')} className={`rounded-md px-3 py-2 text-xs font-semibold transition ${tab === 'path' ? 'bg-white text-slate-950 shadow-sm' : 'text-slate-500 hover:text-slate-800'}`}>
                入职与培训
              </button>
              <button type="button" onClick={() => setTab('sops')} className={`rounded-md px-3 py-2 text-xs font-semibold transition ${tab === 'sops' ? 'bg-white text-slate-950 shadow-sm' : 'text-slate-500 hover:text-slate-800'}`}>
                SOP Library
              </button>
            </div>
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
              <Input value={search} onChange={(event) => setSearch(event.target.value)} className="h-10 border-slate-200 bg-white pl-9 text-sm" placeholder={tab === 'sops' ? '搜索岗位、SOP code 或名称' : '搜索课程'} />
            </div>
          </div>
        </section>

        {error ? <div className="mt-4 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</div> : null}
        {loading ? <div className="flex min-h-[40dvh] items-center justify-center"><Loader2 className="h-6 w-6 animate-spin text-slate-500" /></div> : null}

        {!loading && tab === 'path' ? (
          <section className="py-5">
            <SectionHeading icon={ClipboardCheck} title="入职与岗位培训" description="先完成基础课程，再进入对应岗位 SOP。" />
            {filteredCourses.length ? (
              <div className="mt-3 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                {filteredCourses.map((course, index) => (
                  <CourseCard key={course.id} course={course} index={index} progress={progressFor(course.id)} onOpen={() => openCourse(course)} />
                ))}
              </div>
            ) : <EmptyState text="目前没有分配给这个账号的培训课程。" />}
          </section>
        ) : null}

        {!loading && tab === 'sops' ? (
          <section className="space-y-6 py-5">
            <SectionHeading icon={BookOpen} title="岗位 SOP" description="按岗位选择标准；进入后才使用完整的品牌化逐步学习界面。" />
            {Object.keys(groupedSops).length ? Object.entries(groupedSops).map(([station, rows]) => (
              <div key={station}>
                <div className="mb-3 flex items-center justify-between border-b border-slate-200 pb-2">
                  <h2 className="text-sm font-semibold text-slate-900">{station}</h2>
                  <span className="rounded-full bg-slate-100 px-2.5 py-1 text-[10px] font-semibold text-slate-600">{rows.length} SOP</span>
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
    <div className="flex min-w-0 items-center gap-2 rounded-xl border border-slate-200 bg-white p-3 shadow-sm md:gap-3">
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-amber-50 text-amber-700"><Icon className="h-4 w-4" /></span>
      <div className="min-w-0">
        <p className="text-lg font-bold leading-none text-slate-950 md:text-xl">{value}</p>
        <p className="mt-1 truncate text-[9px] font-medium text-slate-500 md:text-xs">{label}</p>
      </div>
    </div>
  )
}

function SectionHeading({ icon: Icon, title, description }) {
  return (
    <div className="flex items-center gap-3">
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-amber-50 text-amber-700"><Icon className="h-4 w-4" /></span>
      <div>
        <h2 className="text-base font-semibold text-slate-950">{title}</h2>
        <p className="mt-0.5 text-xs text-slate-500 md:text-sm">{description}</p>
      </div>
    </div>
  )
}

function CourseCard({ course, index, progress, onOpen }) {
  const pct = courseProgress(progress)
  return (
    <button type="button" onClick={onOpen} className="group rounded-xl border border-slate-200 bg-white p-4 text-left shadow-sm transition hover:border-amber-300 hover:shadow-md focus:outline-none focus:ring-2 focus:ring-amber-300">
      <div className="flex items-center justify-between gap-3">
        <span className="rounded-md bg-amber-50 px-2 py-1 text-[10px] font-bold text-amber-700">MODULE {String(index + 1).padStart(2, '0')}</span>
        <span className="text-xs font-semibold text-slate-500">{pct}%</span>
      </div>
      <h3 className="mt-3 line-clamp-2 text-sm font-semibold leading-5 text-slate-950 md:text-base">{course.title}</h3>
      <p className="mt-1 line-clamp-2 text-xs leading-5 text-slate-500">{course.description || 'Training module'}</p>
      <div className="mt-4 h-1.5 overflow-hidden rounded-full bg-slate-100"><div className="h-full rounded-full bg-[#f7b500]" style={{ width: `${pct}%` }} /></div>
      <div className="mt-3 flex items-center justify-between text-xs text-slate-500"><span>{course.estimated_minutes || 0} min</span><span className="flex items-center font-semibold text-slate-800">开始学习 <ChevronRight className="ml-1 h-4 w-4" /></span></div>
    </button>
  )
}

function SopCard({ sop, read, onOpen }) {
  return (
    <button type="button" onClick={onOpen} className="group flex min-h-[128px] flex-col rounded-xl border border-slate-200 bg-white p-4 text-left shadow-sm transition hover:border-amber-300 hover:shadow-md focus:outline-none focus:ring-2 focus:ring-amber-300">
      <div className="flex items-start justify-between gap-3">
        <span className="rounded-md bg-slate-100 px-2 py-1 text-[10px] font-bold uppercase tracking-wide text-slate-700">{sop.sop_code}</span>
        {read ? <CheckCircle2 className="h-5 w-5 text-emerald-600" /> : <LayoutGrid className="h-5 w-5 text-slate-300" />}
      </div>
      <h3 className="mt-3 line-clamp-2 text-sm font-semibold leading-5 text-slate-950 md:text-base">{sop.title}</h3>
      <p className="mt-1 line-clamp-2 text-xs leading-5 text-slate-500">{sop.summary || `${stationLabel(sop)} · Version ${sop.version_label || '-'}`}</p>
      <div className="mt-auto flex items-center justify-between border-t border-slate-100 pt-3 text-xs text-slate-500"><span>Version {sop.version_label || '-'}</span><span className="flex items-center font-semibold text-slate-800">逐步阅读 <ChevronRight className="ml-1 h-4 w-4" /></span></div>
    </button>
  )
}

function EmptyState({ text }) {
  return <div className="mt-4 rounded-xl border border-dashed border-slate-300 bg-white p-8 text-center text-sm text-slate-500">{text}</div>
}
