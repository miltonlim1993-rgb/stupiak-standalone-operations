// Shared helpers for the restaurant ops app

export const ROLES = ["staff", "leader", "supervisor", "manager", "owner"];

export const ROLE_LABELS = {
  staff: "Staff",
  leader: "Leader",
  supervisor: "Supervisor",
  manager: "Manager",
  owner: "Owner",
};

export const ROLE_BADGE_CLASSES = {
  staff: "bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300",
  leader: "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300",
  supervisor: "bg-purple-100 text-purple-700 dark:bg-purple-950 dark:text-purple-300",
  manager: "bg-orange-100 text-orange-700 dark:bg-orange-950 dark:text-orange-300",
  owner: "bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-300",
};

export const PRIORITY_LABELS = {
  low: "Low",
  medium: "Medium",
  high: "High",
  urgent: "Urgent",
};

export const PRIORITY_BADGE_CLASSES = {
  low: "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300",
  medium: "bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300",
  high: "bg-orange-100 text-orange-700 dark:bg-orange-950 dark:text-orange-300",
  urgent: "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300",
};

export const TASK_STATUS_LABELS = {
  pending: "Pending",
  in_progress: "In Progress",
  done: "Done",
  overdue: "Overdue",
  skipped: "Skipped",
};

export const TASK_STATUS_CLASSES = {
  pending: "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300",
  in_progress: "bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300",
  done: "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300",
  overdue: "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300",
  skipped: "bg-yellow-100 text-yellow-700 dark:bg-yellow-950 dark:text-yellow-300",
};

export const ISSUE_STATUS_LABELS = {
  open: "Open",
  in_progress: "In Progress",
  resolved: "Resolved",
  escalated: "Escalated",
};

export const ISSUE_STATUS_CLASSES = {
  open: "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300",
  in_progress: "bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300",
  resolved: "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300",
  escalated: "bg-orange-100 text-orange-700 dark:bg-orange-950 dark:text-orange-300",
};

export const CATEGORY_ICONS = {
  foh: "🛎️",
  kitchen: "👨‍🍳",
  general: "📋",
  daily: "📋",
  cleaning: "🧹",
  prep: "🔪",
  service: "🍽️",
  closing: "🔒",
  opening: "🔓",
  maintenance: "🔧",
  other: "📌",
};

export function todayStr() {
  return new Date().toISOString().split("T")[0];
}

export function formatDate(dateStr) {
  if (!dateStr) return "";
  const d = new Date(dateStr);
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}

export function formatDateTime(dateStr) {
  if (!dateStr) return "";
  const d = new Date(dateStr);
  return d.toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
}

export function formatTime(dateStr) {
  if (!dateStr) return "";
  const d = new Date(dateStr);
  return d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}

export function shareToWhatsApp(phone, message) {
  const cleanPhone = (phone || "").replace(/[^0-9]/g, "");
  const url = cleanPhone
    ? `https://wa.me/${cleanPhone}?text=${encodeURIComponent(message)}`
    : `https://wa.me/?text=${encodeURIComponent(message)}`;
  window.open(url, "_blank");
}

export function generateBatchSerial(prefix = "B") {
  const now = new Date();
  const datePart = now.toISOString().slice(0, 10).replace(/-/g, "");
  const randomPart = Math.floor(Math.random() * 9000 + 1000);
  return `${prefix}${datePart}${randomPart}`;
}

export function generateBarcode() {
  return Date.now().toString().slice(-12).padStart(12, "0");
}

export const ROLE_LEVEL = {
  staff: 1,
  leader: 2,
  supervisor: 3,
  manager: 4,
  owner: 5,
};

export function canManage(role) {
  return (ROLE_LEVEL[role] || 0) >= ROLE_LEVEL.supervisor;
}

export function canCreateTask(role) {
  return (ROLE_LEVEL[role] || 0) >= ROLE_LEVEL.leader;
}

export function calcHours(clockIn, clockOut) {
  if (!clockIn || !clockOut) return 0;
  const diff = new Date(clockOut) - new Date(clockIn);
  return Math.round((diff / 3600000) * 100) / 100;
}