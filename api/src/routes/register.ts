import type { FastifyInstance } from 'fastify';
import type { Db } from '../db/client.js';
import { runCollectors } from '../collectors/index.js';
import { scoreAllActive, scoreProduct } from '../scoring/calculator.js';
import { generateWeeklyReport, readLatestWeekly } from '../reports/weekly.js';
import { env } from '../config/env.js';

export async function registerRoutes(app: FastifyInstance, db: Db, meta: { jobs: { enabled: boolean; reason?: string } }) {
  app.get('/health', async () => ({
    ok: true,
    service: 'diy-buy-radar-api',
    db: db.kind,
    jobs: meta.jobs,
    budget_cny: env.budgetCny,
    platform: env.platform,
    time: new Date().toISOString(),
  }));

  app.get('/products', async () => {
    const { rows } = await db.query(
      `SELECT id, key, category, name, brand, model, specs, jd_sku, jd_url, msrp_cny, priority, active, notes
       FROM products ORDER BY priority ASC, id ASC`,
    );
    return { items: rows };
  });

  app.get<{ Querystring: { product_key?: string; limit?: string } }>('/prices', async (req) => {
    const limit = Math.min(Number(req.query.limit || 100), 500);
    if (req.query.product_key) {
      const { rows } = await db.query(
        `SELECT s.*, p.key AS product_key, p.name AS product_name
         FROM price_snapshots s JOIN products p ON p.id=s.product_id
         WHERE p.key=$1 ORDER BY s.collected_at DESC LIMIT $2`,
        [req.query.product_key, limit],
      );
      return { items: rows };
    }
    const { rows } = await db.query(
      `SELECT s.*, p.key AS product_key, p.name AS product_name
       FROM price_snapshots s JOIN products p ON p.id=s.product_id
       ORDER BY s.collected_at DESC LIMIT $1`,
      [limit],
    );
    return { items: rows };
  });

  app.post<{
    Body: { product_key: string; price_cny: number; source_url?: string; note?: string; in_stock?: boolean };
  }>('/prices/manual', async (req, reply) => {
    const { product_key, price_cny, source_url, note, in_stock } = req.body || ({} as never);
    if (!product_key || price_cny == null || !Number.isFinite(Number(price_cny))) {
      return reply.code(400).send({ error: 'product_key and numeric price_cny required' });
    }
    const { rows } = await db.query<{ id: number }>(`SELECT id FROM products WHERE key=$1`, [product_key]);
    if (!rows[0]) return reply.code(404).send({ error: 'product not found' });
    const { rows: inserted } = await db.query(
      `INSERT INTO price_snapshots
       (product_id, source_key, price_cny, price_type, in_stock, raw, source_url, data_time, trust_level, status)
       VALUES ($1,'manual_entry',$2,'manual_entry',$3,$4::jsonb,$5,NOW(),'third_party','ok')
       RETURNING *`,
      [
        rows[0].id,
        Number(price_cny),
        in_stock ?? null,
        JSON.stringify({ note: note || null, entered_via: 'api' }),
        source_url || null,
      ],
    );
    return { ok: true, item: inserted[0] };
  });

  app.get('/macro', async () => {
    const { rows } = await db.query(
      `SELECT DISTINCT ON (series_id) *
       FROM macro_snapshots ORDER BY series_id, collected_at DESC`,
    );
    return { items: rows };
  });

  app.get<{ Querystring: { limit?: string } }>('/gpu-rent', async (req) => {
    const limit = Math.min(Number(req.query.limit || 100), 500);
    const { rows } = await db.query(
      `SELECT * FROM gpu_rent_snapshots ORDER BY collected_at DESC LIMIT $1`,
      [limit],
    );
    return { items: rows };
  });

  app.get('/scores', async () => {
    const { rows } = await db.query(
      `SELECT s.*, p.key AS product_key, p.name AS product_name
       FROM scores s
       LEFT JOIN products p ON p.id=s.product_id
       WHERE s.id IN (
         SELECT MAX(id) FROM scores WHERE scope='product' GROUP BY product_id
       )
       ORDER BY s.scored_at DESC`,
    );
    return { items: rows };
  });

  app.post('/scores/recompute', async () => {
    const items = await scoreAllActive(db);
    return { ok: true, items };
  });

  app.get('/data-sources', async () => {
    const { rows } = await db.query(`SELECT * FROM data_sources ORDER BY category, key`);
    return { items: rows };
  });

  app.get('/settings/profile', async () => {
    const { rows } = await db.query(`SELECT value FROM app_settings WHERE key='profile'`);
    return { profile: rows[0]?.value || null };
  });

  app.get<{ Querystring: { limit?: string } }>('/chip-spot', async (req) => {
    const limit = Math.min(Number(req.query.limit || 100), 500);
    const { rows } = await db.query(
      `SELECT * FROM chip_spot_snapshots ORDER BY collected_at DESC LIMIT $1`,
      [limit],
    );
    return { items: rows };
  });

  app.post<{ Querystring: { only?: string } }>('/collect', async (req) => {
    const only = (req.query.only || 'all') as
      | 'all'
      | 'macro'
      | 'gpu_rent'
      | 'jd'
      | 'dram'
      | 'pconline'
      | 'zol';
    const summaries = await runCollectors(db, [only]);
    const scores = await scoreAllActive(db);
    return { ok: true, summaries, scores_preview: scores.map((s) => ({
      key: s.product.key,
      total_score: s.total_score,
      recommendation: s.recommendation,
      confidence: s.confidence,
      missing: s.missing,
    })) };
  });

  app.get('/events', async (req, reply) => {
    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': env.webOrigin,
    });
    reply.raw.write(`event: hello\ndata: ${JSON.stringify({ t: Date.now() })}\n\n`);
    const timer = setInterval(() => {
      reply.raw.write(`event: heartbeat\ndata: ${JSON.stringify({ t: Date.now() })}\n\n`);
    }, 15000);
    req.raw.on('close', () => clearInterval(timer));
  });

  app.post('/reports/weekly', async () => {
    const report = await generateWeeklyReport(db);
    return report;
  });

  app.get<{ Querystring: { format?: string } }>('/reports/weekly/latest', async (req, reply) => {
    const format = (req.query.format || 'md') as 'md' | 'html' | 'meta';
    const latest = readLatestWeekly(format === 'html' ? 'html' : format === 'meta' ? 'meta' : 'md');
    if (!latest) return reply.code(404).send({ error: 'no weekly report yet; POST /reports/weekly first' });
    if (format === 'html' && 'content' in latest) {
      reply.type('text/html').send(latest.content);
      return;
    }
    if (format === 'md' && 'content' in latest) {
      reply.type('text/markdown; charset=utf-8').send(latest.content);
      return;
    }
    return latest;
  });

  // convenience: score one
  app.post<{ Params: { id: string } }>('/products/:id/score', async (req, reply) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return reply.code(400).send({ error: 'bad id' });
    return scoreProduct(db, id);
  });
}
