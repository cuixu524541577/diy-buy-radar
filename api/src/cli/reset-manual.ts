import { getDb } from '../db/client.js';
import { scoreAllActive } from '../scoring/calculator.js';
async function main() {
  const db = await getDb();
  await db.query(`DELETE FROM price_snapshots WHERE source_key='manual_entry'`);
  const scores = await scoreAllActive(db);
  console.log(scores.map(s => ({ key: s.product.key, total: s.total_score, rec: s.recommendation })));
  await db.end();
}
main();
