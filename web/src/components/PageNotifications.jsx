import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Bell, ChevronRight, X } from "lucide-react";
import { opsClient } from "@/api/opsClient";

function selectRows(rows, page, limit, showAllOnHome) {
  return (rows || []).filter((item) => showAllOnHome || !page || item.target_page === page).slice(0, limit);
}

export default function PageNotifications({ page = "/", limit = 3, showAllOnHome = false }) {
  const navigate = useNavigate();
  const [allItems, setAllItems] = useState(() => window.__chefopsNotifications || []);

  useEffect(() => {
    const listener = (event) => setAllItems(event.detail || []);
    window.addEventListener("chefops:notifications", listener);
    return () => window.removeEventListener("chefops:notifications", listener);
  }, []);

  const items = useMemo(() => selectRows(allItems, page, limit, showAllOnHome), [allItems, page, limit, showAllOnHome]);
  if (!items.length) return null;

  const remove = (item) => {
    const next = (window.__chefopsNotifications || []).filter((row) => row.id !== item.id);
    window.__chefopsNotifications = next;
    setAllItems(next);
    window.dispatchEvent(new CustomEvent("chefops:notifications", { detail: next }));
  };
  const openItem = async (item) => { try { await opsClient.notifications.read(item.id); } catch {} remove(item); navigate(item.target_page || "/"); };
  const dismissItem = async (item) => { try { await opsClient.notifications.read(item.id); } catch {} remove(item); };

  return (
    <section className="space-y-2">
      {items.map((item) => (
        <div key={item.id} className="rounded-2xl border border-amber-200 bg-amber-50 p-3 dark:border-amber-900 dark:bg-amber-950/35">
          <div className="flex items-start gap-3">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-200"><Bell className="h-4 w-4" /></span>
            <button type="button" onClick={() => openItem(item)} className="min-w-0 flex-1 text-left">
              <p className="text-sm font-semibold text-amber-950 dark:text-amber-100">{item.title}</p>
              {item.message ? <p className="mt-1 line-clamp-2 text-xs leading-5 text-amber-900/75 dark:text-amber-100/75">{item.message}</p> : null}
              <span className="mt-2 inline-flex items-center gap-1 text-[11px] font-medium text-amber-800 dark:text-amber-200">{item.action_label || "Open"} <ChevronRight className="h-3 w-3" /></span>
            </button>
            <button type="button" onClick={() => dismissItem(item)} className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-amber-800/60 hover:bg-amber-100 dark:text-amber-200/60 dark:hover:bg-amber-900" aria-label="Dismiss notification"><X className="h-4 w-4" /></button>
          </div>
        </div>
      ))}
    </section>
  );
}
