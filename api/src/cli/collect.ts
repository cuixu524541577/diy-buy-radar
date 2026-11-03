import { getDb, ensureSchema } from '../db/client.js';
import { seedIfEmpty } from '../db/seed.js';
import { runCollectors, type CollectorName } from '../collectors/index.js';
import { scoreAllActive } from '../scoring/calculator.js';

const only = (process.argv[2] as CollectorName) || 'all';

const db = await getDb();
await ensureSchema(db);
await seedIfEmpty(db);
const summaries = await runCollectors(db, [only]);
const scores = await scoreAllActive(db);
console.log(JSON.stringify({ summaries, scores: scores.map((s) => ({
  key: s.product.key,
  total: s.total_score,
  rec: s.recommendation,
  confidence: s.confidence,
  missing: s.missing,
})) }, null, 2));
await db.end();
