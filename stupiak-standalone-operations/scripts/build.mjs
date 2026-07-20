import { cp, mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { applyV14Patches } from './apply-v14-patches.mjs';
import { applyV15Patches } from './apply-v15-patches.mjs';
import { applyV16Patches } from './apply-v16-patches.mjs';

const root = resolve(import.meta.dirname, '..');
const dist = resolve(root, 'dist');
await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
await cp(resolve(root, 'public'), dist, { recursive: true });
await cp(resolve(root, 'src'), resolve(dist, 'src'), { recursive: true });
await applyV14Patches(dist);
await applyV15Patches(dist);
await applyV16Patches(dist);
console.log('Built static app into dist/');
