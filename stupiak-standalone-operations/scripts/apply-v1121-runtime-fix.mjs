import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export async function applyV1121RuntimeFix(dist) {
  await fixStockPage(dist);
  await fixStockExporter(dist);
}

async function fixStockPage(dist) {
  const file = resolve(dist, 'src/pages/stock.js');
  let source = await readFile(file, 'utf8');

  const replacement = `function weekHeader(state, sheetName, week) {
  const period = week.periodLabel || week.rangeLabel || weekPeriodForIndex(state.monthKey || week.date || todayIso(), week.index);
  const bounds = weekBounds(state.monthKey, week.index);
  const dateValue = state.sheetWeekDates?.[sheetName]?.[week.index] || '';
  const current = currentWeekIndex(state.monthKey, todayIso()) === week.index && state.monthKey === todayIso().slice(0, 7);
  const dirty = isDirtyColumn(state, sheetName, week.index);
  return \`<th class="week-head week-date-head \${current ? 'current-week' : ''} \${dirty ? 'dirty-week-head' : ''} \${state.mobileWeek === week.index ? 'mobile-current' : ''}"><span>WEEK \${week.index}</span><small>\${period}</small><label class="week-date-control"><span>COUNT DATE · \${escapeHtml(sheetName)}</span><input type="date" data-week-date="\${week.index}" data-week-sheet="\${escapeHtml(sheetName)}" value="\${escapeHtml(dateValue)}" min="\${bounds.startIso}" max="\${bounds.endIso}"></label>\${dirty ? '<em>Changed in this tab</em>' : dateValue ? '<em>Saved date</em>' : ''}</th>\`;
}
`;

  const pattern = /function weekHeader\([\s\S]*?(?=\n\nfunction orderPage)/;
  if (!pattern.test(source)) throw new Error('v1.12.2 runtime fix failed: Stock weekHeader block not found');
  source = source.replace(pattern, replacement);
  await writeFile(file, source);
}

async function fixStockExporter(dist) {
  const file = resolve(dist, 'src/core/stock-local-export.js');
  let source = await readFile(file, 'utf8');

  const replacement = `function weekHeader(snapshot, week, sectionName = 'Inventory', includeDate = true) {
  const date = snapshot.sheetWeekDates?.[sectionName]?.[week] || '';
  return \`WEEK \${week}\\n\${weekPeriod(snapshot.monthKey, week)}\${includeDate && date ? \`\\nCounted \${formatDate(date)}\` : ''}\`;
}
`;

  const pattern = /function weekHeader\([\s\S]*?(?=function weekPeriod\()/;
  if (!pattern.test(source)) throw new Error('v1.12.2 runtime fix failed: Export weekHeader block not found');
  source = source.replace(pattern, replacement);
  await writeFile(file, source);
}
