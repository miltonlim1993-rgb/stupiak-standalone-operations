import { useEffect, useMemo, useState } from "react";
import { opsClient } from "@/api/opsClient";
import { useAuth } from "@/lib/AuthContext";
import { outletLabel, parseOutletIds } from "@/lib/outlets";
import {
  Bell,
  CheckCircle2,
  Filter,
  Loader2,
  Search,
  Settings2,
  ShieldCheck,
  UserCheck,
  UserRoundX,
  UsersRound,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import MobileSheet from "@/components/MobileSheet";

const ROLE_OPTIONS = ["staff", "leader", "supervisor", "manager", "owner"];
const STATUS_TABS = [
  { value: "pending", label: "Pending" },
  { value: "active", label: "Approved" },
  { value: "suspended", label: "Suspended" },
  { value: "rejected", label: "Rejected" },
  { value: "all", label: "All" },
];
const PAGE_OPTIONS = [
  { value: "/", label: "Home" },
  { value: "/tasks", label: "Tasks" },
  { value: "/urgent", label: "Issues" },
  { value: "/stock", label: "Stock Count" },
  { value: "/inventory", label: "Inventory" },
  { value: "/close-up", label: "Close Up" },
  { value: "/receipts", label: "Receipts & OCR" },
  { value: "/labels", label: "Food Labels" },
  { value: "/attendance", label: "Duty Roster" },
  { value: "/install", label: "Install / Update App" },
];

function normalizeStatus(value) {
  const status = String(value || "pending").toLowerCase();
  return ["active", "suspended", "rejected"].includes(status) ? status : "pending";
}

function includesOutlet(user, outletId) {
  if (!outletId) return true;
  const values = [user.outlet_id, ...(String(user.outlet_ids || "").replace(/[\[\]"]/g, "").split(","))]
    .map((value) => String(value || "").trim())
    .filter(Boolean);
  return values.includes(String(outletId));
}

export default function OpsControl() {
  const { user } = useAuth();
  const canApprove = ["manager", "owner"].includes(String(user?.role || ""));
  const [users, setUsers] = useState([]);
  const [outlets, setOutlets] = useState([]);
  const [loading, setLoading] = useState(true);
  const [savingId, setSavingId] = useState("");
  const [statusFilter, setStatusFilter] = useState("pending");
  const [roleFilter, setRoleFilter] = useState("all");
  const [outletFilter, setOutletFilter] = useState("");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState(new Set());
  const [pushOpen, setPushOpen] = useState(false);
  const [accessUser, setAccessUser] = useState(null);
  const [message, setMessage] = useState("");

  const load = async () => {
    setLoading(true);
    try {
      const [userRows, outletRows] = await Promise.all([
        opsClient.entities.User.list("-created_date", 500),
        opsClient.entities.Outlet.list("name", 100),
      ]);
      setUsers(userRows || []);
      setOutlets(outletRows || []);
    } catch (error) {
      setMessage(error.message || "Unable to load approvals");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const counts = useMemo(() => {
    const result = { pending: 0, active: 0, suspended: 0, rejected: 0, all: users.length };
    users.forEach((item) => { result[normalizeStatus(item.status)] += 1; });
    return result;
  }, [users]);

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    return users.filter((item) => {
      const status = normalizeStatus(item.status);
      if (statusFilter !== "all" && status !== statusFilter) return false;
      if (roleFilter !== "all" && String(item.role || "staff") !== roleFilter) return false;
      if (!includesOutlet(item, outletFilter)) return false;
      if (term && !`${item.full_name} ${item.email} ${item.phone}`.toLowerCase().includes(term)) return false;
      return true;
    });
  }, [users, statusFilter, roleFilter, outletFilter, search]);

  const updateUser = async (item, patch, notify = null) => {
    if (!canApprove) return;
    setSavingId(item.id);
    setMessage("");
    try {
      const updated = await opsClient.entities.User.update(item.id, patch);
      setUsers((current) => current.map((row) => row.id === item.id ? { ...row, ...updated, ...patch } : row));
      if (notify) {
        await opsClient.notifications.push({
          recipient_user_ids: [item.id],
          title: notify.title,
          message: notify.message,
          target_page: notify.target_page || "/",
          action_label: notify.action_label || "Open",
          priority: "normal",
        });
      }
    } catch (error) {
      setMessage(error.message || "Unable to update user");
    } finally {
      setSavingId("");
    }
  };

  const approve = (item) => updateUser(item, {
    status: "active",
    role: item.role || "staff",
    outlet_id: item.outlet_id || outletFilter || outlets[0]?.id || "",
    outlet_ids: item.outlet_ids || item.outlet_id || outletFilter || outlets[0]?.id || "",
  }, {
    title: "Account approved",
    message: "Your Stupiak's Ops access is now active.",
    target_page: "/",
    action_label: "Open app",
  });

  const setDraftField = (id, key, value) => {
    setUsers((current) => current.map((row) => row.id === id ? { ...row, [key]: value } : row));
  };

  const toggleSelected = (id) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  if (!canApprove) {
    return <div className="mx-auto max-w-lg p-4"><div className="rounded-2xl border border-border bg-card p-6 text-center"><ShieldCheck className="mx-auto h-10 w-10 text-muted-foreground" /><p className="mt-3 font-semibold">Manager approval required</p></div></div>;
  }

  return (
    <div className="chefops-page ops-control-page mx-auto space-y-4 pb-24">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-heading font-bold"><ShieldCheck className="h-5 w-5" /> Access Approvals</h1>
          <p className="mt-0.5 text-xs text-muted-foreground">Approve users, assign access, and push page-specific notifications.</p>
        </div>
        <Button size="sm" variant="outline" className="h-9 rounded-xl px-3" disabled={!selected.size} onClick={() => setPushOpen(true)}>
          <Bell className="mr-1 h-4 w-4" /> Push {selected.size || ""}
        </Button>
      </div>

      <div className="flex gap-2 overflow-x-auto pb-1">
        {STATUS_TABS.map((tab) => (
          <button key={tab.value} type="button" onClick={() => setStatusFilter(tab.value)} className={`whitespace-nowrap rounded-full px-3 py-2 text-xs font-medium ${statusFilter === tab.value ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"}`}>
            {tab.label} ({counts[tab.value] || 0})
          </button>
        ))}
      </div>

      <section className="space-y-2.5 rounded-2xl border border-border bg-card p-3">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search name or email" className="h-10 rounded-xl pl-9" />
        </div>
        <div className="grid grid-cols-2 gap-2.5">
          <label className="relative">
            <Filter className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <select value={roleFilter} onChange={(event) => setRoleFilter(event.target.value)} className="h-10 w-full rounded-xl border border-input bg-background pl-9 pr-2 text-sm">
              <option value="all">All roles</option>
              {ROLE_OPTIONS.map((role) => <option key={role} value={role} className="capitalize">{role}</option>)}
            </select>
          </label>
          <select value={outletFilter} onChange={(event) => setOutletFilter(event.target.value)} className="h-10 w-full rounded-xl border border-input bg-background px-3 text-sm">
            <option value="">All outlets</option>
            {outlets.map((outlet) => <option key={outlet.id} value={outlet.id}>{outletLabel(outlet, outlet.id)}</option>)}
          </select>
        </div>
      </section>

      {message ? <div className="rounded-xl border border-border bg-muted px-3 py-2 text-sm">{message}</div> : null}

      {loading ? (
        <div className="flex justify-center py-12"><Loader2 className="h-7 w-7 animate-spin text-muted-foreground" /></div>
      ) : filtered.length === 0 ? (
        <div className="rounded-2xl border border-dashed p-10 text-center"><UsersRound className="mx-auto h-10 w-10 text-muted-foreground" /><p className="mt-2 text-sm text-muted-foreground">No users match these filters.</p></div>
      ) : (
        <div className="grid gap-3 lg:grid-cols-2 2xl:grid-cols-3">
          {filtered.map((item) => {
            const status = normalizeStatus(item.status);
            return (
              <article key={item.id} className="rounded-2xl border border-border bg-card p-3.5">
                <div className="flex items-start gap-3">
                  <input type="checkbox" checked={selected.has(item.id)} onChange={() => toggleSelected(item.id)} className="mt-1 h-4 w-4 rounded border-input accent-primary" />
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-muted text-sm font-bold">{String(item.full_name || item.email || "?").slice(0, 1).toUpperCase()}</span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0"><p className="truncate text-sm font-semibold">{item.full_name || "Unnamed user"}</p><p className="truncate text-xs text-muted-foreground">{item.email}</p></div>
                      <span className={`rounded-full px-2 py-1 text-[10px] font-medium ${status === "active" ? "bg-emerald-100 text-emerald-700" : status === "pending" ? "bg-amber-100 text-amber-700" : "bg-muted text-muted-foreground"}`}>{status}</span>
                    </div>

                    {status === "pending" ? (
                      <div className="mt-3 grid grid-cols-2 gap-2">
                        <select value={item.role || "staff"} onChange={(event) => setDraftField(item.id, "role", event.target.value)} className="h-9 rounded-xl border border-input bg-background px-2 text-xs capitalize">
                          {ROLE_OPTIONS.filter((role) => user?.role === "owner" || role !== "owner").map((role) => <option key={role} value={role}>{role}</option>)}
                        </select>
                        <select value={item.outlet_id || ""} onChange={(event) => { setDraftField(item.id, "outlet_id", event.target.value); setDraftField(item.id, "outlet_ids", event.target.value); }} className="h-9 rounded-xl border border-input bg-background px-2 text-xs">
                          <option value="">Assign outlet</option>
                          {outlets.map((outlet) => <option key={outlet.id} value={outlet.id}>{outletLabel(outlet, outlet.id)}</option>)}
                        </select>
                      </div>
                    ) : null}

                    <div className="mt-3 flex flex-wrap gap-2">
                      {status === "pending" ? (
                        <>
                          <Button size="sm" className="h-8 rounded-lg text-xs" disabled={savingId === item.id || !item.outlet_id} onClick={() => approve(item)}><UserCheck className="mr-1 h-3.5 w-3.5" /> Approve</Button>
                          <Button size="sm" variant="outline" className="h-8 rounded-lg text-xs text-red-600" disabled={savingId === item.id} onClick={() => updateUser(item, { status: "rejected" })}><UserRoundX className="mr-1 h-3.5 w-3.5" /> Reject</Button>
                        </>
                      ) : null}
                      {status === "active" ? <Button size="sm" variant="outline" className="h-8 rounded-lg text-xs" disabled={savingId === item.id} onClick={() => updateUser(item, { status: "suspended" })}>Suspend</Button> : null}
                      {["suspended", "rejected"].includes(status) ? <Button size="sm" variant="outline" className="h-8 rounded-lg text-xs text-emerald-600" disabled={savingId === item.id} onClick={() => updateUser(item, { status: "active" })}><CheckCircle2 className="mr-1 h-3.5 w-3.5" /> Restore</Button> : null}
                      <Button size="sm" variant="outline" className="h-8 rounded-lg text-xs" onClick={() => setAccessUser(item)}><Settings2 className="mr-1 h-3.5 w-3.5" /> Access</Button>
                      <Button size="sm" variant="ghost" className="h-8 rounded-lg text-xs" onClick={() => { setSelected(new Set([item.id])); setPushOpen(true); }}><Bell className="mr-1 h-3.5 w-3.5" /> Notify</Button>
                    </div>
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      )}

      <MobileSheet open={Boolean(accessUser)} onClose={() => setAccessUser(null)} title="User access" description="Assign role, primary outlet and every outlet this user may access.">
        {accessUser ? <AccessForm user={accessUser} outlets={outlets} currentRole={user?.role} onCancel={() => setAccessUser(null)} onDone={(updated) => { setUsers((current) => current.map((row) => row.id === updated.id ? { ...row, ...updated } : row)); setAccessUser(null); setMessage(`Access updated for ${updated.full_name || updated.email}.`); }} /> : null}
      </MobileSheet>

      <MobileSheet open={pushOpen} onClose={() => setPushOpen(false)} title="Push notification" description={`Send to ${selected.size} selected user ID${selected.size === 1 ? "" : "s"}.`}>
        <PushForm recipientIds={[...selected]} onCancel={() => setPushOpen(false)} onDone={(count) => { setPushOpen(false); setSelected(new Set()); setMessage(`Notification pushed to ${count} user${count === 1 ? "" : "s"}.`); }} />
      </MobileSheet>
    </div>
  );
}

function AccessForm({ user, outlets, currentRole, onCancel, onDone }) {
  const [role, setRole] = useState(user.role || "staff");
  const [primaryOutlet, setPrimaryOutlet] = useState(user.outlet_id || "");
  const [outletIds, setOutletIds] = useState(() => new Set(parseOutletIds(user)));
  const [status, setStatus] = useState(normalizeStatus(user.status));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const toggleOutlet = (id) => {
    setOutletIds((current) => {
      const next = new Set(current);
      if (next.has(id)) {
        next.delete(id);
        if (primaryOutlet === id) setPrimaryOutlet("");
      } else {
        next.add(id);
        if (!primaryOutlet) setPrimaryOutlet(id);
      }
      return next;
    });
  };

  const submit = async (event) => {
    event.preventDefault();
    if (!primaryOutlet || !outletIds.size) { setError("Select at least one outlet and a primary outlet."); return; }
    setSaving(true);
    setError("");
    try {
      const assignedOutletIds = [...outletIds].map(String);
      const updated = await opsClient.users.updateAccess(user.id, {
        role,
        status,
        primary_outlet_id: String(primaryOutlet),
        assigned_outlet_ids: assignedOutletIds,
      });
      onDone({ ...user, ...updated.user, outlet_id: updated.user?.outlet_id || primaryOutlet, outlet_ids: updated.user?.outlet_ids || JSON.stringify(assignedOutletIds) });
    } catch (err) {
      setError(err.message || "Unable to update user access");
    } finally { setSaving(false); }
  };

  return <form onSubmit={submit} className="space-y-4">
    <section className="rounded-2xl border border-border bg-card p-4">
      <p className="font-semibold">{user.full_name || "Unnamed user"}</p><p className="text-xs text-muted-foreground">{user.email}</p>
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5"><Label>Role</Label><select value={role} onChange={(event) => setRole(event.target.value)} className="h-10 w-full rounded-xl border border-input bg-background px-3 text-sm">{ROLE_OPTIONS.filter((value) => currentRole === "owner" || value !== "owner").map((value) => <option key={value} value={value}>{value}</option>)}</select></div>
        <div className="space-y-1.5"><Label>Status</Label><select value={status} onChange={(event) => setStatus(event.target.value)} className="h-10 w-full rounded-xl border border-input bg-background px-3 text-sm"><option value="active">Approved</option><option value="pending">Pending</option><option value="suspended">Suspended</option><option value="rejected">Rejected</option></select></div>
      </div>
    </section>
    <section className="rounded-2xl border border-border bg-card p-4">
      <Label>Assigned outlets</Label><p className="mt-1 text-xs text-muted-foreground">The primary outlet controls the default data patch and first page. Additional outlets remain available for reports and manager access.</p>
      <div className="mt-3 grid gap-2 sm:grid-cols-2">{outlets.map((outlet) => { const checked = outletIds.has(String(outlet.id)); return <label key={outlet.id} className={`flex cursor-pointer items-center gap-3 rounded-xl border p-3 ${checked ? "border-primary bg-primary/5" : "border-border"}`}><input type="checkbox" checked={checked} onChange={() => toggleOutlet(String(outlet.id))} className="h-4 w-4 accent-primary" /><span className="min-w-0 flex-1 truncate text-sm font-medium">{outletLabel(outlet, outlet.id)}</span>{checked ? <input type="radio" name="primaryOutlet" checked={primaryOutlet === String(outlet.id)} onChange={() => setPrimaryOutlet(String(outlet.id))} title="Set as primary outlet" className="h-4 w-4 accent-primary" /> : null}</label> })}</div>
    </section>
    {error ? <p className="rounded-xl bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p> : null}
    <div className="grid grid-cols-2 gap-2"><Button type="button" variant="outline" onClick={onCancel} disabled={saving}>Cancel</Button><Button type="submit" disabled={saving}>{saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <UserCheck className="mr-2 h-4 w-4" />}Save access</Button></div>
  </form>;
}

function PushForm({ recipientIds, onCancel, onDone }) {
  const [form, setForm] = useState({ title: "", message: "", target_page: "/", action_label: "Open", priority: "normal" });
  const [publishDataPatch, setPublishDataPatch] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const submit = async (event) => {
    event.preventDefault();
    setSaving(true);
    setError("");
    try {
      let packRelease = null;
      if (publishDataPatch) packRelease = await opsClient.app.rebuildAllPacks();
      const result = await opsClient.notifications.push({
        ...form,
        recipient_user_ids: recipientIds,
        metadata: {
          invalidate: [form.target_page],
          data_pack_update: publishDataPatch,
          data_pack_released_at: packRelease?.generated_at || "",
          data_pack_versions: packRelease?.packs || [],
        },
      });
      onDone(Number(result?.created || recipientIds.length));
    } catch (err) {
      setError(err.message || "Unable to push notification");
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-3">
      <section className="space-y-3 rounded-2xl border border-border bg-card p-3.5">
        <div className="space-y-1.5"><Label>Title</Label><Input className="h-10 rounded-xl" value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} placeholder="e.g. New checklist published" required autoFocus /></div>
        <div className="space-y-1.5"><Label>Message</Label><Textarea className="min-h-20 rounded-xl" value={form.message} onChange={(event) => setForm({ ...form, message: event.target.value })} placeholder="What changed and what should the user do?" required /></div>
        <div className="grid grid-cols-2 gap-2.5">
          <div className="space-y-1.5"><Label>Target page</Label><select className="h-10 w-full rounded-xl border border-input bg-background px-3 text-sm" value={form.target_page} onChange={(event) => setForm({ ...form, target_page: event.target.value })}>{PAGE_OPTIONS.map((page) => <option key={page.value} value={page.value}>{page.label}</option>)}</select></div>
          <div className="space-y-1.5"><Label>Button label</Label><Input className="h-10 rounded-xl" value={form.action_label} onChange={(event) => setForm({ ...form, action_label: event.target.value })} /></div>
        </div>
        <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-border bg-muted/40 p-3">
          <input type="checkbox" checked={publishDataPatch} onChange={(event) => setPublishDataPatch(event.target.checked)} className="mt-0.5 h-4 w-4 rounded border-input accent-primary" />
          <span><span className="block text-sm font-medium">Publish latest data patch first</span><span className="mt-0.5 block text-xs leading-5 text-muted-foreground">Builds one shared JSON patch, then the selected staff receive this notification and download only changed modules.</span></span>
        </label>
      </section>
      {error ? <p className="rounded-xl border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p> : null}
      <div className="grid grid-cols-[0.8fr_1.2fr] gap-2.5"><Button type="button" variant="outline" className="h-11 rounded-xl" onClick={onCancel} disabled={saving}>Cancel</Button><Button type="submit" className="h-11 rounded-xl" disabled={saving || !recipientIds.length}>{saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Bell className="mr-2 h-4 w-4" />}{saving ? "Pushing…" : "Push now"}</Button></div>
    </form>
  );
}
