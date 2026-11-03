import { getDb, ensureSchema } from '../db/client.js';
import { seedIfEmpty } from '../db/seed.js';

const db = await getDb();
await ensureSchema(db);
await seedIfEmpty(db);
console.log('seed ok', db.kind);
await db.end();
