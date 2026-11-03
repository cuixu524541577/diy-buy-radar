import Fastify from 'fastify';
import cors from '@fastify/cors';
import { env } from './config/env.js';
import { getDb, ensureSchema } from './db/client.js';
import { seedIfEmpty } from './db/seed.js';
import { registerRoutes } from './routes/register.js';
import { startJobs } from './jobs/queue.js';

async function main() {
  const db = await getDb();
  await ensureSchema(db);
  await seedIfEmpty(db);

  const jobs = await startJobs(db);
  console.log('[jobs]', jobs);

  const app = Fastify({ logger: true });
  await app.register(cors, { origin: true });
  await registerRoutes(app, db, { jobs });

  await app.listen({ port: env.apiPort, host: '0.0.0.0' });
  console.log(`[api] listening on :${env.apiPort} db=${db.kind}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
