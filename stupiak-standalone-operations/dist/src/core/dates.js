const pad = (value) => String(value).padStart(2, '0');
const MS_PER_DAY = 24 * 60 * 60 * 1000;

export function todayIso() {
  const now = new Date();
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export function parseIsoDate(value) {
  const [year, month, day] = String(value || '').split('-').map(Number);
  return new Date(year, month - 1, day);
}

export function isoDate(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function formatDate(value, options = {}) {
  const date = typeof value === 'string' ? parseIsoDate(value) : value;
  if (!date || Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('en-MY', { day: 'numeric', month: 'short', year: options.year === false ? undefined : 'numeric' }).format(date);
}

function startOfCalendarWeek(date) {
  const result = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const offset = (result.getDay() + 6) % 7; // Monday = 0, Sunday = 6
  result.setDate(result.getDate() - offset);
  return result;
}

function addDays(date, days) {
  const result = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  result.setDate(result.getDate() + days);
  return result;
}

export function weekPeriod(businessDate) {
  const date = parseIsoDate(businessDate);
  const monthStart = new Date(date.getFullYear(), date.getMonth(), 1);
  const gridStart = startOfCalendarWeek(monthStart);
  const weekStart = startOfCalendarWeek(date);
  const rawIndex = Math.floor((weekStart.getTime() - gridStart.getTime()) / (7 * MS_PER_DAY)) + 1;
  const index = Math.max(1, Math.min(5, rawIndex));
  const start = addDays(gridStart, (index - 1) * 7);
  const end = addDays(start, 6);
  const nextStart = addDays(start, 7);
  const nextEnd = addDays(nextStart, 6);
  const nextRawIndex = Math.floor((nextStart.getTime() - gridStart.getTime()) / (7 * MS_PER_DAY)) + 1;
  const nextIndex = nextStart.getMonth() === date.getMonth() ? Math.min(5, nextRawIndex) : 1;
  return {
    index,
    label: `Week ${index}`,
    start: isoDate(start),
    end: isoDate(end),
    rangeLabel: `${formatDate(start, { year: false })} – ${formatDate(end)}`,
    nextLabel: `Week ${nextIndex}`,
    nextStart: isoDate(nextStart),
    nextEnd: isoDate(nextEnd)
  };
}

export function monthPeriod(businessDate) {
  const date = parseIsoDate(businessDate);
  const start = new Date(date.getFullYear(), date.getMonth(), 1);
  const end = new Date(date.getFullYear(), date.getMonth() + 1, 0);
  return {
    start: isoDate(start),
    end: isoDate(end),
    rangeLabel: `${formatDate(start, { year: false })} – ${formatDate(end)}`,
    label: new Intl.DateTimeFormat('en-MY', { month: 'long', year: 'numeric' }).format(date)
  };
}
