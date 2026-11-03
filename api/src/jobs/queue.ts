import cron from 'node-cron';
import { env } from '../config/env.js';
import type { Db } from '../db/client.js';
import { runCollectors } from '../collectors/index.js';
import { scoreAllActive } from '../scoring/calculator.js';
import { generateWeeklyReport } from '../reports/weekly.js';

let started = false;
let nodeCronStarted = false;

async function runDailyCollect(db: Db) {
  const summaries = await runCollectors(db, ['all']);
  await scoreAllActive(db);
  return summaries;
}

/** BullMQ when Redis up; otherwise node-cron once/day. Never invent data. */
export async function startJobs(db: Db): Promise<{
  enabled: boolean;
  mode?: 'bullmq' | 'node-cron' | 'off';
  reason?: string;
  schedule?: string;
}> {
  const dailyExpr = process.env.DAILY_CRON || '15 10 * * *'; // 10:15 local box time (~UTC-5 morning-ish)
  const weeklyExpr = process.env.WEEKLY_CRON || '0 9 * * 1';

  if (!env.skipRedis) {
    try {
      const { Queue, Worker } = await import('bullmq');
      const connection = { url: env.redisUrl };
      const IORedis = (await import('ioredis')).default;
      const probe = new IORedis(env.redisUrl, { maxRetriesPerRequest: 1, lazyConnect: true });
      await probe.connect();
      await probe.ping();
      await probe.quit();

      const q = new Queue('diy-radar', { connection });
      if (!started) {
        started = true;
        // eslint-disable-next-line no-new
        new Worker(
          'diy-radar',
          async (job) => {
            if (job.name === 'collect-daily' || job.name === 'collect-all') {
              return runDailyCollect(db);
            }
            if (job.name === 'weekly-report') {
              return generateWeeklyReport(db);
            }
          },
          { connection },
        );
      }

      // Once per day collect (replace previous 6h cadence)
      await q.add(
        'collect-daily',
        {},
        { repeat: { pattern: dailyExpr }, removeOnComplete: 50, jobId: 'repeat-collect-daily' },
      );
      await q.add(
        'weekly-report',
        {},
        { repeat: { pattern: weeklyExpr }, removeOnComplete: 20, jobId: 'repeat-weekly-report' },
      );

      return { enabled: true, mode: 'bullmq', schedule: `daily=${dailyExpr}; weekly=${weeklyExpr}` };
    } catch (e) {
      // fall through to node-cron
      const reason = (e as Error).message;
      const fallback = startNodeCron(db, dailyExpr, weeklyExpr, `redis_failed: ${reason}`);
      return fallback;
    }
  }

  return startNodeCron(db, dailyExpr, weeklyExpr, 'SKIP_REDIS=1');
}

function startNodeCron(
  db: Db,
  dailyExpr: string,
  weeklyExpr: string,
  reason: string,
): { enabled: boolean; mode: 'node-cron' | 'off'; reason?: string; schedule?: string } {
  if (!cron.validate(dailyExpr) || !cron.validate(weeklyExpr)) {
    return { enabled: false, mode: 'off', reason: `invalid cron expr daily=${dailyExpr} weekly=${weeklyExpr}` };
  }
  if (!nodeCronStarted) {
    nodeCronStarted = true;
    cron.schedule(dailyExpr, () => {
      runDailyCollect(db).catch((err) => console.error('[cron] daily collect failed', err));
    });
    cron.schedule(weeklyExpr, () => {
      generateWeeklyReport(db).catch((err) => console.error('[cron] weekly report failed', err));
    });
    console.log(`[jobs] node-cron armed daily=${dailyExpr} weekly=${weeklyExpr} (${reason})`);
  }
  return {
    enabled: true,
    mode: 'node-cron',
    reason,
    schedule: `daily=${dailyExpr}; weekly=${weeklyExpr}`,
  };
}
