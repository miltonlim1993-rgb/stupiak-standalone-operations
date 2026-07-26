import { Link } from "react-router-dom";
import {
  BarChart3,
  Bell,
  Boxes,
  ChevronRight,
  Clock,
  Download,
  GraduationCap,
  Printer,
  Receipt,
  Settings,
  ShieldCheck,
  AlertTriangle,
} from "lucide-react";
import { useAuth } from "@/lib/AuthContext";
import { ROLE_LEVEL } from "@/lib/ops-helpers";

const commonOperations = [
  { to: "/inventory", label: "Outlet Stock List", desc: "View this outlet's enabled list and minimums", icon: Boxes },
  { to: "/training", label: "SOP & Training", desc: "Read SOPs, complete courses and track progress", icon: GraduationCap },
];

const mobileOnlyOperations = [
  { to: "/urgent", label: "Urgent Issues", desc: "Report and track urgent operational issues", icon: AlertTriangle },
  { to: "/receipts", label: "Receipts & OCR", desc: "Scan and review receipt records", icon: Receipt },
  { to: "/attendance", label: "Duty Roster", desc: "View and import the weekly roster", icon: Clock },
];

const systemItems = [
  { to: "/notifications", label: "Notifications", desc: "Updates sent to your user ID", icon: Bell },
  { to: "/install", label: "Install App", desc: "PWA, operational patch and Android status", icon: Download },
  { to: "/settings", label: "Settings", desc: "Profile and standalone connection", icon: Settings },
];

export default function More() {
  const { user } = useAuth();
  const canUseControl = (ROLE_LEVEL[user?.role] || 0) >= ROLE_LEVEL.manager;
  const managementItems = [
    ...(canUseControl ? [
      { to: "/ops-control", label: "Ops Control", desc: "Approve access, assign outlets and send updates", icon: ShieldCheck },
      { to: "/labels/settings", label: "Label Printer Settings", desc: "Connection, printer language, size, retry and offline queue", icon: Printer },
    ] : []),
    { to: "/reports", label: "Reports", desc: "Export operations, stock, photo and training reports", icon: BarChart3 },
  ];

  return (
    <div className="chefops-page more-page mx-auto w-full max-w-5xl space-y-5 p-4">
      <div>
        <h1 className="text-xl font-heading font-bold">More</h1>
        <p className="mt-0.5 text-xs text-muted-foreground">Tools that are not already shown in the current navigation mode.</p>
      </div>

      <MenuSection title="Operations" items={commonOperations} />
      <div className="chefops-more-mobile-only">
        <MenuSection title="Mobile shortcuts" items={mobileOnlyOperations} />
      </div>
      <MenuSection title="Management" items={managementItems} />
      <MenuSection title="System" items={systemItems} />
      <p className="pb-2 text-center text-[11px] font-medium text-muted-foreground">App shell: Fixed Viewport v6</p>
    </div>
  );
}

function MenuSection({ title, items }) {
  if (!items.length) return null;
  return (
    <section className="space-y-2">
      <h2 className="px-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}</h2>
      <div className="overflow-hidden rounded-xl border border-border bg-card">
        {items.map(({ to, label, desc, icon: Icon }, index) => (
          <Link
            key={to}
            to={to}
            className={`flex items-center gap-3 p-4 transition-colors active:bg-muted ${index > 0 ? "border-t border-border" : ""}`}
          >
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-muted">
              <Icon className="h-5 w-5" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-semibold">{label}</span>
              <span className="mt-0.5 block text-xs leading-4 text-muted-foreground">{desc}</span>
            </span>
            <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
          </Link>
        ))}
      </div>
    </section>
  );
}
