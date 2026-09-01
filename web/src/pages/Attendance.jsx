import { useEffect, useMemo, useRef, useState } from "react";
import { opsClient } from "@/api/opsClient";
import { useAuth } from "@/lib/AuthContext";
import { outletLabel, parseOutletIds } from "@/lib/outlets";
import PageNotifications from "@/components/PageNotifications";
import MobileSheet from "@/components/MobileSheet";
import PositionBadge from "@/components/PositionBadge";
import { parseDutySegments } from "@/lib/positions";
import { Button } from "@/components/ui/button";
import { parseDutyRosterPdf } from "@/lib/roster-import";
import {
  CalendarDays,
  Clock3,
  UsersRound,
  UtensilsCrossed,
  ChevronLeft,
  ChevronRight,
  Loader2,
  Store,
  UserRoundCheck,
  FileUp,
  UploadCloud,
  AlertTriangle,
  CheckCircle2,
} from "lucide-react";

function localDateText(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function addDays(dateText, amount) {
  const [year, month, day] = dateText.split("-").map(Number);
  const date = new Date(year, month - 1, day + amount);
  return localDateText(date);
}

function formatDate(dateText) {
  if (!dateText) return "";
  const [year, month, day] = dateText.split("-").map(Number);
  return new Intl.DateTimeFormat("en-MY", { weekday: "long", day: "numeric", month: "short", year: "numeric" }).format(new Date(year, month - 1, day));
}

function timeMinutes(value) {
  const [hour, minute] = String(value || "0:00").split(":").map(Number);
  return (Number(hour) || 0) * 60 + (Number(minute) || 0);
}

function dutyText(notes) {
  const value = String(notes || "");
  const match = value.match(/planned duties:\s*(.*?)(?:\.\s*Scheduled shift|$)/i);
  return match?.[1]?.trim() || "Scheduled shift";
}

function shiftName(row) {
  return timeMinutes(row.clock_in) < 16 * 60 ? "Morning" : "Night";
}

function coverageText(rows) {
  if (!rows.length) return "—";
  const starts = rows.map((row) => timeMinutes(row.clock_in)).filter(Number.isFinite);
  const start = rows[starts.indexOf(Math.min(...starts))]?.clock_in || "—";
  const midnight = rows.some((row) => String(row.clock_out) === "0:00" || String(row.clock_out) === "00:00");
  const ends = rows.map((row) => timeMinutes(row.clock_out)).filter((value) => value > 0);
  const end = midnight ? "00:00" : (rows[ends.indexOf(Math.max(...ends))]?.clock_out || "—");
  return `${start}–${end}`;
}

export default function Attendance() {
  const { user } = useAuth();
  const assignedOutletIds = useMemo(() => parseOutletIds(user), [user]);
  const today = useMemo(() => localDateText(), []);
  const [selectedDate, setSelectedDate] = useState(today);
  const [outlets, setOutlets] = useState([]);
  const [selectedOutletId, setSelectedOutletId] = useState(user?.outlet_id || assignedOutletIds[0] || "");
  const [rows, setRows] = useState([]);
  const [positions, setPositions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [importOpen, setImportOpen] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [workforce, setWorkforce] = useState(null);
  const [workforceLoading, setWorkforceLoading] = useState(false);
  const [workforceSaving, setWorkforceSaving] = useState(false);
  const [workforceError, setWorkforceError] = useState("");
  const autoAdvanced = useRef(false);

  useEffect(() => {
    Promise.all([
      opsClient.entities.Outlet.list("name", 100),
      opsClient.entities.PositionMaster.list("display_order,name", 100).catch(() => []),
    ])
      .then(([items, positionRows]) => {
        setPositions(positionRows || []);
        const all = items || [];
        const visible = ["manager", "owner"].includes(user?.role)
          ? all
          : all.filter((row) => assignedOutletIds.includes(String(row.id)));
        setOutlets(visible);
        setSelectedOutletId((current) => visible.some((row) => String(row.id) === String(current))
          ? current
          : (visible.find((row) => String(row.id) === String(user?.outlet_id))?.id || visible[0]?.id || ""));
      })
      .catch(() => setOutlets([]));
  }, [assignedOutletIds, user?.outlet_id, user?.role]);

  useEffect(() => {
    if (!selectedOutletId) {
      setRows([]);
      setLoading(false);
      return;
    }

    let cancelled = false;
    const load = async () => {
      setLoading(true);
      setError("");
      try {
        const year = Number(selectedDate.slice(0, 4));
        const exact = await opsClient.entities.Attendance.filter(
          { outlet_id: selectedOutletId, date: selectedDate },
          "clock_in,staff_role,staff_name",
          200,
          { year },
        );
        if (cancelled) return;

        if (!exact?.length && selectedDate === today && !autoAdvanced.current) {
          const upcoming = await opsClient.entities.Attendance.filter(
            { outlet_id: selectedOutletId, date: { $gte: today } },
            "date,clock_in,staff_role,staff_name",
            500,
            { year: Number(today.slice(0, 4)) },
          );
          if (cancelled) return;
          const nextDate = (upcoming || []).map((row) => row.date).filter((date) => date >= today).sort()[0];
          if (nextDate && nextDate !== selectedDate) {
            autoAdvanced.current = true;
            setSelectedDate(nextDate);
            return;
          }
        }

        setRows(exact || []);
      } catch (err) {
        if (!cancelled) setError(err.message || "Unable to load duty roster");
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    load();
    return () => { cancelled = true; };
  }, [selectedDate, selectedOutletId, today, reloadKey]);

  useEffect(() => {
    if (!selectedOutletId) return;
    let cancelled = false;
    setWorkforceLoading(true);
    setWorkforceError("");
    opsClient.attendance.workforceContext({ outletId: selectedOutletId, businessDate: selectedDate })
      .then((value) => { if (!cancelled) setWorkforce(value); })
      .catch((err) => {
        if (!cancelled) {
          setWorkforce(null);
          setWorkforceError(err.message || "Unable to load your attendance state");
        }
      })
      .finally(() => { if (!cancelled) setWorkforceLoading(false); });
    return () => { cancelled = true; };
  }, [selectedDate, selectedOutletId, reloadKey]);

  async function runAttendanceCommand(action) {
    if (!workforce?.schedule || workforceSaving) return;
    setWorkforceSaving(true);
    setWorkforceError("");
    try {
      const mutationId = `attendance:${action}:${crypto.randomUUID()}`;
      if (action === "clock-in") {
        await opsClient.attendance.clockIn({
          mutation_id: mutationId,
          outlet_id: selectedOutletId,
          business_date: selectedDate,
          schedule_id: workforce.schedule.id,
        });
      } else {
        await opsClient.attendance.clockOut({
          mutation_id: mutationId,
          outlet_id: selectedOutletId,
          attendance_record_id: workforce.attendance_record.id,
        });
      }
      setReloadKey((value) => value + 1);
    } catch (err) {
      setWorkforceError(err.message || "Unable to save attendance");
    } finally { setWorkforceSaving(false); }
  }

  const groups = useMemo(() => {
    const morning = rows.filter((row) => shiftName(row) === "Morning");
    const night = rows.filter((row) => shiftName(row) === "Night");
    return [["Morning", morning], ["Night", night]].filter(([, items]) => items.length);
  }, [rows]);

  const selectedOutlet = outlets.find((outlet) => String(outlet.id) === String(selectedOutletId));
  const leaderCount = rows.filter((row) => String(row.staff_role || "").toLowerCase() === "leader").length;

  return (
    <div className="chefops-page attendance-page mx-auto w-full max-w-6xl space-y-4 p-4 pb-24">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-heading font-bold">Duty Roster</h1>
          <p className="mt-0.5 text-xs text-muted-foreground">Published schedules and your authoritative attendance record.</p>
        </div>
        {["manager", "owner"].includes(String(user?.role || "")) ? (
          <Button size="sm" onClick={() => setImportOpen(true)}><FileUp className="mr-1.5 h-4 w-4" />Import PDF</Button>
        ) : null}
      </div>

      <PageNotifications page="/attendance" limit={2} />

      {outlets.length > 1 ? (
        <section className="rounded-2xl border border-border bg-card p-3">
          <div className="mb-2 flex items-center gap-2"><Store className="h-4 w-4 text-primary" /><p className="text-sm font-semibold">Outlet</p></div>
          <select value={selectedOutletId} onChange={(event) => setSelectedOutletId(event.target.value)} className="h-12 w-full rounded-xl border border-input bg-background px-3 text-sm">
            {outlets.map((outlet) => <option key={outlet.id} value={outlet.id}>{outletLabel(outlet, outlet.id)}</option>)}
          </select>
        </section>
      ) : selectedOutlet ? (
        <div className="rounded-xl border border-border bg-card px-3 py-2 text-sm font-medium">{outletLabel(selectedOutlet, selectedOutlet.id)}</div>
      ) : null}

      <section className="rounded-2xl border border-border bg-card p-3">
        <div className="grid grid-cols-[44px_1fr_44px] items-center gap-2">
          <button type="button" onClick={() => setSelectedDate(addDays(selectedDate, -1))} className="flex h-11 w-11 items-center justify-center rounded-xl border border-border bg-background" aria-label="Previous day">
            <ChevronLeft className="h-5 w-5" />
          </button>
          <label className="relative block">
            <CalendarDays className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <input type="date" value={selectedDate} onChange={(event) => setSelectedDate(event.target.value)} className="h-11 w-full rounded-xl border border-input bg-background pl-9 pr-3 text-sm" />
          </label>
          <button type="button" onClick={() => setSelectedDate(addDays(selectedDate, 1))} className="flex h-11 w-11 items-center justify-center rounded-xl border border-border bg-background" aria-label="Next day">
            <ChevronRight className="h-5 w-5" />
          </button>
        </div>
        <p className="mt-2 text-center text-xs font-medium text-muted-foreground">{formatDate(selectedDate)}</p>
      </section>

      {error ? <div className="rounded-xl border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</div> : null}

      <section className="rounded-2xl border border-border bg-card p-4" aria-label="My attendance">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-sm font-bold">My attendance</p>
            <p className="mt-1 text-xs text-muted-foreground">Server-accepted time only. Device time is never attendance authority.</p>
          </div>
          {workforce?.attendance_record?.status ? (
            <span className="rounded-full bg-primary/10 px-2 py-1 text-[10px] font-semibold uppercase text-primary">{String(workforce.attendance_record.status).replaceAll("_", " ")}</span>
          ) : null}
        </div>
        {workforceLoading ? (
          <div className="mt-4 flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />Loading authoritative state</div>
        ) : workforce?.schedule ? (
          <div className="mt-4 space-y-3">
            <div className="rounded-xl bg-muted/50 p-3 text-sm">
              <p className="font-semibold">{workforce.schedule.clock_in}–{workforce.schedule.clock_out} · {workforce.schedule.time_zone}</p>
              <p className="mt-1 text-xs text-muted-foreground">Schedule {workforce.schedule.id} · version {workforce.schedule.__realtime?.version}</p>
            </div>
            {workforce.consequence ? (
              <div className="rounded-xl border border-emerald-300 bg-emerald-50 p-3 text-sm text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200">
                <p className="font-semibold">Worked time recorded</p>
                <p className="mt-1 text-xs">{Math.floor(Number(workforce.consequence.worked_seconds || 0) / 3600)}h {Math.floor((Number(workforce.consequence.worked_seconds || 0) % 3600) / 60)}m · report projection queued · payroll effect none</p>
              </div>
            ) : null}
            {!workforce.attendance_record ? (
              <Button className="w-full" disabled={workforceSaving} onClick={() => void runAttendanceCommand("clock-in")}>
                {workforceSaving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Clock3 className="mr-2 h-4 w-4" />}Clock in
              </Button>
            ) : workforce.attendance_record.status === "clocked_in" ? (
              <Button className="w-full" disabled={workforceSaving} onClick={() => void runAttendanceCommand("clock-out")}>
                {workforceSaving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <UserRoundCheck className="mr-2 h-4 w-4" />}Clock out
              </Button>
            ) : null}
          </div>
        ) : (
          <p className="mt-4 text-sm text-muted-foreground">No active D1 schedule is bound to your current employee identity for this date.</p>
        )}
        {workforceError ? <div className="mt-3 rounded-xl border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">{workforceError}</div> : null}
      </section>

      {loading ? (
        <div className="flex justify-center py-12"><Loader2 className="h-7 w-7 animate-spin text-muted-foreground" /></div>
      ) : rows.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-border p-10 text-center">
          <UsersRound className="mx-auto mb-3 h-10 w-10 text-muted-foreground" />
          <p className="font-medium">No roster published for this date</p>
          <p className="mt-1 text-sm text-muted-foreground">Choose another date or write scheduled rows into Operations → Attendance.</p>
        </div>
      ) : (
        <>
          <section className="grid grid-cols-3 gap-2">
            <SummaryCard icon={UsersRound} value={rows.length} label="Team" />
            <SummaryCard icon={UserRoundCheck} value={leaderCount} label="Leaders" />
            <SummaryCard icon={Clock3} value={coverageText(rows)} label="Coverage" compact />
          </section>

          <div className="space-y-5">
            {groups.map(([group, groupRows]) => (
              <section key={group} className="space-y-2">
                <div className="flex items-center justify-between border-b border-border pb-2">
                  <div className="flex items-center gap-2">
                    <span className={`h-2.5 w-2.5 rounded-full ${group === "Morning" ? "bg-amber-400" : "bg-indigo-500"}`} />
                    <h2 className="text-sm font-bold">{group} shift</h2>
                  </div>
                  <span className="rounded-full bg-muted px-2 py-1 text-[10px] text-muted-foreground">{groupRows.length} staff</span>
                </div>

                {groupRows.map((row) => (
                  <article key={row.id} className="rounded-2xl border border-border bg-card p-3.5">
                    <div className="flex items-start gap-3">
                      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-sm font-bold text-primary">
                        {String(row.staff_name || "?").slice(0, 1).toUpperCase()}
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-start justify-between gap-2">
                          <div>
                            <p className="text-sm font-semibold">{row.staff_name}</p>
                            <p className="mt-0.5 text-xs capitalize text-muted-foreground">{row.staff_role || "Staff"}</p>
                          </div>
                          <span className="rounded-full bg-emerald-100 px-2 py-1 text-[10px] font-medium text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300">Scheduled</span>
                        </div>
                        <div className="mt-3 grid grid-cols-[auto_1fr] gap-x-2 gap-y-2 text-xs">
                          <Clock3 className="h-4 w-4 text-muted-foreground" />
                          <span className="font-medium">{row.clock_in || "—"} – {row.clock_out || "—"} · {row.hours_worked || 0}h</span>
                          <UtensilsCrossed className="h-4 w-4 text-muted-foreground" />
                          <span className="flex flex-wrap gap-1.5">{parseDutySegments(row.notes).length ? parseDutySegments(row.notes).map((segment, index) => <PositionBadge key={`${segment.start}-${segment.code}-${index}`} code={segment.code} positions={positions} />) : <span className="leading-5 text-muted-foreground">{dutyText(row.notes)}</span>}</span>
                        </div>
                      </div>
                    </div>
                  </article>
                ))}
              </section>
            ))}
          </div>
        </>
      )}
      <MobileSheet open={importOpen} onClose={() => setImportOpen(false)} title="Import weekly duty roster" description="Upload the exported weekly PDF, review the detected shifts, then replace those dates in Attendance." compact={false}>
        <RosterImportForm
          outletId={selectedOutletId}
          outletName={outletLabel(selectedOutlet, selectedOutletId)}
          onCancel={() => setImportOpen(false)}
          onDone={(result) => {
            setImportOpen(false);
            const firstDate = result.dates?.[0] || selectedDate;
            setSelectedDate(firstDate);
            setReloadKey((value) => value + 1);
          }}
        />
      </MobileSheet>
    </div>
  );
}

function RosterImportForm({ outletId, outletName, onCancel, onDone }) {
  const [file, setFile] = useState(null);
  const [parsed, setParsed] = useState(null);
  const [progress, setProgress] = useState(null);
  const [replaceExisting, setReplaceExisting] = useState(true);
  const [reading, setReading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const inputRef = useRef(null);

  async function choose(selected) {
    if (!selected) return;
    setFile(selected);
    setParsed(null);
    setError("");
    setReading(true);
    try {
      const result = await parseDutyRosterPdf(selected, setProgress);
      setParsed(result);
    } catch (err) {
      setError(err.message || "Unable to read this roster PDF");
    } finally { setReading(false); }
  }

  async function importRoster() {
    if (!file || !parsed?.rows?.length || !outletId) return;
    setSaving(true);
    setError("");
    try {
      const uploaded = await opsClient.integrations.Core.UploadFile({ file, folderType: "Duty Rosters", outletName: outletName || outletId });
      const result = await opsClient.attendance.importRoster({
        outlet_id: outletId,
        replace_existing: replaceExisting,
        source: {
          file_name: uploaded.file_name || file.name,
          file_url: uploaded.file_url || "",
          drive_file_id: uploaded.drive_file_id || "",
        },
        rows: parsed.rows,
      });
      onDone(result);
    } catch (err) {
      setError(err.message || "Unable to import duty roster");
    } finally { setSaving(false); }
  }

  const previewRows = parsed?.rows?.slice(0, 12) || [];
  return (
    <div className="space-y-4">
      <input ref={inputRef} type="file" accept="application/pdf,.pdf" hidden onChange={(event) => { void choose(event.target.files?.[0]); event.target.value = ""; }} />
      <button type="button" onClick={() => inputRef.current?.click()} className="flex min-h-28 w-full flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-primary/50 bg-primary/5 p-4 text-center">
        <FileUp className="h-7 w-7 text-primary" />
        <span className="text-sm font-semibold">{file ? file.name : "Choose weekly roster PDF"}</span>
        <span className="text-xs text-muted-foreground">Supports the WEEKLY DUTY ROSTER layout with employee, position and hourly stations.</span>
      </button>

      {reading ? <div className="rounded-xl bg-muted p-3 text-sm"><Loader2 className="mr-2 inline h-4 w-4 animate-spin" />{progress?.message || "Reading roster"}</div> : null}
      {error ? <div className="rounded-xl border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">{error}</div> : null}

      {parsed ? (
        <>
          <section className="grid grid-cols-3 gap-2">
            <SummaryCard icon={CalendarDays} value={parsed.dates.length} label="Dates" />
            <SummaryCard icon={UsersRound} value={new Set(parsed.rows.map((row) => row.staff_name)).size} label="People" />
            <SummaryCard icon={Clock3} value={parsed.rows.length} label="Shifts" />
          </section>
          {parsed.warnings?.length ? <div className="space-y-1 rounded-xl border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900">{parsed.warnings.map((warning) => <p key={warning} className="flex gap-2"><AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />{warning}</p>)}</div> : <div className="flex items-center gap-2 rounded-xl bg-emerald-50 p-3 text-xs text-emerald-800"><CheckCircle2 className="h-4 w-4" />Roster structure detected successfully.</div>}
          <section className="overflow-hidden rounded-xl border border-border">
            <div className="border-b bg-muted/50 px-3 py-2 text-xs font-semibold">Preview · first {previewRows.length} of {parsed.rows.length}</div>
            <div className="max-h-64 overflow-y-auto">{previewRows.map((row, index) => <div key={`${row.date}-${row.staff_name}-${index}`} className="grid grid-cols-[84px_1fr_auto] gap-2 border-b px-3 py-2 text-xs last:border-b-0"><span>{row.date.slice(5)}</span><span className="min-w-0"><strong>{row.staff_name}</strong><span className="block truncate text-muted-foreground">{row.duty_summary}</span></span><span className="font-medium">{row.clock_in}-{row.clock_out}</span></div>)}</div>
          </section>
          <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-border p-3">
            <input type="checkbox" checked={replaceExisting} onChange={(event) => setReplaceExisting(event.target.checked)} className="mt-0.5 h-4 w-4 accent-primary" />
            <span><span className="block text-sm font-semibold">Replace existing rows for these dates</span><span className="mt-0.5 block text-xs text-muted-foreground">Recommended for a weekly roster re-import. Older rows are archived before the new PDF rows are added.</span></span>
          </label>
          <div className="grid grid-cols-2 gap-2"><Button type="button" variant="outline" onClick={onCancel} disabled={saving}>Cancel</Button><Button type="button" onClick={importRoster} disabled={saving || !parsed.rows.length}>{saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <UploadCloud className="mr-2 h-4 w-4" />}Import {parsed.rows.length} shifts</Button></div>
        </>
      ) : null}
    </div>
  );
}

function SummaryCard({ icon: Icon, value, label, compact = false }) {
  return (
    <div className="rounded-2xl border border-border bg-card p-3">
      <Icon className="h-4 w-4 text-primary" />
      <p className={`mt-2 font-bold ${compact ? "text-sm" : "text-xl"}`}>{value}</p>
      <p className="mt-0.5 text-[10px] text-muted-foreground">{label}</p>
    </div>
  );
}
