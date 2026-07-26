import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { AlertTriangle, CheckCircle2, ChevronRight, ClipboardCheck, Clock3, Lock, Moon, Sunrise } from 'lucide-react'

import { opsClient } from '@/api/opsClient'
import { useAuth } from '@/lib/AuthContext'
import { todayStr } from '@/lib/ops-helpers'
import { parseOutletIds } from '@/lib/outlets'
import Dashboard from '@/pages/Dashboard'

function shiftMeta(shiftId) {
  const id = String(shiftId || 'ALL').toUpperCase()
  if (id === 'MORNING') return { cn: '早班', en: 'Morning Shift', Icon: Sunrise }
  if (id === 'NIGHT') return { cn: '晚班', en: 'Evening Shift', Icon: Moon }
  return { cn: '今日任务', en: 'Today’s Tasks', Icon: ClipboardCheck }
}

function metric(value, cn, en, Icon, warning = false) {
  return { value: Number(value || 0), cn, en, Icon, warning }
}

export default function DashboardV3() {
  const { user } = useAuth()
  const outletId = String(user?.outlet_id || parseOutletIds(user)[0] || '')
  const [taskData, setTaskData] = useState(null)

  useEffect(() => {
    let cancelled = false
    if (!outletId) return undefined
    opsClient.tasks.workflowBootstrap({ outletId, date: todayStr(), refresh: false })
      .then((result) => { if (!cancelled) setTaskData(result) })
      .catch(() => { if (!cancelled) setTaskData(null) })
    return () => { cancelled = true }
  }, [outletId])

  const currentShift = String(taskData?.current_shift_id || 'ALL').toUpperCase()
  const summary = taskData?.progress?.[currentShift] || taskData?.progress?.ALL || null
  const meta = shiftMeta(currentShift)
  const progress = summary?.total ? Math.round((Number(summary.completed || 0) / Number(summary.total)) * 100) : 0

  const metrics = useMemo(() => summary ? [
    metric(summary.completed, '已完成', 'Completed', CheckCircle2),
    metric(Number(summary.pending || 0) + Number(summary.in_progress || 0), '待完成', 'Pending', Clock3),
    metric(summary.locked, '未开放', 'Locked', Lock),
    metric(Number(summary.issue || 0) + Number(summary.overdue || 0), '异常／逾期', 'Issues / Overdue', AlertTriangle, true),
  ] : [], [summary])

  return (
    <>
      {summary ? (
        <section className="mx-auto w-full max-w-7xl px-4 pt-4 sm:px-6">
          <Link to="/tasks" className="block rounded-2xl border border-primary/20 bg-card p-4 shadow-sm transition hover:border-primary/40">
            <div className="flex items-start justify-between gap-3">
              <div className="flex min-w-0 items-center gap-3">
                <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-primary/15 text-primary"><meta.Icon className="h-5 w-5" /></span>
                <div className="min-w-0">
                  <p className="font-semibold">{meta.cn} <span className="text-sm font-medium text-muted-foreground">{meta.en}</span></p>
                  <p className="mt-0.5 text-xs text-muted-foreground">已完成 {summary.completed || 0} / {summary.total || 0} · Completed</p>
                </div>
              </div>
              <div className="flex items-center gap-2"><span className="text-xl font-bold">{progress}%</span><ChevronRight className="h-4 w-4 text-muted-foreground" /></div>
            </div>
            <div className="mt-3 h-2 overflow-hidden rounded-full bg-muted"><div className="h-full rounded-full bg-primary" style={{ width: `${progress}%` }} /></div>
            <div className="mt-3 grid grid-cols-4 gap-2">
              {metrics.map((item) => (
                <div key={item.en} className={`rounded-xl p-2 text-center ${item.warning && item.value ? 'bg-rose-50 text-rose-800' : 'bg-muted/60'}`}>
                  <item.Icon className="mx-auto h-3.5 w-3.5" />
                  <p className="mt-1 text-base font-bold">{item.value}</p>
                  <p className="truncate text-[9px]">{item.cn}</p>
                  <p className="truncate text-[8px] opacity-70">{item.en}</p>
                </div>
              ))}
            </div>
          </Link>
        </section>
      ) : null}
      <Dashboard />
    </>
  )
}
