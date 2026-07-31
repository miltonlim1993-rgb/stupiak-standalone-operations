import { useEffect, useMemo, useState } from "react";
import { opsClient } from "@/api/opsClient";
import { useAuth } from "@/lib/AuthContext";
import { formatDate, todayStr } from "@/lib/ops-helpers";
import { outletLabel, parseOutletIds } from "@/lib/outlets";
import {
  AlertTriangle,
  Boxes,
  CalendarDays,
  CheckCircle2,
  ChevronDown,
  Clock3,
  History,
  Loader2,
  Package,
  PackageMinus,
  Plus,
  RefreshCw,
  Save,
  Search,
  SlidersHorizontal,
  Store,
  UserRound,
} from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import MobileSheet from "@/components/MobileSheet";
import PageNotifications from "@/components/PageNotifications";

const SECTION_ORDER = ["Inventory", "Untensil PG1", "Utensil PG2", "Stationary"];
const EDIT_ROLES = new Set(["supervisor", "manager", "owner"]);
const STATUS_ORDER = { low: 0, not_counted: 1, below_target: 2, healthy: 3, no_minimum: 4 };
const STATUS_FILTERS = [
  { value: "all", label: "All" },
  { value: "low", label: "Low stock" },
  { value: "below_target", label: "Below target" },
  { value: "healthy", label: "Healthy" },
  { value: "not_counted", label: "Never counted" },
];

function sectionRank(section) {
  const index = SECTION_ORDER.indexOf(section);
  return index === -1 ? SECTION_ORDER.length : index;
}

function prettyNumber(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "0";
  return Number.isInteger(number) ? String(number) : number.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}

function countAliases(record = {}) {
  const aliases = [];
  const stockListId = String(record.stock_list_id || "").trim();
  const itemId = String(record.item_id || "").trim();
  const itemName = String(record.item_name || "").trim().toLowerCase();
  if (stockListId) aliases.push(`list:${stockListId}`);
  if (itemId) aliases.push(`item:${itemId}`);
  if (itemName) aliases.push(`name:${itemName}`);
  return aliases;
}

function stockState(item) {
  if (item.latest_actual_qty === "" || item.latest_actual_qty == null) return "not_counted";
  const actual = Number(item.latest_actual_qty || 0);
  const minimum = Number(item.minimum_qty || 0);
  const target = Number(item.target_qty || 0);
  if (minimum <= 0) return "no_minimum";
  if (actual <= minimum) return "low";
  if (target > minimum && actual < target) return "below_target";
  return "healthy";
}

function statusMeta(value) {
  if (value === "low") return { label: "Low stock", badge: "bg-red-100 text-red-700", card: "border-red-300 bg-red-50/35", icon: AlertTriangle };
  if (value === "below_target") return { label: "Below target", badge: "bg-amber-100 text-amber-700", card: "border-amber-200 bg-amber-50/25", icon: PackageMinus };
  if (value === "not_counted") return { label: "Never counted", badge: "bg-slate-100 text-slate-700", card: "border-slate-300", icon: History };
  if (value === "no_minimum") return { label: "No minimum", badge: "bg-blue-100 text-blue-700", card: "border-border", icon: Boxes };
  return { label: "Healthy", badge: "bg-emerald-100 text-emerald-700", card: "border-emerald-200 bg-emerald-50/20", icon: CheckCircle2 };
}

function dateAge(asOfDate, countDate) {
  if (!countDate) return "";
  const end = Date.parse(`${asOfDate}T00:00:00Z`);
  const start = Date.parse(`${countDate}T00:00:00Z`);
  if (!Number.isFinite(end) || !Number.isFinite(start)) return "";
  const days = Math.max(0, Math.round((end - start) / 86_400_000));
  if (days === 0) return "on selected date";
  return `${days} day${days === 1 ? "" : "s"} before`;
}

async function loadCountHistory(outletId, selectedDate) {
  const selectedYear = Number(String(selectedDate).slice(0, 4));
  const years = [selectedYear, selectedYear - 1].filter((year, index, values) => year > 2020 && values.indexOf(year) === index);
  const results = await Promise.allSettled(years.map((year) => (
    opsClient.entities.StockCount.filter(
      { outlet_id: outletId, count_date: { $lte: selectedDate } },
      "-count_date,-updated_date",
      5000,
      { year },
    )
  )));
  const rows = results.flatMap((result) => result.status === "fulfilled" ? (result.value || []) : []);
  const failed = results.filter((result) => result.status === "rejected");
  return {
    rows: rows.sort((a, b) => String(b.count_date || "").localeCompare(String(a.count_date || "")) || String(b.updated_date || "").localeCompare(String(a.updated_date || ""))),
    warning: rows.length === 0 && failed.length === results.length
      ? (failed[0]?.reason?.message || "Unable to load stock count history")
      : "",
  };
}

export default function Inventory() {
  const { user } = useAuth();
  const assignedOutletIds = useMemo(() => parseOutletIds(user), [user]);
  const [outlets, setOutlets] = useState([]);
  const [selectedOutletId, setSelectedOutletId] = useState(user?.outlet_id || assignedOutletIds[0] || "");
  const [selectedDate, setSelectedDate] = useState(todayStr());
  const [items, setItems] = useState([]);
  const [search, setSearch] = useState("");
  const [section, setSection] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [warning, setWarning] = useState("");
  const [drawerOpen, setDrawerOpen] = useState(false);
  const canEdit = EDIT_ROLES.has(String(user?.role || ""));

  useEffect(() => {
    opsClient.entities.Outlet.list("name", 100)
      .then((rows) => {
        const all = rows || [];
        const visible = ["manager", "owner"].includes(user?.role)
          ? all
          : all.filter((row) => assignedOutletIds.includes(String(row.id)));
        setOutlets(visible);
        setSelectedOutletId((current) => visible.some((row) => row.id === current)
          ? current
          : (visible.find((row) => row.id === user?.outlet_id)?.id || visible[0]?.id || ""));
      })
      .catch(() => setOutlets([]));
  }, [assignedOutletIds, user?.outlet_id, user?.role]);

  const loadItems = async (outletId = selectedOutletId, asOfDate = selectedDate) => {
    if (!outletId) {
      setItems([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError("");
    setWarning("");
    try {
      const [stockListRows, countHistory] = await Promise.all([
        opsClient.entities.OutletStockList.filter(
          { outlet_id: outletId, enabled: true },
          "section,display_order",
          1000,
        ),
        loadCountHistory(outletId, asOfDate),
      ]);

      const latestByAlias = new Map();
      for (const count of countHistory.rows) {
        for (const alias of countAliases(count)) {
          if (!latestByAlias.has(alias)) latestByAlias.set(alias, count);
        }
      }

      const merged = (stockListRows || []).map((stockList) => {
        const latest = countAliases(stockList).map((alias) => latestByAlias.get(alias)).find(Boolean);
        const item = {
          ...stockList,
          latest_actual_qty: latest?.actual_qty ?? "",
          latest_count_date: latest?.count_date || "",
          latest_counted_by: latest?.counted_by || "",
          latest_counted_by_email: latest?.counted_by_email || latest?.created_by || "",
          latest_count_id: latest?.id || "",
        };
        item.stock_state = stockState(item);
        return item;
      }).sort((a, b) => (
        sectionRank(a.section) - sectionRank(b.section)
        || Number(STATUS_ORDER[a.stock_state] ?? 9) - Number(STATUS_ORDER[b.stock_state] ?? 9)
        || Number(a.display_order || 0) - Number(b.display_order || 0)
        || String(a.item_name || "").localeCompare(String(b.item_name || ""))
      ));

      setItems(merged);
      setWarning(countHistory.warning);
    } catch (err) {
      setError(err.message || "Unable to load stock list");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadItems(selectedOutletId, selectedDate);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedOutletId, selectedDate]);

  const selectedOutlet = outlets.find((row) => row.id === selectedOutletId);
  const availableSections = useMemo(() => {
    const seen = new Set(items.map((item) => item.section || "Other"));
    return [...SECTION_ORDER.filter((value) => seen.has(value)), ...[...seen].filter((value) => !SECTION_ORDER.includes(value)).sort()];
  }, [items]);

  const statusCounts = useMemo(() => {
    const counts = { all: items.length, low: 0, below_target: 0, healthy: 0, not_counted: 0 };
    for (const item of items) {
      if (item.stock_state === "low") counts.low += 1;
      else if (item.stock_state === "below_target") counts.below_target += 1;
      else if (item.stock_state === "not_counted") counts.not_counted += 1;
      else counts.healthy += 1;
    }
    return counts;
  }, [items]);

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    return items.filter((item) => {
      const sectionOk = section === "all" || String(item.section || "Other") === section;
      const statusOk = statusFilter === "all"
        || item.stock_state === statusFilter
        || (statusFilter === "healthy" && item.stock_state === "no_minimum");
      const searchOk = !term || `${item.item_name} ${item.section} ${item.category} ${item.latest_counted_by}`.toLowerCase().includes(term);
      return sectionOk && statusOk && searchOk;
    });
  }, [items, search, section, statusFilter]);

  const groups = useMemo(() => {
    const result = new Map();
    filtered.forEach((item) => {
      const itemSection = item.section || "Other";
      if (!result.has(itemSection)) result.set(itemSection, []);
      result.get(itemSection).push(item);
    });
    return [...result.entries()].sort((a, b) => sectionRank(a[0]) - sectionRank(b[0]));
  }, [filtered]);

  return (
    <div className="chefops-page inventory-page mx-auto w-full max-w-6xl space-y-4 p-4 pb-24">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-heading font-bold">Outlet Stock List</h1>
          <p className="mt-0.5 text-xs text-muted-foreground">Latest counted quantity and stock status as of {formatDate(selectedDate)}.</p>
        </div>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" className="h-9 rounded-xl px-3" onClick={() => loadItems(selectedOutletId, selectedDate)} disabled={loading || !selectedOutletId}>
            <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
          </Button>
          {canEdit && selectedOutletId ? (
            <Button size="sm" className="h-9 rounded-xl px-3" onClick={() => setDrawerOpen(true)}>
              <Plus className="mr-1 h-4 w-4" /> Add
            </Button>
          ) : null}
        </div>
      </div>

      <PageNotifications page="/inventory" limit={2} />

      <section className="grid gap-3 rounded-2xl border border-border bg-card p-3 sm:grid-cols-2">
        <div>
          <div className="mb-2 flex items-center gap-2"><Store className="h-4 w-4 text-primary" /><p className="text-sm font-semibold">Outlet</p></div>
          {outlets.length > 1 ? (
            <select value={selectedOutletId} onChange={(event) => setSelectedOutletId(event.target.value)} className="h-11 w-full rounded-xl border border-input bg-background px-3 text-sm">
              {outlets.map((outlet) => <option key={outlet.id} value={outlet.id}>{outletLabel(outlet, outlet.id)}</option>)}
            </select>
          ) : (
            <div className="flex h-11 items-center rounded-xl bg-muted/55 px-3 text-sm font-medium">{outletLabel(outlets[0], outlets[0]?.id) || "No outlet assigned"}</div>
          )}
        </div>
        <div>
          <div className="mb-2 flex items-center gap-2"><CalendarDays className="h-4 w-4 text-primary" /><p className="text-sm font-semibold">Stock as of date</p></div>
          <Input type="date" value={selectedDate} max={todayStr()} onChange={(event) => setSelectedDate(event.target.value || todayStr())} className="h-11 rounded-xl" />
        </div>
      </section>

      <section className="grid grid-cols-2 gap-2 lg:grid-cols-5">
        <SummaryCard label="List items" value={statusCounts.all} icon={Boxes} active={statusFilter === "all"} onClick={() => setStatusFilter("all")} />
        <SummaryCard label="Low stock" value={statusCounts.low} icon={AlertTriangle} danger active={statusFilter === "low"} onClick={() => setStatusFilter("low")} />
        <SummaryCard label="Below target" value={statusCounts.below_target} icon={PackageMinus} warning active={statusFilter === "below_target"} onClick={() => setStatusFilter("below_target")} />
        <SummaryCard label="Healthy" value={statusCounts.healthy} icon={CheckCircle2} success active={statusFilter === "healthy"} onClick={() => setStatusFilter("healthy")} />
        <SummaryCard label="Never counted" value={statusCounts.not_counted} icon={History} active={statusFilter === "not_counted"} onClick={() => setStatusFilter("not_counted")} />
      </section>

      <div className="chefops-sticky-tools chefops-inventory-toolbar space-y-2.5">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search item, category or counter" className="h-10 rounded-xl pl-9" />
        </div>
        <div className="chefops-hide-scrollbar flex gap-2 overflow-x-auto pb-0.5">
          {STATUS_FILTERS.map((option) => (
            <button key={option.value} type="button" onClick={() => setStatusFilter(option.value)} className={`whitespace-nowrap rounded-full px-3 py-1.5 text-xs font-medium ${statusFilter === option.value ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"}`}>
              {option.label} {statusCounts[option.value] ?? 0}
            </button>
          ))}
        </div>
        <div className="chefops-hide-scrollbar flex gap-2 overflow-x-auto pb-0.5">
          <button type="button" onClick={() => setSection("all")} className={`whitespace-nowrap rounded-full px-3 py-1.5 text-xs font-medium ${section === "all" ? "bg-foreground text-background" : "bg-muted text-muted-foreground"}`}>All sections</button>
          {availableSections.map((value) => {
            const count = items.filter((item) => String(item.section || "Other") === value).length;
            return <button key={value} type="button" onClick={() => setSection(value)} className={`whitespace-nowrap rounded-full px-3 py-1.5 text-xs font-medium ${section === value ? "bg-foreground text-background" : "bg-muted text-muted-foreground"}`}>{value} {count}</button>;
          })}
        </div>
      </div>

      {warning ? <div className="rounded-xl border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800">Stock list loaded, but count history could not be fully checked: {warning}</div> : null}
      {error ? <div className="rounded-xl border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</div> : null}

      {loading ? (
        <div className="flex justify-center py-10"><Loader2 className="h-7 w-7 animate-spin text-muted-foreground" /></div>
      ) : !selectedOutletId ? (
        <Empty title="No outlet assigned" body="Ask a manager to assign an outlet to this account." />
      ) : items.length === 0 ? (
        <Empty title="No list items" body={canEdit ? "Tap Add to build this outlet's stock list." : "A supervisor or manager must add the first item."} />
      ) : groups.length === 0 ? (
        <div className="rounded-2xl border border-dashed py-10 text-center text-sm text-muted-foreground">No stock items match these filters.</div>
      ) : (
        <div className="space-y-5">
          {groups.map(([itemSection, sectionItems]) => (
            <section key={itemSection} className="space-y-2">
              <div className="flex items-center justify-between border-b border-border pb-2">
                <h2 className="text-sm font-bold">{itemSection}</h2>
                <span className="rounded-full bg-muted px-2 py-1 text-[10px] text-muted-foreground">{sectionItems.length} shown</span>
              </div>
              <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
                {sectionItems.map((item) => <StockItemCard key={item.stock_list_id} item={item} selectedDate={selectedDate} />)}
              </div>
            </section>
          ))}
        </div>
      )}

      <MobileSheet
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        title="Add stock item"
        description={`Add to ${outletLabel(selectedOutlet, selectedOutletId) || "this outlet"}. Advanced purchasing fields are optional.`}
      >
        <AddInventoryItemForm
          outletId={selectedOutletId}
          onCancel={() => setDrawerOpen(false)}
          onDone={async () => {
            setDrawerOpen(false);
            await loadItems(selectedOutletId, selectedDate);
          }}
        />
      </MobileSheet>
    </div>
  );
}

function StockItemCard({ item, selectedDate }) {
  const meta = statusMeta(item.stock_state);
  const StatusIcon = meta.icon;
  const hasCount = item.latest_actual_qty !== "" && item.latest_actual_qty != null;
  return (
    <article className={`rounded-2xl border bg-card p-4 ${meta.card}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-bold">{item.item_name}</p>
          <p className="mt-0.5 truncate text-[11px] text-muted-foreground">{item.category || item.section || "Stock item"}</p>
        </div>
        <span className={`flex shrink-0 items-center gap-1 rounded-full px-2 py-1 text-[10px] font-semibold ${meta.badge}`}><StatusIcon className="h-3 w-3" />{meta.label}</span>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-2">
        <div className="rounded-xl bg-background/80 p-3">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Latest quantity</p>
          <p className={`mt-1 text-2xl font-bold ${item.stock_state === "low" ? "text-red-700" : ""}`}>{hasCount ? prettyNumber(item.latest_actual_qty) : "—"}</p>
          <p className="text-[11px] text-muted-foreground">{item.count_uom || "unit"}</p>
        </div>
        <div className="rounded-xl bg-background/80 p-3">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Minimum / target</p>
          <p className="mt-1 text-sm font-bold">{prettyNumber(item.minimum_qty)} / {Number(item.target_qty || 0) > 0 ? prettyNumber(item.target_qty) : "—"}</p>
          <p className="mt-1 text-[11px] text-muted-foreground">{item.count_uom || "unit"}</p>
        </div>
      </div>

      <div className="mt-3 space-y-2 border-t border-border/70 pt-3 text-xs">
        <div className="flex items-start gap-2">
          <Clock3 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <div className="min-w-0"><p className="font-medium">{item.latest_count_date ? `Last counted ${formatDate(item.latest_count_date)}` : "Never counted"}</p>{item.latest_count_date ? <p className="text-[11px] text-muted-foreground">{dateAge(selectedDate, item.latest_count_date)}</p> : <p className="text-[11px] text-muted-foreground">No Stock Count exists on or before this date.</p>}</div>
        </div>
        {item.latest_counted_by || item.latest_counted_by_email ? (
          <div className="flex items-center gap-2 text-muted-foreground"><UserRound className="h-3.5 w-3.5 shrink-0" /><span className="truncate">{item.latest_counted_by || item.latest_counted_by_email}</span></div>
        ) : null}
        {Number(item.units_per_purchase_uom || 0) > 1 ? <p className="text-[11px] text-muted-foreground">1 {item.purchase_uom} = {prettyNumber(item.units_per_purchase_uom)} {item.count_uom}</p> : null}
      </div>
    </article>
  );
}

function SummaryCard({ label, value, icon: Icon, danger = false, warning: warningState = false, success = false, active = false, onClick }) {
  const tone = danger ? "text-red-700" : warningState ? "text-amber-700" : success ? "text-emerald-700" : "text-foreground";
  return (
    <button type="button" onClick={onClick} className={`rounded-2xl border bg-card p-3 text-left transition ${active ? "border-primary ring-1 ring-primary/30" : "border-border"}`}>
      <div className="flex items-center justify-between gap-2"><Icon className={`h-4 w-4 ${tone}`} /><span className={`text-xl font-bold ${tone}`}>{value}</span></div>
      <p className="mt-2 text-[11px] font-medium text-muted-foreground">{label}</p>
    </button>
  );
}

function AddInventoryItemForm({ outletId, onCancel, onDone }) {
  const [form, setForm] = useState({
    item_name: "",
    section: "Inventory",
    category: "",
    count_uom: "Unit",
    purchase_uom: "Unit",
    units_per_purchase_uom: "1",
    minimum_qty: "0",
    target_qty: "0",
    minimum_order_qty: "0",
    notes: "",
  });
  const [advanced, setAdvanced] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const submit = async (event) => {
    event.preventDefault();
    setSaving(true);
    setError("");
    try {
      await opsClient.inventory.addOutletItem({
        outlet_id: outletId,
        ...form,
        units_per_purchase_uom: Number(form.units_per_purchase_uom || 1),
        minimum_qty: Number(form.minimum_qty || 0),
        target_qty: Number(form.target_qty || 0),
        minimum_order_qty: Number(form.minimum_order_qty || 0),
      });
      await onDone();
    } catch (err) {
      setError(err.message || "Unable to add inventory item");
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-3">
      <section className="space-y-3 rounded-2xl border border-border bg-card p-3.5">
        <div className="space-y-1.5">
          <Label htmlFor="inventory-item-name">Item name</Label>
          <Input id="inventory-item-name" className="h-10 rounded-xl" value={form.item_name} onChange={(event) => setForm({ ...form, item_name: event.target.value })} placeholder="e.g. Cooking Oil" required autoFocus />
        </div>
        <div className="grid grid-cols-2 gap-2.5">
          <div className="space-y-1.5">
            <Label>Section</Label>
            <select className="h-10 w-full rounded-xl border border-input bg-background px-3 text-sm" value={form.section} onChange={(event) => setForm({ ...form, section: event.target.value })}>
              {SECTION_ORDER.map((itemSection) => <option key={itemSection} value={itemSection}>{itemSection}</option>)}
            </select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="inventory-category">Category</Label>
            <Input id="inventory-category" className="h-10 rounded-xl" value={form.category} onChange={(event) => setForm({ ...form, category: event.target.value })} placeholder="Dry goods" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="count-uom">Count unit</Label>
            <Input id="count-uom" className="h-10 rounded-xl" value={form.count_uom} onChange={(event) => setForm({ ...form, count_uom: event.target.value })} required />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="minimum-qty">Minimum</Label>
            <Input id="minimum-qty" type="number" min="0" step="0.01" className="h-10 rounded-xl" value={form.minimum_qty} onChange={(event) => setForm({ ...form, minimum_qty: event.target.value })} />
          </div>
        </div>
      </section>

      <button type="button" onClick={() => setAdvanced((value) => !value)} className="flex h-11 w-full items-center justify-between rounded-xl border border-border bg-muted/35 px-3 text-sm font-medium">
        <span className="flex items-center gap-2"><SlidersHorizontal className="h-4 w-4 text-muted-foreground" /> Purchasing & advanced</span>
        <ChevronDown className={`h-4 w-4 transition ${advanced ? "rotate-180" : ""}`} />
      </button>

      {advanced ? (
        <section className="space-y-3 rounded-2xl border border-border bg-card p-3.5">
          <div className="grid grid-cols-2 gap-2.5">
            <div className="space-y-1.5">
              <Label htmlFor="purchase-uom">Purchase unit</Label>
              <Input id="purchase-uom" className="h-10 rounded-xl" value={form.purchase_uom} onChange={(event) => setForm({ ...form, purchase_uom: event.target.value })} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="unit-conversion">Units per purchase</Label>
              <Input id="unit-conversion" type="number" min="0.0001" step="0.0001" className="h-10 rounded-xl" value={form.units_per_purchase_uom} onChange={(event) => setForm({ ...form, units_per_purchase_uom: event.target.value })} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="target-qty">Target</Label>
              <Input id="target-qty" type="number" min="0" step="0.01" className="h-10 rounded-xl" value={form.target_qty} onChange={(event) => setForm({ ...form, target_qty: event.target.value })} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="minimum-order">Min. order</Label>
              <Input id="minimum-order" type="number" min="0" step="0.01" className="h-10 rounded-xl" value={form.minimum_order_qty} onChange={(event) => setForm({ ...form, minimum_order_qty: event.target.value })} />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="inventory-notes">Notes</Label>
            <Textarea id="inventory-notes" className="min-h-16 rounded-xl" value={form.notes} onChange={(event) => setForm({ ...form, notes: event.target.value })} placeholder="Brand, storage location or ordering note" />
          </div>
        </section>
      ) : null}

      {error ? <p className="rounded-xl border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p> : null}

      <div className="grid grid-cols-[0.8fr_1.2fr] gap-2.5 pt-1">
        <Button type="button" variant="outline" className="h-11 rounded-xl" disabled={saving} onClick={onCancel}>Cancel</Button>
        <Button type="submit" className="h-11 rounded-xl" disabled={saving}>
          {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
          {saving ? "Saving…" : "Add item"}
        </Button>
      </div>
    </form>
  );
}

function Empty({ title, body }) {
  return <div className="rounded-2xl border border-dashed p-10 text-center"><Package className="mx-auto mb-2 h-10 w-10 text-muted-foreground" /><p className="font-medium">{title}</p><p className="mt-1 text-sm text-muted-foreground">{body}</p></div>;
}
