import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export async function applyV1121RuntimeFix(dist) {
  const file = resolve(dist, 'src/core/stock-local-export.js');
  let source = await readFile(file, 'utf8');

  const replacement = `function weekHeader(snapshot, week, sectionName = 'Inventory', includeDate = true) {
  const date = snapshot.sheetWeekDates?.[sectionName]?.[week] || '';
  return \`WEEK \${week}\\n\${weekPeriod(snapshot.monthKey, week)}\${includeDate && date ? \`\\nCounted \${formatDate(date)}\` : ''}\`;
}
`;

  const pattern = /function weekHeader\([\s\S]*?(?=function weekPeriod\()/;
  if (!pattern.test(source)) throw new Error('v1.12.1 runtime fix failed: weekHeader block not found');
  source = source.replace(pattern, replacement);
  await writeFile(file, source);
}
