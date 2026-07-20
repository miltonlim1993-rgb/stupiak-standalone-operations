const pad = (value) => String(value).padStart(2, '0');

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

export function weekPeriod(businessDate) {
  const date = parseIsoDate(businessDate);
  const day = date.getDate();
  const index = Math.min(5, Math.max(1, Math.ceil(day / 7)));
  const startDay = (index - 1) * 7 + 1;
  const lastDay = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
  const endDay = Math.min(index * 7, lastDay);
  const start = new Date(date.getFullYear(), date.getMonth(), startDay);
  const end = new Date(date.getFullYear(), date.getMonth(), endDay);
  const nextStart = endDay < lastDay ? new Date(date.getFullYear(), date.getMonth(), endDay + 1) : new Date(date.getFullYear(), date.getMonth() + 1, 1);
  const nextIndex = endDay < lastDay ? index + 1 : 1;
  return {
    index,
    label: `Week ${index}`,
    start: isoDate(start),
    end: isoDate(end),
    rangeLabel: `${formatDate(start, { year: false })} – ${formatDate(end)}`,
    nextLabel: `Week ${nextIndex}`,
    nextStart: isoDate(nextStart),
    nextEnd: isoDate(new Date(nextStart.getFullYear(), nextStart.getMonth(), Math.min(nextStart.getDate() + 6, new Date(nextStart.getFullYear(), nextStart.getMonth() + 1, 0).getDate())))
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
