import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { opsClient } from "@/api/opsClient";
import { useAuth } from "@/lib/AuthContext";
import { formatDate, PRIORITY_BADGE_CLASSES, PRIORITY_LABELS, CATEGORY_ICONS } from "@/lib/ops-helpers";
import { parseOutletIds } from "@/lib/outlets";
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  ClipboardCheck,
  Clock,
  LogOut,
  PackageX,
  UsersRound,
  WalletCards,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import PageNotifications from "@/components/PageNotifications";
import PositionBadge from "@/components/PositionBadge";
import { upcomingTeam, teamTimeLabel } from "@/lib/positions";
import { buildTaskPerformance } from "@/lib/performance";
import { Bar, BarChart, CartesianGrid, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

const OPERATIONAL_TEMPLATE_IDS = new Set([
  "tmpl-rr-opening-checklist",
  "tmpl-rr-toilet-checklist",
  "tmpl-rr-daily-standards",
]);
const DEFAULT_OWNER_OUTLET = "RR-KCH";

function localDateText(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function addLocalDays(dateText, amount) {
  const [year, month, day] = dateText.split("-").map(Number);
  return localDateText(new Date(year, month - 1, day + amount));
}

function normalizePerson(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "")
    .trim();
}

function matchesCurrentUser(row, user) {
  const rowName = normalizePerson(row?.staff_name);
  if (!rowName) return false;
  const fullName = normalizePerson(user?.full_name);
  const emailName = normalizePerson(String(user?.email || "").split("@")[0]);
  return Boolean(
    (fullName && (rowName === fullName || rowName.includes(fullName) || fullName.includes(rowName)))
    || (emailName && (rowName === emailName || rowName.includes(emailName) || emailName.includes(rowName)))
  );
}

function isOperationalTask(task) {
  const notes = String(task?.notes || "");
  return notes.includes("operational-checklist-v1") || OPERATIONAL_TEMPLATE_IDS.has(String(task?.template_id || ""));
}

function normalizeIssue(issue) {
  return { ...issue, status: String(issue?.status || "open").trim().toLowerCase() || "open" };
}

function stockAliases(record = {}) {
  const aliases = [];
  if (record.stock_list_id) aliases.push(`list:${record.stock_list_id}`);
  if (record.item_id) aliases.push(`item:${record.item_id}`);
  if (record.item_name) aliases.push(`name:${String(record.item_name).trim().toLowerCase()}`);
  return aliases;
}

function lowStockFor(stockList, counts) {
  const latestByAlias = new Map();
  for (const count of counts || []) {
    for (const alias of stockAliases(count)) {
      const previous = latestByAlias.get(alias);
      if (!previous || String(previous.count_date || "") < String(count.count_date || "")) latestByAlias.set(alias, count);
    }
  }
  return (stockList || []).flatMap((item) => {
    const latest = stockAliases(item).map((alias) => latestByAlias.get(alias)).find(Boolean);
    if (!latest || latest.actual_qty === "" || latest.actual_qty == null) return [];
    const actual = Number(latest.actual_qty);
    const minimum = Number(item.minimum_qty || 0);
    if (!Number.isFinite(actual) || !Number.isFinite(minimum) || minimum <= 0 || actual > minimum) return [];
    return [{ ...item, actual_qty: actual, count_date: latest.count_date }];
  }).sort((a, b) => Number(a.actual_qty) - Number(b.actual_qty));
}

function dashboardOutlet(user) {
  const assigned = parseOutletIds(user);
  const remembered = String(localStorage.getItem("chefops.data-pack.outlet") || "").trim();
  const ownerFallback = String(user?.role || "").toLowerCase() === "owner" ? DEFAULT_OWNER_OUTLET : "";
  return String(user?.outlet_id || assigned[0] || remembered || ownerFallback).trim();
}

export default function Dashboard() {
  const { user, logout } = useAuth();
  const [tasks, setTasks] = useState([]);
  const [urgentIssues, setUrgentIssues] = useState([]);
  const [rosterRows, setRosterRows] = useState([]);
  const [teamRows, setTeamRows] = useState([]);
  const [performanceTasks, setPerformanceTasks] = useState([]);
  const [taskTemplates, setTaskTemplates] = useState([]);
  const [performanceUsers, setPerformanceUsers] = useState([]);
  const [performanceOutlets, setPerformanceOutlets] = useState([]);
  const [positions, setPositions] = useState([]);
  const [stockListItems, setStockListItems] = useState([]);
  const [stockCounts, setStockCounts] = useState([]);
  const [closeUps, setCloseUps] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadWarning, setLoadWarning] = useState("");

  useEffect(() => {
    loadData();
  }, [user?.email, user?.outlet_id, user?.outlet_ids, user?.role]);

  const loadData = async () => {
    setLoading(true);
    setLoadWarning("");
    const failures = [];
    const safe = async (label, promise, fallback = []) => {
      try {
        return await promise;
      } catch (error) {
        failures.push(`${label}: ${error?.message || "unavailable"}`);
        console.error(`Dashboard ${label} load failed`, error);
        return fallback;
      }
    };

    try {
      const today = localDateText();
      const year = Number(today.slice(0, 4));
      const startDate = addLocalDays(today, -30);
      const primaryOutletId = dashboardOutlet(user);
      if (primaryOutletId) localStorage.setItem("chefops.data-pack.outlet", primaryOutletId);

      const taskRequest = primaryOutletId
        ? opsClient.tasks.operationalBootstrap({ outletId: primaryOutletId, date: today, refresh: false })
            .then((response) => response?.tasks || [])
            .catch(() => opsClient.entities.Task.filter({ outlet_id: primaryOutletId, due_date: today }, "-priority", 100, { year }))
        : Promise.resolve([]);

      const [taskList, urgentList, history, stockList, countList, roster, closeUpRows, templates, users, outlets, positionRows] = await Promise.all([
        safe("today tasks", taskRequest),
        safe("urgent issues", primaryOutletId
          ? opsClient.entities.UrgentIssue.filter({ outlet_id: primaryOutletId }, "-created_date", 50, { year })
          : Promise.resolve([])),
        safe("task history", primaryOutletId
          ? opsClient.entities.Task.filter({ outlet_id: primaryOutletId, due_date: { $gte: startDate } }, "-due_date", 1000, { year })
          : Promise.resolve([])),
        safe("stock list", primaryOutletId
          ? opsClient.entities.OutletStockList.filter({ outlet_id: primaryOutletId, enabled: true }, "section,display_order", 1000)
          : Promise.resolve([])),
        safe("stock counts", primaryOutletId
          ? opsClient.entities.StockCount.filter({ outlet_id: primaryOutletId, count_date: { $lte: today } }, "-count_date", 2500, { year })
          : Promise.resolve([])),
        safe("duty roster", primaryOutletId
          ? opsClient.entities.Attendance.filter({ outlet_id: primaryOutletId, date: { $gte: today } }, "date,clock_in,staff_role,staff_name", 500, { year })
          : Promise.resolve([])),
        safe("close up", primaryOutletId
          ? opsClient.entities.CloseUp.filter({ outlet_id: primaryOutletId, business_date: today }, "-submitted_at", 20, { year })
          : Promise.resolve([])),
        safe("task templates", opsClient.entities.TaskTemplate.list("display_order,title", 3000)),
        safe("users", ["manager", "owner"].includes(String(user?.role || ""))
          ? opsClient.entities.User.list("full_name", 1000)
          : Promise.resolve([user]), [user]),
        safe("outlets", opsClient.entities.Outlet.list("name", 200)),
        safe("positions", opsClient.entities.PositionMaster.list("display_order,name", 100)),
      ]);

      setTasks((taskList || []).filter(isOperationalTask));
      setUrgentIssues((urgentList || []).map(normalizeIssue).filter((issue) => issue.status === "open" || issue.status === "escalated"));
      setPerformanceTasks(history || []);
      setTaskTemplates(templates || []);
      setPerformanceUsers(users || [user]);
      setPerformanceOutlets(outlets || []);
      setPositions(positionRows || []);
      setStockListItems(stockList || []);
      setStockCounts(countList || []);
      setRosterRows(roster || []);
      setCloseUps(closeUpRows || []);
      setTeamRows(upcomingTeam(roster || [], { now: new Date(), hours: 8 }));

      if (!primaryOutletId) {
        setLoadWarning("No outlet scope was available for this account.");
      } else if (failures.length) {
        setLoadWarning(`Some dashboard sections are temporarily unavailable. Loaded outlet ${primaryOutletId}; ${failures.length} source${failures.length === 1 ? "" : "s"} will retry when reopened.`);
      }
    } finally {
      setLoading(false);
    }
  };

  const today = localDateText();
  const pendingTasks = tasks.filter((task) => task.status === "pending" || task.status === "in_progress");
  const doneTasks = tasks.filter((task) => task.status === "done");
  const performanceBundle = useMemo(() => buildTaskPerformance({ tasks: performanceTasks.filter(isOperationalTask), templates: taskTemplates, users: performanceUsers, outlets: performanceOutlets, asOfDate: today }), [performanceTasks, taskTemplates, performanceUsers, performanceOutlets, today]);
  const performance = performanceBundle.total;
  const performanceDaily = performanceBundle.daily.slice(-14).map((row) => ({ ...row, penalty_bar: -Number(row.penalties || 0), label: String(row.date || "").slice(5) }));
  const personalPerformance = performanceBundle.people.find((row) => String(row.email || "").toLowerCase() === String(user?.email || "").toLowerCase()) || null;
  const lowStockItems = useMemo(() => lowStockFor(stockListItems, stockCounts), [stockListItems, stockCounts]);
  const personalShift = useMemo(() => teamRows.find((row) => matchesCurrentUser(row, user)) || rosterRows.find((row) => matchesCurrentUser(row, user)), [teamRows, rosterRows, user]);
  const visibleTeamRows = teamRows.slice(0, 4);
  const activeTeamCount = teamRows.filter((row) => row._active).length;
  const rosterTitle = "Today’s team";
  const rosterDetail = activeTeamCount
    ? `${activeTeamCount} working now`
    : personalShift
      ? `Your ${String(personalShift.staff_role || "shift").toLowerCase()} is scheduled today`
      : "No one working now";

  if (loading) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center p-4">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-muted border-t-primary" />
      </div>
    );
  }

  return (
    <div className="chefops-page dashboard-page mx-auto space-y-5 pb-24">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-heading font-bold">Hi, {user?.full_name?.split(" ")[0] || "Team"} 👋</h1>
          <p className="text-sm text-muted-foreground">{formatDate(today)}</p>
        </div>
        <Button variant="ghost" size="icon" onClick={() => logout()} className="h-9 w-9 text-muted-foreground">
          <LogOut className="h-5 w-5" />
        </Button>
      </div>

      {loadWarning ? <div className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">{loadWarning}</div> : null}
      <PageNotifications page="/" showAllOnHome limit={3} />

      <div className="rounded-2xl border border-border bg-card p-3.5 sm:p-4">
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary/15"><UsersRound className="h-5 w-5 text-primary" /></span>
            <div className="min-w-0"><p className="text-sm font-semibold">{rosterTitle}</p><p className="truncate text-xs text-muted-foreground">{rosterDetail}</p></div>
          </div>
          <Link to="/attendance"><Button variant="outline" size="sm">View all</Button></Link>
        </div>
        {visibleTeamRows.length ? (
          <div className="chefops-team-list mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
            {visibleTeamRows.map((row) => (
              <div key={row.id || `${row.date}-${row.staff_name}-${row.clock_in}`} className="chefops-team-row flex min-w-0 items-center gap-2.5 rounded-xl bg-muted/45 px-3 py-2.5">
                <PositionBadge code={row._position} positions={positions} compact />
                <div className="min-w-0 flex-1"><p className="truncate text-sm font-medium">{row.staff_name}</p><p className="truncate text-[11px] text-muted-foreground">{teamTimeLabel(row)} · {row.clock_in}–{row.clock_out}</p></div>
              </div>
            ))}
          </div>
        ) : null}
      </div>

      <div className="chefops-dashboard-kpis grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard icon={Clock} label="Open checklists" value={pendingTasks.length} to="/tasks" colorClass="bg-blue-100 text-blue-600 dark:bg-blue-950 dark:text-blue-400" />
        <StatCard icon={CheckCircle2} label="Completed today" value={doneTasks.length} to="/tasks" colorClass="bg-emerald-100 text-emerald-600 dark:bg-emerald-950 dark:text-emerald-400" />
        <StatCard icon={AlertTriangle} label="Urgent issues" value={urgentIssues.length} to="/urgent" colorClass="bg-red-100 text-red-600 dark:bg-red-950 dark:text-red-400" />
        <StatCard icon={PackageX} label="Low stock" value={lowStockItems.length} hint={`${stockListItems.length} list items`} to="/stock" colorClass={lowStockItems.length ? "bg-red-100 text-red-600 dark:bg-red-950 dark:text-red-400" : "bg-emerald-100 text-emerald-600 dark:bg-emerald-950 dark:text-emerald-400"} />
      </div>
      <Link to="/close-up" className="flex items-center justify-between rounded-2xl border border-border bg-card px-4 py-3 transition hover:bg-muted/35">
        <div className="flex items-center gap-3"><span className={`flex h-9 w-9 items-center justify-center rounded-xl ${closeUps.length ? "bg-emerald-100 text-emerald-600" : "bg-amber-100 text-amber-700"}`}><WalletCards className="h-5 w-5" /></span><div><p className="text-sm font-semibold">Close Up</p><p className="text-xs text-muted-foreground">{closeUps.length ? `${closeUps.length} event${closeUps.length === 1 ? "" : "s"} submitted today` : "Cash and payment methods are still open"}</p></div></div>
        <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${closeUps.length ? "bg-emerald-100 text-emerald-700" : "bg-amber-100 text-amber-800"}`}>{closeUps.length ? "Done" : "Open"}</span>
      </Link>

      {lowStockItems.length ? (
        <section className="rounded-2xl border border-red-200 bg-red-50/60 p-4 dark:border-red-900 dark:bg-red-950/30">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h2 className="flex items-center gap-2 text-sm font-semibold text-red-800 dark:text-red-200"><PackageX className="h-4 w-4" /> Low stock attention</h2>
              <p className="mt-1 text-xs text-red-700/75 dark:text-red-300/75">Latest saved count is at or below the minimum level.</p>
            </div>
            <Link to="/stock" className="flex items-center gap-1 text-xs font-medium text-red-700 dark:text-red-300">Count <ArrowRight className="h-3 w-3" /></Link>
          </div>
          <div className="mt-3 space-y-2">
            {lowStockItems.slice(0, 3).map((item) => (
              <Link key={item.stock_list_id || item.item_id || item.item_name} to="/stock" className="flex items-center justify-between rounded-xl bg-background/80 px-3 py-2.5">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{item.item_name}</p>
                  <p className="text-[11px] text-muted-foreground">Minimum {item.minimum_qty} {item.count_uom || "unit"}</p>
                </div>
                <span className="rounded-full bg-red-100 px-2 py-1 text-[10px] font-semibold text-red-700 dark:bg-red-900 dark:text-red-100">{item.actual_qty} left</span>
              </Link>
            ))}
          </div>
        </section>
      ) : null}

      <section className="chefops-performance-card rounded-2xl border border-border bg-card p-4 sm:p-5">
        <div className="chefops-performance-heading">
          <div><h2 className="flex items-center gap-2 text-base font-semibold"><ClipboardCheck className="h-4 w-4 text-primary" /> Operations performance</h2><p className="mt-1 text-xs text-muted-foreground">Real 30-day operational checklist performance.</p></div>
        </div>
        <div className="chefops-performance-kpis mt-4 grid grid-cols-2 gap-2 lg:grid-cols-4">
          <Metric value={`${performance.completion_rate}%`} label="Completion rate" tone={performance.completion_rate >= 80 ? "green" : performance.completion_rate < 50 ? "red" : "default"} />
          <Metric value={performance.completed} label="Completed" tone="green" />
          <Metric value={performance.missed} label="Missed" tone="red" />
          <Metric value={performance.scheduled} label="Scheduled" />
        </div>
        <div className="mt-3 h-2 overflow-hidden rounded-full bg-muted"><div className="h-full rounded-full bg-emerald-500 transition-all" style={{ width: `${Math.max(0, Math.min(100, performance.completion_rate))}%` }} /></div>
        <div className="chefops-score-strip mt-4">
          <ScoreMetric value={performance.points} label="Points earned" tone="green" signed />
          <ScoreMetric value={performance.penalties} label="Penalties" tone="red" negative />
          <ScoreMetric value={performance.net_score} label="Net score" tone={performance.net_score < 0 ? "red" : "green"} signed />
          <ScoreMetric value={personalPerformance?.net_score ?? "—"} label="My score" tone={Number(personalPerformance?.net_score || 0) < 0 ? "red" : "default"} signed={personalPerformance?.net_score != null} />
        </div>
        {performanceDaily.length ? (
          <div className="chefops-performance-chart mt-5 border-t border-border pt-4">
            <div className="chefops-performance-plot">
              <ResponsiveContainer width="100%" height="100%"><BarChart data={performanceDaily} margin={{ top: 8, right: 8, left: -10, bottom: 2 }}><CartesianGrid strokeDasharray="3 3" vertical={false} /><XAxis dataKey="label" tick={{ fontSize: 10 }} interval="preserveStartEnd" /><YAxis tick={{ fontSize: 10 }} width={34} /><Tooltip formatter={(value, name) => [Math.abs(Number(value || 0)), name === "penalty_bar" ? "Penalties" : "Points"]} /><ReferenceLine y={0} stroke="currentColor" strokeOpacity={0.35} /><Bar dataKey="points" name="Points" fill="#10b981" radius={[4,4,0,0]} /><Bar dataKey="penalty_bar" name="Penalties" fill="#ef4444" radius={[0,0,4,4]} /></BarChart></ResponsiveContainer>
            </div>
            <div className="chefops-performance-legend" aria-label="Chart legend"><span><i className="bg-emerald-500" /> Points earned</span><span><i className="bg-red-500" /> Penalties</span></div>
          </div>
        ) : <div className="mt-5 rounded-xl bg-muted/50 p-6 text-center text-sm text-muted-foreground">No completed or missed checklist score in the last 30 days.</div>}
      </section>

      {pendingTasks.length > 0 ? (
        <section>
          <div className="mb-3 flex items-center justify-between">
            <h2 className="font-heading font-semibold">Today’s priorities</h2>
            <Link to="/tasks" className="flex items-center gap-1 text-xs text-primary">View all <ArrowRight className="h-3 w-3" /></Link>
          </div>
          <div className="space-y-2">
            {pendingTasks.slice(0, 4).map((task) => (
              <Link key={task.id} to="/tasks" className="flex items-center gap-3 rounded-xl border border-border bg-card p-3">
                <span className="text-lg">{CATEGORY_ICONS[task.category] || "📌"}</span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{task.title}</p>
                  <div className="mt-0.5 flex items-center gap-2">
                    <span className={`rounded-full px-1.5 py-0.5 text-[10px] ${PRIORITY_BADGE_CLASSES[task.priority]}`}>{PRIORITY_LABELS[task.priority]}</span>
                    {task.due_time ? <span className="text-xs text-muted-foreground">{task.due_time}</span> : null}
                  </div>
                </div>
              </Link>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}

function StatCard({ icon: Icon, label, value, hint = "", to, colorClass }) {
  return (
    <Link to={to} className="chefops-dashboard-kpi rounded-2xl border border-border bg-card p-4 transition active:scale-[0.98]">
      <span className={`flex h-9 w-9 items-center justify-center rounded-xl ${colorClass}`}><Icon className="h-5 w-5" /></span>
      <p className="mt-3 text-xl font-bold">{value}</p>
      <p className="mt-1 text-xs text-muted-foreground">{label}</p>
      {hint ? <p className="mt-0.5 text-[10px] text-muted-foreground/75">{hint}</p> : null}
    </Link>
  );
}

function ScoreMetric({ value, label, tone = "default", signed = false, negative = false }) {
  const number = Number(value);
  const display = value === "—" || !Number.isFinite(number) ? value : negative ? `-${Math.abs(number)}` : signed && number > 0 ? `+${number}` : String(number);
  return <div className="chefops-score-metric"><p className={`text-xl font-bold tabular-nums ${tone === "red" ? "text-red-600" : tone === "green" ? "text-emerald-600" : ""}`}>{display}</p><p className="text-[11px] text-muted-foreground">{label}</p></div>;
}

function Metric({ value, label, tone = "default" }) {
  return (
    <div className="rounded-xl bg-muted/60 p-2.5 text-center">
      <p className={`text-lg font-bold ${tone === "red" ? "text-red-600" : tone === "green" ? "text-emerald-600" : ""}`}>{value}</p>
      <p className="mt-0.5 text-[10px] text-muted-foreground">{label}</p>
    </div>
  );
}
