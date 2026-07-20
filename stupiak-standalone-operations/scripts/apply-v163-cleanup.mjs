import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

function replaceRequired(source, search, replacement, label) {
  if (!source.includes(search)) throw new Error(`v1.6.3 cleanup failed: ${label}`);
  return source.replace(search, replacement);
}

export async function applyV163Cleanup(dist) {
  const file = resolve(dist, 'src/pages/cash.js');
  let source = await readFile(file, 'utf8');

  source = replaceRequired(
    source,
    `    state.remarks.closing = closing.remark || data.summary?.closeUpNote || data.summary?.dailyRemark || '';`,
    `    state.remarks.closing = closing.remark || data.summary?.closeUpNote || '';`,
    'existing closing remark should not load system daily remark'
  );

  source = replaceRequired(
    source,
    `    state.remarks.closing = data.summary?.closeUpNote || data.summary?.dailyRemark || '';`,
    `    state.remarks.closing = data.summary?.closeUpNote || '';`,
    'new closing remark should not load system daily remark'
  );

  await writeFile(file, source);
}
