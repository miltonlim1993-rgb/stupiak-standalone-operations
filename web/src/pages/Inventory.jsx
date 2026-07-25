import { useEffect, useMemo, useState } from "react";
import { opsClient } from "@/api/opsClient";
import { useAuth } from "@/lib/AuthContext";
import { outletLabel, parseOutletIds } from "@/lib/outlets";
import { Loader2, Package, Search, Store, Plus, Boxes, Save, ChevronDown, SlidersHorizontal } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import MobileSheet from "@/components/MobileSheet";
import PageNotifications from "@/components/PageNotifications";

const SECTION_ORDER = ["Inventory", "Untensil PG1", "Utensil PG2", "Stationary"];
const EDIT_ROLES = new Set(["supervisor", "manager", "owner"]);

function sectionRank(section) {
  const index = SECTION_ORDER.indexOf(section);
  return index === -1 ? SECTION_ORDER.length : index;
}

function prettyNumber(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "0";
  return Number.isInteger(number) ? String(number) : number.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}

export default function Inventory() {
  const { user } = useAuth();
  const assignedOutletIds = useMemo(() => parseOutletIds(user), [user]);
  const [outlets, setOutlets] = useState([]);
  const [selectedOutletId, setSelectedOutletId] = useState(user?.outlet_id || assignedOutletIds[0] || "");
  const [items, setItems] = useState([]);
  const [search, setSearch] = useState("");
  const [section, setSection] = useState("all");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
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

  const loadItems = async (outletId = selectedOutletId) => {
    if (!outletId) {
      setItems([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError("");
    try {
      const rows = await opsClient.entities.OutletStockList.filter(
        { outlet_id: outletId, enabled: true },
        "section,display_order",
        1000,
      );
      setItems((rows || []).sort((a, b) => sectionRank(a.section) - sectionRank(b.section) || Number(a.display_order || 0) - Number(b.display_order || 0)));
    } catch (err) {
      setError(err.message || "Unable to load stock list");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadItems(selectedOutletId);
  }, [selectedOutletId]);

  const selectedOutlet = outlets.find((row) => row.id === selectedOutletId);
  const availableSections = useMemo(() => {
    const seen = new Set(items.map((item) => item.section || "Other"));
    return [...SECTION_ORDER.filter((value) => seen.has(value)), ...[...seen].filter((value) => !SECTION_ORDER.includes(value)).sort()];
  }, [items]);

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    return items.filter((item) => {
      const sectionOk = section === "all" || String(item.section || "Other") === section;
      const searchOk = !term || `${item.item_name} ${item.section} ${item.category}`.toLowerCase().includes(term);
      return sectionOk && searchOk;
    });
  }, [items, search, section]);

  const groups = useMemo(() => {
    const result = new Map();
    filtered.forEach((item) => {
      const section = item.section || "Other";
      if (!result.has(section)) result.set(section, []);
      result.get(section).push(item);
    });
    return [...result.entries()].sort((a, b) => sectionRank(a[0]) - sectionRank(b[0]));
  }, [filtered]);

  return (
    <div className="chefops-page inventory-page mx-auto max-w-lg space-y-4 p-4 pb-24">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-heading font-bold">Outlet Stock List</h1>
          <p className="mt-0.5 text-xs text-muted-foreground">Items counted by this outlet. Master data stays in Google Sheet.</p>
        </div>
        {canEdit && selectedOutletId ? (
          <Button size="sm" className="h-9 rounded-xl px-3" onClick={() => setDrawerOpen(true)}>
            <Plus className="mr-1 h-4 w-4" /> Add
          </Button>
        ) : null}
      </div>

      <PageNotifications page="/inventory" limit={2} />

      {outlets.length > 1 ? (
        <section className="rounded-2xl border border-border bg-card p-3">
          <div className="mb-2 flex items-center gap-2"><Store className="h-4 w-4 text-primary" /><p className="text-sm font-semibold">Outlet</p></div>
          <select value={selectedOutletId} onChange={(event) => setSelectedOutletId(event.target.value)} className="h-11 w-full rounded-xl border border-input bg-background px-3 text-sm">
            {outlets.map((outlet) => <option key={outlet.id} value={outlet.id}>{outletLabel(outlet, outlet.id)}</option>)}
          </select>
        </section>
      ) : outlets.length === 1 ? (
        <div className="rounded-xl border border-border bg-card px-3 py-2 text-sm font-medium">{outletLabel(outlets[0], outlets[0].id)}</div>
      ) : null}

      <div className="grid grid-cols-[auto_1fr] items-center gap-3 rounded-2xl bg-muted p-3.5">
        <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-background text-primary"><Boxes className="h-5 w-5" /></span>
        <div>
          <p className="text-2xl font-bold leading-none">{items.length}</p>
          <p className="mt-1 text-xs text-muted-foreground">List items for {outletLabel(selectedOutlet, selectedOutletId) || "this outlet"}</p>
        </div>
      </div>

      <div className="chefops-sticky-tools chefops-inventory-toolbar space-y-2.5">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search this outlet's list" className="h-10 rounded-xl pl-9" />
        </div>
        <div className="chefops-hide-scrollbar flex gap-2 overflow-x-auto pb-0.5">
          <button type="button" onClick={() => setSection("all")} className={`whitespace-nowrap rounded-full px-3 py-1.5 text-xs font-medium ${section === "all" ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"}`}>All {items.length}</button>
          {availableSections.map((value) => {
            const count = items.filter((item) => String(item.section || "Other") === value).length;
            return <button key={value} type="button" onClick={() => setSection(value)} className={`whitespace-nowrap rounded-full px-3 py-1.5 text-xs font-medium ${section === value ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"}`}>{value} {count}</button>;
          })}
        </div>
      </div>

      {error ? <div className="rounded-xl border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</div> : null}

      {loading ? (
        <div className="flex justify-center py-10"><Loader2 className="h-7 w-7 animate-spin text-muted-foreground" /></div>
      ) : !selectedOutletId ? (
        <Empty title="No outlet assigned" body="Ask a manager to assign an outlet to this account." />
      ) : items.length === 0 ? (
        <Empty title="No list items" body={canEdit ? "Tap Add to build this outlet's stock list." : "A supervisor or manager must add the first item."} />
      ) : groups.length === 0 ? (
        <div className="py-10 text-center text-sm text-muted-foreground">No matching list items.</div>
      ) : (
        <div className="space-y-5">
          {groups.map(([section, sectionItems]) => (
            <section key={section} className="space-y-2">
              <div className="flex items-center justify-between border-b border-border pb-2">
                <h2 className="text-sm font-bold">{section}</h2>
                <span className="rounded-full bg-muted px-2 py-1 text-[10px] text-muted-foreground">{sectionItems.length} items</span>
              </div>
              {sectionItems.map((item, index) => (
                <div key={item.stock_list_id} className="rounded-2xl border border-border bg-card p-3.5">
                  <div className="flex items-start gap-3">
                    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-muted text-[10px] font-semibold text-muted-foreground">{index + 1}</span>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-semibold">{item.item_name}</p>
                      <p className="mt-1 text-xs text-muted-foreground">Minimum {prettyNumber(item.minimum_qty)} {item.count_uom || "unit"}{Number(item.target_qty || 0) > 0 ? ` · Target ${prettyNumber(item.target_qty)}` : ""}</p>
                      {Number(item.units_per_purchase_uom || 0) > 1 ? <p className="text-xs text-muted-foreground">1 {item.purchase_uom} = {prettyNumber(item.units_per_purchase_uom)} {item.count_uom}</p> : null}
                    </div>
                  </div>
                </div>
              ))}
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
            await loadItems(selectedOutletId);
          }}
        />
      </MobileSheet>
    </div>
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
              {SECTION_ORDER.map((section) => <option key={section} value={section}>{section}</option>)}
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
