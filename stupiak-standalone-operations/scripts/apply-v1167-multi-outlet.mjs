import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export async function applyV1167MultiOutlet(dist) {
  const mainFile = resolve(dist, 'src/main.js');
  let main = await readFile(mainFile, 'utf8');
  main = main.replace(
    "{ action: 'getBootstrap', businessDate: state.stock.businessDate, refresh: forceFresh }",
    "{ action: 'getBootstrap', businessDate: state.stock.businessDate, outlet: state.outletRef, refresh: forceFresh }"
  );
  main = main.replace(
    "{ action: 'getBootstrap', businessDate: todayIso() }",
    "{ action: 'getBootstrap', businessDate: todayIso(), outlet: state.outletRef }"
  );
  main = main.replace(/timeoutMs: 60000/g, 'timeoutMs: 15000');
  await writeFile(mainFile, main);

  for (const relativePath of ['index.html', 'sw.js']) {
    const file = resolve(dist, relativePath);
    const content = (await readFile(file, 'utf8')).replace(/1\.16\.(5|6|7|8|9|10|11)/g, '1.16.12');
    await writeFile(file, content);
  }
}
