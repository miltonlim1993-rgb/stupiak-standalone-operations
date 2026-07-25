import { useEffect, useMemo, useState } from "react";
import { opsClient } from "@/api/opsClient";
import { useAuth } from "@/lib/AuthContext";
import { formatDate, todayStr } from "@/lib/ops-helpers";
import { outletLabel, parseOutletIds } from "@/lib/outlets";
import {
  AlertTriangle,
  CheckCircle2,
  CircleDashed,
  Info,
  Loader2,
  Package,
  PackageCheck,
  PackageMinus,
  RefreshCw,
  Save,
  Search,
  Store,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

const STOCK_SECTION_ORDER = ["Inventory", "Untensil PG1", "Utensil PG2", "Stationary"];

function numberValue(value, fallback = 0) {
  if (value === "" || value == null) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function prettyNumber(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "0";
  return Number.isInteger(number) ? String(number) : number.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}

function quantityDisplay(qty, item) {
  if (qty === "" || qty == null) return "No previous count";
  const amount = numberValue(qty);
  const ratio = numberValue(item.units_per_purchase_uom, 1);
  const countUom = item.count_uom || "unit";
  const purchaseUom = item.purchase_uom || countUom;
  if (ratio > 1 && purchaseUom !== countUom) {
    const full = Math.floor(amount / ratio);
    const remainder = amount - full * ratio;
    if (full > 0 && Math.abs(remainder) < 0.000001) return `${prettyNumber(full)} ${purchaseUom}`;
    if (full > 0) return `${prettyNumber(full)} ${purchaseUom} + ${prettyNumber(remainder)} ${countUom}`;
  }
  return `${prettyNumber(amount)} ${countUom}`;
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

function latestState(item) {
  const qty = item.actual_qty === "" || item.actual_qty == null ? item.previous_qty : item.actual_qty;
  if (qty === "" || qty == null) return "not_counted";
  const minimum = numberValue(item.minimum_qty);
  const target = numberValue(item.target_qty);
  const actual = numberValue(qty);
  if (minimum <= 0) return "no_minimum";
  if (actual <= minimum) return "low";
  if (target > minimum && actual < target) return "below_target";
  return "healthy";
}

function sectionRank(section) {
  const index = STOCK_SECTION_ORDER.indexOf(section);
  return index === -1 ? STOCK_SECTION_ORDER.length : index;
}

function selectionCacheKey(user) {
  return `stupiaks_ops.stock_outlet.${user?.email || "user"}`;
}

export default function StockCount() {
  const { user } = useAuth();
  const assignedOutletIds = useMemo(() => parseOutletIds(user), [user]);
  const [selectedDate, setSelectedDate] = useState(todayStr());
  const [outlets, setOutlets] = useState([]);
  const [selectedOutletId, setSelectedOutletId] = useState(() => {
    const cached = localStorage.getItem(selectionCacheKey(user));
    return cached || user?.outlet_id || assignedOutletIds[0] || "";
  });
  const [items, setItems] = useState([]);
  const [changedIds, setChangedIds] = useState(() => new Set());
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [search, setSearch] = useState("");
  const [section, setSection] = useState("all");
  const [invalidId, setInvalidId] = useState("");

  useEffect(() => {
    opsClient.entities.Outlet.list("name", 100)
      .then((rows) => {
        const visible = (rows || []).filter((row) => assignedOutletIds.includes(String(row.id)));
        setOutlets(visible);
        setSelectedOutletId((current) => (
          visible.some((row) => row.id === current)
            ? current
            : (visible.find((row) => row.id === user?.outlet_id)?.id || visible[0]?.id || "")
        ));
      })
      .catch(() => setOutlets([]));
  }, [assignedOutletIds, user?.outlet_id]);

  useEffect(() => {
    if (selectedOutletId) {
      localStorage.setItem(selectionCacheKey(user), selectedOutletId);
      loadItems();
    } else {
      setItems([]);
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedDate, selectedOutletId]);

  async function loadItems() {
    setLoading(true);
    setError("");
    setMessage("");
    try {
      const year = Number(selectedDate.slice(0, 4));
      const [stockListRows, countRows] = await Promise.all([
        opsClient.entities.OutletStockList.filter(
          { outlet_id: selectedOutletId, enabled: true },
          "section,display_order",
          1000,
        ),
        opsClient.entities.StockCount.filter(
          { outlet_id: selectedOutletId, count_date: { $lte: selectedDate } },
          "-count_date",
          1000,
          { year },
        ),
      ]);

      const todayByAlias = new Map();
      const previousByAlias = new Map();
      for (const count of countRows || []) {
        const countDate = String(count.count_date || "");
        for (const alias of countAliases(count)) {
          if (countDate === selectedDate && !todayByAlias.has(alias)) todayByAlias.set(alias, count);
          if (countDate < selectedDate && !previousByAlias.has(alias)) previousByAlias.set(alias, count);
        }
      }

      const merged = (stockListRows || [])
        .sort((a, b) => sectionRank(a.section) - sectionRank(b.section) || numberValue(a.display_order) - numberValue(b.display_order))
        .map((stockList) => {
          const aliases = countAliases(stockList);
          const todayCount = aliases.map((alias) => todayByAlias.get(alias)).find(Boolean);
          const previousCount = aliases.map((alias) => previousByAlias.get(alias)).find(Boolean);
          return {
            ...stockList,
            id: stockList.stock_list_id,
            previous_qty: todayCount?.expected_qty !== "" && todayCount?.expected_qty != null
              ? todayCount.expected_qty
              : (previousCount?.actual_qty ?? ""),
            actual_qty: todayCount?.actual_qty ?? "",
            count_id: todayCount?.id || "",
            counted_by: todayCount?.counted_by || "",
            counted_by_email: todayCount?.counted_by_email || todayCount?.created_by || "",
          };
        });

      setItems(merged);
      setChangedIds(new Set());
    } catch (loadError) {
      setError(loadError.message || "Unable to load this outlet's stock list");
    } finally {
      setLoading(false);
    }
  }

  function changeActualQty(id, value) {
    if (value !== "" && (!Number.isFinite(Number(value)) || Number(value) < 0)) return;
    setItems((current) => current.map((item) => {
      if (item.id !== id) return item;
      return { ...item, actual_qty: value === "" ? "" : Number(value) };
    }));
    setChangedIds((current) => new Set([...current, id]));
    setMessage("");
    if (invalidId === id && value !== "") setInvalidId("");
  }

  function focusMissingItem(item, missingCount) {
    setSearch("");
    setSection("all");
    setInvalidId(item.id);
    setError(`${missingCount} stock item${missingCount === 1 ? " is" : "s are"} still not counted. Complete every item before saving.`);
    setMessage("");
    if (typeof navigator !== "undefined" && typeof navigator.vibrate === "function") navigator.vibrate([90, 45, 90]);
    window.setTimeout(() => {
      const safeId = String(item.id || "").replace(/[^a-zA-Z0-9_-]+/g, "-");
      const input = document.getElementById(`stock-actual-${safeId}`);
      const card = document.getElementById(`stock-card-${safeId}`);
      card?.scrollIntoView({ behavior: "smooth", block: "center" });
      window.setTimeout(() => input?.focus({ preventScroll: true }), 320);
    }, 40);
  }

  async function saveCount() {
    const missingItems = items.filter((item) => item.actual_qty === "" || item.actual_qty == null);
    if (missingItems.length) {
      focusMissingItem(missingItems[0], missingItems.length);
      return;
    }

    const changedItems = items.filter((item) => changedIds.has(item.id));
    if (!changedItems.length) {
      setError("");
      setMessage("All stock items are already saved for this date.");
      return;
    }

    setSaving(true);
    setError("");
    setMessage("");
    try {
      const result = await opsClient.stockCounts.saveBatch({
        count_date: selectedDate,
        outlet_id: selectedOutletId,
        items: changedItems.map((item) => ({ stock_list_id: item.stock_list_id, actual_qty: numberValue(item.actual_qty) })),
      });
      const savedMessage = `${result.saved || changedItems.length} of ${result.list_items || items.length} list items saved.`;
      await loadItems();
      setMessage(savedMessage);
    } catch (saveError) {
      setError(saveError.message || "Unable to save stock count");
    } finally {
      setSaving(false);
    }
  }

  const selectedOutlet = outlets.find((row) => row.id === selectedOutletId);
  const outletName = outletLabel(selectedOutlet, selectedOutletId);

  const availableSections = useMemo(() => {
    const found = new Set(items.map((item) => item.section || "Other"));
    return [...STOCK_SECTION_ORDER.filter((value) => found.has(value)), ...[...found].filter((value) => !STOCK_SECTION_ORDER.includes(value))];
  }, [items]);

  const groupedVisibleItems = useMemo(() => {
    const term = search.trim().toLowerCase();
    const groups = new Map();
    for (const item of items) {
      const itemSection = item.section || "Other";
      if (section !== "all" && itemSection !== section) continue;
      if (term && !`${item.item_name} ${item.category} ${itemSection}`.toLowerCase().includes(term)) continue;
      if (!groups.has(itemSection)) groups.set(itemSection, []);
      groups.get(itemSection).push(item);
    }
    return [...groups.entries()].sort((a, b) => sectionRank(a[0]) - sectionRank(b[0]));
  }, [items, search, section]);

  const sectionStats = useMemo(() => {
    const stats = new Map();
    for (const item of items) {
      const key = item.section || "Other";
      const current = stats.get(key) || { listItems: 0, counted: 0 };
      current.listItems += 1;
      if (item.actual_qty !== "" && item.actual_qty != null) current.counted += 1;
      stats.set(key, current);
    }
    return stats;
  }, [items]);

  const summary = useMemo(() => {
    const counted = items.filter((item) => item.actual_qty !== "" && item.actual_qty != null).length;
    const order = items.filter((item) => latestState(item) === "low").length;
    return { listItems: items.length, counted, remaining: Math.max(0, items.length - counted), order };
  }, [items]);

  return (
    <div className="chefops-page chefops-stock-page space-y-4 p-4 pb-24">
      <style>{`@keyframes chefops-stock-shake { 0%,100% { transform: translateX(0) } 20% { transform: translateX(-7px) } 40% { transform: translateX(7px) } 60% { transform: translateX(-5px) } 80% { transform: translateX(5px) } } .chefops-stock-shake { animation: chefops-stock-shake .42s ease-in-out; }`}</style>
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-heading font-bold">Stock Count</h1>
          <p className="text-xs text-muted-foreground">{formatDate(selectedDate)} · {outletName || "No outlet assigned"}</p>
        </div>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" onClick={loadItems} disabled={loading || saving}><RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} /></Button>
          <Button size="sm" onClick={saveCount} disabled={saving || !selectedOutletId || loading}>
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            {changedIds.size > 0 ? ` ${changedIds.size}` : ""}
          </Button>
        </div>
      </div>

      <Input type="date" value={selectedDate} onChange={(event) => setSelectedDate(event.target.value)} />

      {outlets.length > 1 ? (
        <section className="rounded-2xl border border-border bg-card p-3">
          <div className="mb-2 flex items-center gap-2"><Store className="h-4 w-4 text-primary" /><p className="text-sm font-semibold">Count one outlet</p></div>
          <select value={selectedOutletId} onChange={(event) => setSelectedOutletId(event.target.value)} className="h-11 w-full rounded-xl border border-input bg-background px-3 text-sm">
            {outlets.map((outlet) => <option key={outlet.id} value={outlet.id}>{outletLabel(outlet, outlet.id)}</option>)}
          </select>
        </section>
      ) : outlets.length === 1 ? (
        <div className="rounded-xl border border-border bg-card px-3 py-2 text-sm font-medium">{outletLabel(outlets[0], outlets[0].id)}</div>
      ) : null}

      {error && <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</div>}
      {message && <div className="rounded-lg border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-200">{message}</div>}

      <div className="grid grid-cols-2 gap-2 text-center">
        <SummaryCard value={summary.listItems} label="List items" />
        <SummaryCard value={summary.counted} label="Counted today" />
        <SummaryCard value={summary.remaining} label="Remaining" />
        <SummaryCard value={summary.order} label="At / below minimum" danger={summary.order > 0} />
      </div>

      <div className="chefops-sticky-tools chefops-stock-toolbar sticky z-40 -mx-4 border-y border-border bg-background/95 px-4 py-3 shadow-sm backdrop-blur">
        <div className="relative"><Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" /><Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search this outlet's list" className="pl-9" /></div>
        <div className="chefops-hide-scrollbar mt-2 flex gap-2 overflow-x-auto pb-0.5">
          <SectionButton active={section === "all"} label="All" count={summary.listItems} onClick={() => setSection("all")} />
          {availableSections.map((value) => {
            const stats = sectionStats.get(value) || { listItems: 0, counted: 0 };
            return <SectionButton key={value} active={section === value} label={value} count={stats.listItems} counted={stats.counted} onClick={() => setSection(value)} />;
          })}
        </div>
      </div>

      {loading ? (
        <div className="flex justify-center py-12"><Loader2 className="h-7 w-7 animate-spin text-muted-foreground" /></div>
      ) : !selectedOutletId ? (
        <Empty title="No outlet assigned" body="Ask a manager to assign at least one outlet to this account." />
      ) : items.length === 0 ? (
        <Empty title="No stock list for this outlet" body="Enable rows for this outlet in ChefOps Master → OutletStockLists." />
      ) : groupedVisibleItems.length === 0 ? (
        <div className="py-10 text-center text-sm text-muted-foreground">No matching list items.</div>
      ) : (
        <div className="space-y-5">
          {groupedVisibleItems.map(([groupName, groupItems]) => (
            <section key={groupName} className="space-y-2">
              <div className="flex items-center justify-between border-b border-border pb-2">
                <div><h2 className="text-sm font-bold">{groupName}</h2><p className="text-[11px] text-muted-foreground">Master stock-list order</p></div>
                <span className="rounded-full bg-muted px-2 py-1 text-[10px] font-medium text-muted-foreground">{groupItems.length} items</span>
              </div>
              {groupItems.map((item, index) => (
                <StockItemCard key={item.stock_list_id} item={item} index={index} changed={changedIds.has(item.id)} invalid={invalidId === item.id} onChange={(value) => changeActualQty(item.id, value)} />
              ))}
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

function StockItemCard({ item, index, changed, invalid, onChange }) {
  const state = latestState(item);
  const safeId = String(item.id || "").replace(/[^a-zA-Z0-9_-]+/g, "-");
  return (
    <div id={`stock-card-${safeId}`} className={`rounded-xl border p-3 transition-colors ${invalid ? "chefops-stock-shake border-red-500 bg-red-50 ring-2 ring-red-300 dark:bg-red-950/35" : changed ? "border-primary/60 bg-card ring-1 ring-primary/20" : "border-border bg-card"}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-1 gap-2.5">
          <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-muted text-[10px] font-semibold text-muted-foreground">{index + 1}</span>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold leading-5">{item.item_name}</p>
            <p className="text-xs text-muted-foreground">Minimum {prettyNumber(item.minimum_qty)} {item.count_uom || "unit"}{numberValue(item.target_qty) > 0 ? ` · Target ${prettyNumber(item.target_qty)}` : ""}</p>
            {numberValue(item.units_per_purchase_uom, 1) > 1 && <p className="mt-0.5 text-xs text-muted-foreground">1 {item.purchase_uom} = {prettyNumber(item.units_per_purchase_uom)} {item.count_uom}</p>}
          </div>
        </div>
        <StockState state={state} />
      </div>

      <div className="mt-3 grid grid-cols-2 gap-3">
        <div><label className="text-[10px] uppercase tracking-wide text-muted-foreground">Previous count</label><div className="mt-1 flex h-10 items-center rounded-md bg-muted px-3 text-sm">{quantityDisplay(item.previous_qty, item)}</div></div>
        <div><label className="text-[10px] uppercase tracking-wide text-muted-foreground">Actual ({item.count_uom || "unit"})</label><Input id={`stock-actual-${safeId}`} type="number" min="0" step="0.01" inputMode="decimal" value={item.actual_qty} onChange={(event) => onChange(event.target.value)} placeholder="Enter count" className={`mt-1 ${invalid ? "border-red-500 bg-red-50 text-red-900 ring-2 ring-red-200 placeholder:text-red-400 dark:bg-red-950/40 dark:text-red-100" : ""}`} aria-invalid={invalid || undefined} /></div>
      </div>
      {item.counted_by && <p className="mt-2 text-[10px] text-muted-foreground">Saved by {item.counted_by}{item.counted_by_email ? ` · ${item.counted_by_email}` : ""}</p>}
    </div>
  );
}

function Empty({ title, body }) {
  return <div className="rounded-xl border border-dashed p-10 text-center"><Package className="mx-auto mb-2 h-10 w-10 text-muted-foreground" /><p className="font-medium">{title}</p><p className="mt-1 text-sm text-muted-foreground">{body}</p></div>;
}

function SectionButton({ active, label, count, counted, onClick }) {
  return <button type="button" onClick={onClick} className={`shrink-0 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors ${active ? "border-primary bg-primary text-primary-foreground" : "border-border bg-background text-foreground hover:bg-muted"}`}><span>{label}</span><span className={`ml-1 ${active ? "text-primary-foreground/75" : "text-muted-foreground"}`}>{counted == null ? count : `${counted}/${count}`}</span></button>;
}

function SummaryCard({ value, label, danger = false }) {
  return <div className={`rounded-lg p-2 ${danger ? "bg-red-50 dark:bg-red-950" : "bg-muted"}`}><p className={`text-lg font-bold ${danger ? "text-red-700 dark:text-red-300" : ""}`}>{value}</p><p className="text-[10px] text-muted-foreground">{label}</p></div>;
}

function StockState({ state }) {
  if (state === "low") return <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-red-200 bg-red-100 px-2 py-1 text-[10px] font-semibold text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200"><AlertTriangle className="h-3 w-3" /> Low</span>;
  if (state === "below_target") return <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-amber-200 bg-amber-100 px-2 py-1 text-[10px] font-semibold text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200"><PackageMinus className="h-3 w-3" /> Below target</span>;
  if (state === "healthy") return <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-emerald-200 bg-emerald-100 px-2 py-1 text-[10px] font-semibold text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-200"><PackageCheck className="h-3 w-3" /> Healthy</span>;
  if (state === "no_minimum") return <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-blue-200 bg-blue-100 px-2 py-1 text-[10px] font-semibold text-blue-800 dark:border-blue-900 dark:bg-blue-950 dark:text-blue-200"><Info className="h-3 w-3" /> No minimum</span>;
  return <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-slate-200 bg-slate-100 px-2 py-1 text-[10px] font-semibold text-slate-600 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-300"><CircleDashed className="h-3 w-3" /> Not counted</span>;
}
