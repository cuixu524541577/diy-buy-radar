import { getDb, ensureSchema } from '../db/client.js';
import { seedIfEmpty } from '../db/seed.js';
import { generateWeeklyReport } from '../reports/weekly.js';

const db = await getDb();
await ensureSchema(db);
await seedIfEmpty(db);
const report = await generateWeeklyReport(db);
console.log(JSON.stringify(report, null, 2));
await db.end();
