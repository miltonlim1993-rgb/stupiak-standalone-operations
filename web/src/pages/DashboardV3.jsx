import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { AlertTriangle, CheckCircle2, ChevronRight, ClipboardCheck, Clock3, Lock, Moon, Sunrise } from 'lucide-react'

import { opsClient } from '@/api/opsClient'
import { useAuth } from '@/lib/AuthContext'
import { todayStr } from '@/lib/ops-helpers'
import { parseOutletIds } from '@/lib/outlets'
import { normalizeTaskWorkflowShiftView } from '@/lib/task-shift-view-v3'
import Dashboard from '@/pages/Dashboard'

function shiftMeta(shiftId) {
  const id = String(shiftId || 'ALL').toUpperCase()
  if (id === 'MORNING') return { label: 'Morning Shift', Icon: Sunrise }
  if (id === 'NIGHT') return { label: 'Evening Shift', Icon: Moon }
  return { label: 'Today’s Tasks', Icon: ClipboardCheck }
}

function metric(value, label, Icon, warning = false) {
  return { value: Number(value || 0), label, Icon, warning }
}

export default function DashboardV3() {
  const { user } = useAuth()
  const outletId = String(user?.outlet_id || parseOutletIds(user)[0] || '')
  const [taskData, setTaskData] = useState(null)

  useEffect(() => {
    let cancelled = false
    if (!outletId) return undefined

    opsClient.tasks.workflowBootstrap({
      outletId,
      date: todayStr(),
      refresh: false,
    })
      .then((result) => {
        if (!cancelled) setTaskData(normalizeTaskWorkflowShiftView(result))
      })
      .catch(() => {
        if (!cancelled) setTaskData(null)
      })

    return () => {
      cancelled = true
    }
  }, [outletId])

  const currentShift = String(taskData?.current_shift_id || 'ALL').toUpperCase()
  const summary = taskData?.progress?.[currentShift] || taskData?.progress?.ALL || null
  const meta = shiftMeta(currentShift)
  const progress = summary?.total
    ? Math.round((Number(summary.completed || 0) / Number(summary.total)) * 100)
    : 0

  const metrics = useMemo(() => summary ? [
    metric(summary.completed, 'Completed', CheckCircle2),
    metric(
      Number(summary.pending || 0) + Number(summary.in_progress || 0),
      'Pending',
      Clock3,
    ),
    metric(summary.locked, 'Locked', Lock),
    metric(
      Number(summary.issue || 0) + Number(summary.overdue || 0),
      'Issues / Overdue',
      AlertTriangle,
      true,
    ),
  ] : [], [summary])

  return (
    <div className="dashboard-v3-shell w-full">
      {summary ? (
        <section className="mx-auto w-full max-w-[1180px] px-3 pt-3 sm:px-6 sm:pt-4">
          <Link
            to="/tasks"
            className="block rounded-3xl border border-primary/20 bg-card p-4 shadow-sm transition active:scale-[0.995] hover:border-primary/40"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="flex min-w-0 items-center gap-3">
                <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-primary/15 text-primary">
                  <meta.Icon className="h-5 w-5" />
                </span>

                <div className="min-w-0">
                  <p className="font-semibold leading-tight">{meta.label}</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {summary.completed || 0} of {summary.total || 0} completed
                  </p>
                </div>
              </div>

              <div className="flex shrink-0 items-center gap-2">
                <span className="text-xl font-bold tabular-nums">{progress}%</span>
                <ChevronRight className="h-4 w-4 text-muted-foreground" />
              </div>
            </div>

            <div className="mt-3 h-2 overflow-hidden rounded-full bg-muted">
              <div
                className="h-full rounded-full bg-primary transition-all"
                style={{ width: `${progress}%` }}
              />
            </div>

            <div className="mt-3 grid grid-cols-4 gap-2">
              {metrics.map((item) => (
                <div
                  key={item.label}
                  className={`flex min-h-[72px] min-w-0 flex-col items-center justify-center rounded-2xl px-1.5 py-2 text-center ${
                    item.warning && item.value
                      ? 'bg-rose-50 text-rose-800 dark:bg-rose-950/40 dark:text-rose-200'
                      : 'bg-muted/60'
                  }`}
                  title={item.label}
                >
                  <item.Icon className="h-3.5 w-3.5 shrink-0" />
                  <p className="mt-1 text-base font-bold tabular-nums">{item.value}</p>
                  <p className="whitespace-normal text-[9px] leading-[1.15] sm:text-[10px]">{item.label}</p>
                </div>
              ))}
            </div>
          </Link>
        </section>
      ) : null}

      <Dashboard />
    </div>
  )
}
