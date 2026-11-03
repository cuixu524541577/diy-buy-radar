import { getDb } from '../api/src/db/client.js';
import { scoreAllActive } from '../api/src/scoring/calculator.js';

const db = await getDb();
await db.query(
  `DELETE FROM price_snapshots
   WHERE source_key='manual_entry'
     AND (raw::text ILIKE '%smoke%' OR raw::text ILIKE '%second sample%' OR raw::text ILIKE '%third sample%')`,
);
const left = await db.query<{ c: string }>(
  `SELECT count(*)::text AS c FROM price_snapshots WHERE source_key='manual_entry'`,
);
console.log('manual left', left.rows[0]);
const scores = await scoreAllActive(db);
console.log(
  scores.map((s) => ({
    key: s.product.key,
    total: s.total_score,
    rec: s.recommendation,
    conf: s.confidence,
  })),
);
await db.end();
