import type { Db } from '../db/client.js';
import type { CollectSummary } from './types.js';
import { fetchText, looksGated } from './http.js';

/**
 * ZOL public VGA list reference prices (fragile — /memory/ often challenges bots).
 * robots.txt does not disallow /vga/ list; we only hit public list once/day.
 * Failures → unknown, never invent prices.
 */

type Watch = { product_key: string; include: RegExp; exclude?: RegExp };

const LIST_URL = 'https://detail.zol.com.cn/vga/';
const WATCHES: Watch[] = [
  { product_key: 'gpu-5070', include: /RTX\s*5070(?!\s*Ti)/i },
  { product_key: 'gpu-4070tis', include: /4070\s*Ti\s*SUPER|4070Ti\s*SUPER/i },
];

export type ZolQuote = { title: string; price_cny: number; href?: string };

export function parseZolVgaList(html: string): ZolQuote[] {
  const out: ZolQuote[] = [];
  const priceRe = /class="price-type">(\d{3,6})</g;
  let m: RegExpExecArray | null;
  while ((m = priceRe.exec(html))) {
    const price = Number(m[1]);
    const prev = html.slice(Math.max(0, m.index - 900), m.index);
    const titles = [...prev.matchAll(/title="([^"]{5,160})"/g)].map((x) => x[1]);
    const hrefs = [...prev.matchAll(/href="(\/vga\/[^"]+)"/g)].map((x) => x[1]);
    if (!titles.length || !Number.isFinite(price)) continue;
    out.push({ title: titles[titles.length - 1], price_cny: price, href: hrefs.at(-1) });
  }
  return out;
}

export async function collectZol(db: Db): Promise<CollectSummary> {
  const summary: CollectSummary = { collector: 'zol', ok: 0, unknown: 0, error: 0, details: [] };
  const run = await db.query<{ id: number }>(
    `INSERT INTO collect_runs (collector, status) VALUES ('zol','running') RETURNING id`,
  );
  const runId = run.rows[0].id;

  try {
    const { rows: products } = await db.query<{ id: number; key: string }>(
      `SELECT id, key FROM products WHERE active=TRUE`,
    );
    const byKey = new Map(products.map((p) => [p.key, p.id]));

    let quotes: ZolQuote[] = [];
    let pageStatus: 'ok' | 'unknown' | 'error' = 'ok';
    let reason: string | null = null;

    try {
      const res = await fetchText(LIST_URL);
      if (!res.ok) {
        pageStatus = 'error';
        reason = `HTTP ${res.status}`;
      } else if (looksGated(res.text) || res.text.length < 2000) {
        pageStatus = 'unknown';
        reason = 'ZOL challenge/gate or empty body';
      } else {
        quotes = parseZolVgaList(res.text);
        if (!quotes.length) {
          pageStatus = 'unknown';
          reason = 'parsed zero ZOL prices';
        }
      }
    } catch (e) {
      pageStatus = 'error';
      reason = (e as Error).message;
    }

    for (const watch of WATCHES) {
      const productId = byKey.get(watch.product_key);
      if (!productId) continue;

      if (pageStatus !== 'ok') {
        await db.query(
          `INSERT INTO price_snapshots
           (product_id, source_key, price_cny, price_type, raw, source_url, trust_level, status, fail_reason)
           VALUES ($1,'zol_ref',NULL,'unknown',$2::jsonb,$3,'third_party',$4,$5)`,
          [productId, JSON.stringify({ reason }), LIST_URL, pageStatus, reason],
        );
        if (pageStatus === 'error') summary.error++;
        else summary.unknown++;
        summary.details.push({ product: watch.product_key, status: pageStatus, reason });
        continue;
      }

      const hits = quotes.filter(
        (q) => watch.include.test(q.title) && !(watch.exclude && watch.exclude.test(q.title)),
      );
      if (!hits.length) {
        await db.query(
          `INSERT INTO price_snapshots
           (product_id, source_key, price_cny, price_type, raw, source_url, trust_level, status, fail_reason)
           VALUES ($1,'zol_ref',NULL,'unknown',$2::jsonb,$3,'third_party','unknown',$4)`,
          [
            productId,
            JSON.stringify({ parsed_count: quotes.length, sample: quotes.slice(0, 5) }),
            LIST_URL,
            'no title match on ZOL VGA list',
          ],
        );
        summary.unknown++;
        summary.details.push({ product: watch.product_key, status: 'unknown', reason: 'no_match' });
        continue;
      }
      hits.sort((a, b) => a.price_cny - b.price_cny);
      const best = hits[0];
      await db.query(
        `INSERT INTO price_snapshots
         (product_id, source_key, price_cny, price_type, raw, source_url, data_time, trust_level, status)
         VALUES ($1,'zol_ref',$2,'list',$3::jsonb,$4,NOW(),'third_party','ok')`,
        [
          productId,
          best.price_cny,
          JSON.stringify({
            matched_title: best.title,
            href: best.href,
            note: 'ZOL 参考价，非京东到手价；列表页抽样',
          }),
          best.href ? `https://detail.zol.com.cn${best.href}` : LIST_URL,
        ],
      );
      summary.ok++;
      summary.details.push({
        product: watch.product_key,
        status: 'ok',
        price_cny: best.price_cny,
        matched_title: best.title,
      });
    }

    await db.query(
      `UPDATE data_sources SET last_ok_at = CASE WHEN $1>0 THEN NOW() ELSE last_ok_at END,
         last_error = CASE WHEN $2>0 THEN $3 ELSE NULL END, updated_at=NOW()
       WHERE key='zol_ref'`,
      [summary.ok, summary.error, reason],
    );

    await db.query(`UPDATE collect_runs SET finished_at=NOW(), status='done', summary=$2::jsonb WHERE id=$1`, [
      runId,
      JSON.stringify(summary),
    ]);
  } catch (e) {
    await db.query(`UPDATE collect_runs SET finished_at=NOW(), status='error', error=$2 WHERE id=$1`, [
      runId,
      (e as Error).message,
    ]);
    throw e;
  }
  return summary;
}
