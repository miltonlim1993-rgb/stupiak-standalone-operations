import { useEffect, useMemo, useState } from 'react'
import { opsClient } from '@/api/opsClient'
import { todayStr, ROLE_LEVEL } from '@/lib/ops-helpers'
import { useAuth } from '@/lib/AuthContext'
import { exportOperationsWorkbook } from '@/lib/excel-reports'
import { parseOutletIds, outletFilter, outletLabel } from '@/lib/outlets'
import {
  BarChart3, Camera, Check, FileSpreadsheet, GraduationCap,
  Loader2, Package, SlidersHorizontal, Store, UsersRound,
} from 'lucide-react'
import { Label } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
import MobileSheet from '@/components/MobileSheet'

const REPORTS = [
  {
    key: 'full', label: 'Operations Workbook', icon: FileSpreadsheet,
    description: 'Order-first stock, outlet and staff scores, tasks with photo evidence, training, SOP reads and activity.',
  },
  {
    key: 'performance', label: 'Outlet & Staff Performance', icon: BarChart3,
    description: 'Completion rate, points, penalties and net score by outlet, employee and day.',
  },
  {
    key: 'stock', label: 'Stock & Order Report', icon: Package,
    description: 'The first sheet follows the weekly Order Page layout and shows items that need ordering.',
  },
  {
    key: 'tasks', label: 'Task & Photo Report', icon: Camera,
    description: 'Task status, who completed it, sample photos, evidence photos and completion notes.',
  },
  {
    key: 'training', label: 'Training & SOP Report', icon: GraduationCap,
    description: 'Who read each SOP, course progress, quiz score, pass/fail and learning duration.',
  },
]

export default function Reports() {
  const { user } = useAuth()
  const [fromDate, setFromDate] = useState(todayStr())
  const [toDate, setToDate] = useState(todayStr())
  const [outlets, setOutlets] = useState([])
  const [selectedOutletIds, setSelectedOutletIds] = useState(() => parseOutletIds(user))
  const [outletDrawerOpen, setOutletDrawerOpen] = useState(false)
  const [generating, setGenerating] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    opsClient.entities.Outlet.list('name', 200)
      .then((rows) => {
        const all = rows || []
        const assigned = parseOutletIds(user)
        const managerView = ['manager', 'owner'].includes(String(user?.role || ''))
        const visible = managerView ? all : all.filter((row) => assigned.includes(String(row.id)))
        setOutlets(visible)
        setSelectedOutletIds((current) => {
          const valid = current.filter((id) => visible.some((row) => String(row.id) === String(id)))
          return valid.length ? valid : visible.map((row) => String(row.id)).slice(0, 1)
        })
      })
      .catch(() => setOutlets([]))
  }, [user])

  const selectedOutlets = useMemo(
    () => outlets.filter((row) => selectedOutletIds.includes(String(row.id))),
    [outlets, selectedOutletIds],
  )

  const outletSummary = useMemo(() => {
    if (!selectedOutlets.length) return 'No outlet selected'
    if (selectedOutlets.length === 1) return outletLabel(selectedOutlets[0], selectedOutlets[0].id)
    return `${selectedOutlets.length} outlets selected`
  }, [selectedOutlets])

  function toggleOutlet(id) {
    const value = String(id)
    setSelectedOutletIds((current) => current.includes(value)
      ? current.filter((entry) => entry !== value)
      : [...current, value])
  }

  async function generate(type) {
    if (!selectedOutletIds.length) { setError('Select at least one outlet.'); setOutletDrawerOpen(true); return }
    if (toDate < fromDate) { setError('To date must be on or after From date.'); return }
    setGenerating(type)
    setError('')
    try {
      const year = Number(String(fromDate).slice(0, 4))
      const filter = outletFilter(selectedOutletIds)
      const needsTasks = ['full', 'tasks', 'performance'].includes(type)
      const needsStock = ['full', 'stock'].includes(type)
      const needsTraining = ['full', 'training'].includes(type)
      const canReadUsers = (ROLE_LEVEL[user?.role] || 0) >= ROLE_LEVEL.manager
      const canReadAudit = canReadUsers && type === 'full'
      const [
        tasks, taskTemplates, taskPhotos, taskTemplatePhotos,
        inventory, stockCounts, users, auditLogs,
        trainingAssignments, trainingProgress, trainingCourses,
        trainingAcknowledgements, trainingAttempts, sops,
      ] = await Promise.all([
        needsTasks ? opsClient.entities.Task.filter({ ...filter, due_date: { $gte: fromDate, $lte: toDate } }, 'due_date,due_time', 5000, { year }) : [],
        needsTasks ? opsClient.entities.TaskTemplate.list('display_order,title', 3000).catch(() => []) : [],
        needsTasks ? opsClient.entities.TaskPhoto.filter(filter, 'task_id,display_order', 6000, { year }).catch(() => []) : [],
        needsTasks ? opsClient.entities.TaskTemplatePhoto.list('template_id,display_order', 6000).catch(() => []) : [],
        needsStock ? opsClient.entities.OutletStockList.filter({ ...filter, enabled: true }, 'section,display_order', 5000) : [],
        needsStock ? opsClient.entities.StockCount.filter({ ...filter, count_date: { $lte: toDate } }, '-count_date', 12000, { year }) : [],
        canReadUsers ? opsClient.entities.User.list('full_name', 1000).catch(() => []) : [user],
        canReadAudit ? opsClient.entities.AuditLog.filter({ ...filter, created_date: { $gte: `${fromDate}T00:00:00`, $lte: `${toDate}T23:59:59.999Z` } }, 'created_date', 5000, { year }).catch(() => []) : [],
        needsTraining ? opsClient.entities.TrainingAssignment.filter(filter, 'due_date', 5000).catch(() => []) : [],
        needsTraining ? opsClient.entities.TrainingProgress.filter(filter, 'updated_at', 5000).catch(() => []) : [],
        needsTraining ? opsClient.entities.TrainingCourse.list('category,title', 2000).catch(() => []) : [],
        needsTraining ? opsClient.entities.TrainingAcknowledgement.filter(filter, 'acknowledged_at', 5000).catch(() => []) : [],
        needsTraining ? opsClient.entities.TrainingAttempt.filter(filter, 'submitted_at', 5000).catch(() => []) : [],
        needsTraining ? opsClient.entities.SOP.list('category,sop_code', 2000).catch(() => []) : [],
      ])

      const selectedTaskIds = new Set((tasks || []).map((task) => String(task.id)))
      const selectedTemplateIds = new Set((tasks || []).map((task) => String(task.template_id || '')).filter(Boolean))
      const attemptsInRange = (trainingAttempts || []).filter((row) => {
        const date = String(row.submitted_at || row.started_at || '').slice(0, 10)
        return !date || (date >= fromDate && date <= toDate)
      })

      await exportOperationsWorkbook({
        type, fromDate, toDate,
        tasks: tasks || [],
        taskTemplates: taskTemplates || [],
        taskPhotos: (taskPhotos || []).filter((row) => selectedTaskIds.has(String(row.task_id || ''))),
        taskTemplatePhotos: (taskTemplatePhotos || []).filter((row) => selectedTemplateIds.has(String(row.template_id || ''))),
        inventory: (inventory || []).map((row) => ({
          ...row,
          id: row.stock_list_id,
          source_sheet: row.section,
          source_order: row.display_order,
          unit: row.count_uom,
          min_threshold: row.minimum_qty,
          target_stock_qty: row.target_qty,
          minimum_order_purchase_qty: row.minimum_order_qty,
        })),
        stockCounts: stockCounts || [],
        users: users || [], auditLogs: auditLogs || [], outlets: selectedOutlets,
        trainingAssignments: trainingAssignments || [], trainingProgress: trainingProgress || [],
        trainingCourses: trainingCourses || [], trainingAcknowledgements: trainingAcknowledgements || [],
        trainingAttempts: attemptsInRange, sops: sops || [],
      })
    } catch (err) {
      setError(err.message || 'Unable to create Excel report')
    } finally { setGenerating('') }
  }

  return (
    <div className="chefops-page reports-page mx-auto space-y-5 pb-24">
      <div>
        <h1 className="text-2xl font-heading font-bold">Reports</h1>
        <p className="mt-1 text-sm text-muted-foreground">Choose the date range and outlets, then export the required workbook.</p>
      </div>

      <section className="rounded-2xl border border-border bg-card p-4">
        <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] md:items-end">
          <div className="space-y-1.5"><Label>From date</Label><Input type="date" value={fromDate} onChange={(event) => setFromDate(event.target.value)} /></div>
          <div className="space-y-1.5"><Label>To date</Label><Input type="date" value={toDate} onChange={(event) => setToDate(event.target.value)} /></div>
          <button type="button" onClick={() => setOutletDrawerOpen(true)} className="flex min-h-10 min-w-0 items-center gap-2 rounded-xl border border-border bg-background px-3 py-2 text-left hover:bg-muted/50 md:max-w-[300px]">
            <SlidersHorizontal className="h-4 w-4 shrink-0 text-primary" />
            <span className="min-w-0 flex-1"><span className="block text-[10px] uppercase tracking-wide text-muted-foreground">Outlets</span><span className="block truncate text-sm font-medium">{outletSummary}</span></span>
          </button>
        </div>
      </section>

      {error ? <div className="rounded-xl border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</div> : null}

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {REPORTS.map(({ key, label, icon: Icon, description }) => (
          <button key={key} type="button" onClick={() => generate(key)} disabled={Boolean(generating)} className="min-h-40 rounded-2xl border border-border bg-card p-5 text-left transition hover:border-primary/40 hover:shadow-sm active:scale-[0.99] disabled:cursor-not-allowed">
            <div className="flex items-start gap-3">
              <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-primary/15"><Icon className="h-5 w-5 text-primary" /></span>
              <div className="min-w-0 flex-1"><p className="font-semibold">{label}</p><p className="mt-2 text-sm leading-5 text-muted-foreground">{description}</p></div>
              {generating === key ? <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /> : <FileSpreadsheet className="h-5 w-5 text-muted-foreground" />}
            </div>
          </button>
        ))}
      </div>

      <section className="grid gap-3 rounded-2xl border border-border bg-muted/30 p-4 sm:grid-cols-3">
        <Info icon={Package} title="Stock" text="The first page follows the weekly Order Page structure." />
        <Info icon={Camera} title="Tasks" text="Task Photos contains sample and completion evidence images." />
        <Info icon={UsersRound} title="People" text="Outlet and Staff Performance separates points from penalties." />
      </section>

      <MobileSheet open={outletDrawerOpen} onClose={() => setOutletDrawerOpen(false)} title="Select outlets" description="Choose one or more outlets for this report." compact>
        <div className="space-y-3">
          <div className="flex items-center justify-between gap-3 rounded-xl bg-muted/50 px-3 py-2">
            <div className="flex min-w-0 items-center gap-2"><Store className="h-4 w-4 text-primary" /><span className="truncate text-sm font-medium">{selectedOutletIds.length} selected</span></div>
            <button type="button" onClick={() => setSelectedOutletIds(selectedOutletIds.length === outlets.length ? [] : outlets.map((row) => String(row.id)))} className="text-xs font-semibold text-primary">{selectedOutletIds.length === outlets.length ? 'Clear all' : 'Select all'}</button>
          </div>
          <div className="space-y-2">
            {outlets.map((outlet) => {
              const checked = selectedOutletIds.includes(String(outlet.id))
              return (
                <button key={outlet.id} type="button" onClick={() => toggleOutlet(outlet.id)} className={`flex w-full items-center gap-3 rounded-xl border px-3 py-3 text-left ${checked ? 'border-primary bg-primary/5' : 'border-border bg-background'}`}>
                  <span className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-md border ${checked ? 'border-primary bg-primary text-primary-foreground' : 'border-border'}`}>{checked ? <Check className="h-3.5 w-3.5" /> : null}</span>
                  <span className="min-w-0 flex-1 truncate text-sm font-medium">{outletLabel(outlet, outlet.id)}</span>
                </button>
              )
            })}
          </div>
          <button type="button" onClick={() => setOutletDrawerOpen(false)} disabled={!selectedOutletIds.length} className="w-full rounded-xl bg-primary px-4 py-3 text-sm font-semibold text-primary-foreground disabled:opacity-50">Done</button>
        </div>
      </MobileSheet>
    </div>
  )
}

function Info({ icon: Icon, title, text }) {
  return <div className="flex items-start gap-3"><span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-background"><Icon className="h-4 w-4 text-primary" /></span><div><p className="text-sm font-semibold">{title}</p><p className="mt-1 text-xs leading-5 text-muted-foreground">{text}</p></div></div>
}
