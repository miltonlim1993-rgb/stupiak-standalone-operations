import { cp, mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { applyV163CashFixes } from './apply-v163-cash-fixes.mjs';

const root = resolve(import.meta.dirname, '..');
const dist = resolve(root, 'dist');
await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
await cp(resolve(root, 'public'), dist, { recursive: true });
await cp(resolve(root, 'src'), resolve(dist, 'src'), { recursive: true });
await applyV163CashFixes(dist);
console.log('Built static app into dist/');
