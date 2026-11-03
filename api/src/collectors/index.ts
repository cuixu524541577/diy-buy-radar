import type { Db } from '../db/client.js';
import { collectMacro } from './macro.js';
import { collectGpuRent } from './gpuRent.js';
import { collectJd } from './jd.js';
import { collectDram } from './dram.js';
import { collectPconline } from './pconline.js';
import { collectZol } from './zol.js';
import type { CollectSummary } from './types.js';

export type CollectorName = 'macro' | 'gpu_rent' | 'jd' | 'dram' | 'pconline' | 'zol' | 'all';

export async function runCollectors(
  db: Db,
  which: CollectorName[] = ['all'],
): Promise<CollectSummary[]> {
  const all = which.includes('all');
  const out: CollectSummary[] = [];
  if (all || which.includes('macro')) out.push(await collectMacro(db));
  if (all || which.includes('gpu_rent')) out.push(await collectGpuRent(db));
  if (all || which.includes('dram')) out.push(await collectDram(db));
  if (all || which.includes('pconline')) out.push(await collectPconline(db));
  if (all || which.includes('zol')) out.push(await collectZol(db));
  if (all || which.includes('jd')) out.push(await collectJd(db));
  return out;
}

export {
  collectMacro,
  collectGpuRent,
  collectJd,
  collectDram,
  collectPconline,
  collectZol,
};
