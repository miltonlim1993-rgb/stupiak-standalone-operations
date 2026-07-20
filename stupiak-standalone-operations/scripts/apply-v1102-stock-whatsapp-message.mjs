import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

function replaceRequired(source, search, replacement, label) {
  if (!source.includes(search)) throw new Error(`v1.10.2 patch failed: ${label}`);
  return source.replace(search, replacement);
}

export async function applyV1102StockWhatsappMessage(dist) {
  const file = resolve(dist, 'src/core/stock-local-export.js');
  let source = await readFile(file, 'utf8');

  source = replaceRequired(
    source,
    `function buildWhatsappMessage(snapshot) {
  return [
    '📦 STOCK COUNT COMPLETED',
    '',
    \`Outlet: \${snapshot.outlet}\`,
    \`Count date: \${snapshot.countDates.join(', ')}\`,
    \`Period: \${snapshot.weekIndexes.length ? snapshot.weekIndexes.map((week) => \`Week \${week}\`).join(', ') : 'Monthly'}\`,
    \`Counted by: \${snapshot.countedBy}\`,
    \`Items counted: \${snapshot.rows.length}\`,
    \`Need attention: \${snapshot.needAttention.length}\`,
    snapshot.note ? \`Note: \${snapshot.note}\` : '',
    '',
    'PDF and Excel are attached.'
  ].filter(Boolean).join('\\n');
}`,
    `function buildWhatsappMessage(snapshot) {
  const countDate = snapshot.countDates.map(formatWhatsappCountDate).join(', ');
  return [
    'STOCK COUNT',
    \`Outlet: \${snapshot.outlet}\`,
    \`Counted: \${countDate}\`
  ].join('\\n');
}

function formatWhatsappCountDate(value) {
  const match = String(value || '').match(/^(\\d{4})-(\\d{2})-(\\d{2})$/);
  if (!match) return String(value || '');
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12, 0, 0);
  return new Intl.DateTimeFormat('en-MY', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'Asia/Kuala_Lumpur'
  }).format(date);
}`,
    'compact WhatsApp message'
  );

  await writeFile(file, source);
}
