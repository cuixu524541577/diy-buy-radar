import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../../../.env') });
dotenv.config();

function bool(v: string | undefined, d = false): boolean {
  if (v == null || v === '') return d;
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
}

export const env = {
  apiPort: Number(process.env.API_PORT || 3001),
  databaseUrl: process.env.DATABASE_URL || 'postgres://radar:radar@localhost:5432/diy_buy_radar',
  usePglite: bool(process.env.USE_PGLITE, false),
  redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',
  skipRedis: bool(process.env.SKIP_REDIS, false),
  webOrigin: process.env.WEB_ORIGIN || 'http://localhost:5173',
  reportsDir: process.env.REPORTS_DIR || path.resolve(__dirname, '../../../data/reports'),
  fredApiKey: process.env.FRED_API_KEY || '',
  budgetCny: Number(process.env.BUDGET_CNY || 7000),
  platform: process.env.PLATFORM || 'Ryzen 9600X',
  weeklyReportTo: process.env.WEEKLY_REPORT_TO || '',
  agentEmailFrom: process.env.AGENT_EMAIL_FROM || '',
  pgliteDir: process.env.PGLITE_DIR || path.resolve(__dirname, '../../../data/pglite'),
};
