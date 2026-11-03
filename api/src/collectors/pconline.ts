import type { Db } from '../db/client.js';
import type { CollectSummary } from './types.js';
import { fetchText, looksGated } from './http.js';

/**
 * Pacific / PConline public product list "参考报价".
 * robots.txt does not disallow /cpu/ /memory/ /vga/ list pages.
 * This is a third-party reference quote — NOT JD 到手价.
 */

type Watch = {
  product_key: string;
  list_url: string;
  include: RegExp;
  exclude?: RegExp;
};

const WATCHES: Watch[] = [
  {
    product_key: 'cpu-9600x',
    list_url: 'https://product.pconline.com.cn/cpu/amd/',
    include: /9600X/i,
  },
  {
    product_key: 'ram-ddr5-6000-32',
    list_url: 'https://product.pconline.com.cn/memory/',
    include: /DDR5/i,
    exclude: /笔记本|SO-?DIMM|笔记/i,
  },
  {
    product_key: 'gpu-5070',
    list_url: 'https://product.pconline.com.cn/vga/',
    include: /RTX\s*5070(?!\s*Ti)/i,
  },
  {
    // First-page lists skew to 50-series; miss → unknown (do not invent).
    product_key: 'gpu-4070tis',
    list_url: 'https://product.pconline.com.cn/vga/',
    include: /4070\s*Ti\s*SUPER|4070Ti\s*SUPER|4070\s*TiS/i,
  },
  {
    // Tomahawk often off first page; also accept nearby B650 boards as soft match? No — keep exact.
    product_key: 'mb-b650-tomahawk',
    list_url: 'https://product.pconline.com.cn/mb/',
    include: /B650.*TOMAHAWK|TOMAHAWK.*B650|B650.*迫击|迫击炮.*B650/i,
  },
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type ListedQuote = { title: string; price_cny: number };

/** Extract title→price pairs from PConline category list HTML. */
export function parsePconlineListPrices(html: string): ListedQuote[] {
  const out: ListedQuote[] = [];
  // Optional currency / encoding junk between ">" and digits (GBK pages often show ￥1949)
  const re =
    /_price\.html"[^>]*title="([^"]+)"[^>]*>(?:\s|￥|¥|&yen;|Ã¥|Â¥|[\u00A0-\u00FF]){0,6}([0-9]{3,6})\s*</g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const title = m[1].replace(/\s+/g, ' ').trim();
    const price = Number(m[2]);
    if (title && Number.isFinite(price) && price > 0) out.push({ title, price_cny: price });
  }
  if (!out.length) {
    const re2 =
      /_price\.html"[^>]*>[^0-9]{0,8}([0-9]{3,6})[\s\S]{0,120}?title="([^"]+)"/g;
    while ((m = re2.exec(html))) {
      out.push({ title: m[2].replace(/\s+/g, ' ').trim(), price_cny: Number(m[1]) });
    }
  }
  if (!out.length) {
    const re3 =
      /title="([^"]{3,120})"[^>]*>[\s\S]{0,500}?class="price price-now"[^>]*>\s*([0-9]{3,6})/g;
    while ((m = re3.exec(html))) {
      out.push({ title: m[1].trim(), price_cny: Number(m[2]) });
    }
  }
  return out;
}

function pickBest(quotes: ListedQuote[], watch: Watch): ListedQuote | null {
  const hits = quotes.filter(
    (q) => watch.include.test(q.title) && !(watch.exclude && watch.exclude.test(q.title)),
  );
  if (!hits.length) return null;
  // Prefer titles that also mention capacity/speed cues for RAM
  if (watch.product_key === 'ram-ddr5-6000-32') {
    const prefer = hits.filter((q) => /6000/.test(q.title) && /32/.test(q.title));
    const pool = prefer.length ? prefer : hits.filter((q) => /32/.test(q.title));
    const use = pool.length ? pool : hits;
    use.sort((a, b) => a.price_cny - b.price_cny);
    return use[0];
  }
  hits.sort((a, b) => a.price_cny - b.price_cny);
  return hits[0];
}

export async function collectPconline(db: Db): Promise<CollectSummary> {
  const summary: CollectSummary = {
    collector: 'pconline',
    ok: 0,
    unknown: 0,
    error: 0,
    details: [],
  };
  const run = await db.query<{ id: number }>(
    `INSERT INTO collect_runs (collector, status) VALUES ('pconline','running') RETURNING id`,
  );
  const runId = run.rows[0].id;

  try {
    const { rows: products } = await db.query<{ id: number; key: string }>(
      `SELECT id, key FROM products WHERE active=TRUE`,
    );
    const byKey = new Map(products.map((p) => [p.key, p.id]));

    // Cache list pages (one fetch per unique URL)
    const cache = new Map<string, { status: 'ok' | 'unknown' | 'error'; quotes: ListedQuote[]; reason?: string; rawLen?: number }>();

    for (const watch of WATCHES) {
      const productId = byKey.get(watch.product_key);
      if (!productId) {
        summary.details.push({ product: watch.product_key, status: 'skipped', reason: 'product not in DB' });
        continue;
      }

      if (!cache.has(watch.list_url)) {
        let lastErr = '';
        let stored = false;
        for (let attempt = 0; attempt < 2 && !stored; attempt++) {
          if (attempt > 0) await sleep(1200);
          try {
            const res = await fetchText(watch.list_url);
            if (!res.ok) {
              lastErr = `HTTP ${res.status}`;
              if (attempt === 1) cache.set(watch.list_url, { status: 'error', quotes: [], reason: lastErr });
            } else if (looksGated(res.text) && res.text.length < 2000) {
              cache.set(watch.list_url, { status: 'unknown', quotes: [], reason: 'page looks gated/challenge' });
              stored = true;
            } else {
              const quotes = parsePconlineListPrices(res.text);
              cache.set(watch.list_url, {
                status: quotes.length ? 'ok' : 'unknown',
                quotes,
                reason: quotes.length ? undefined : 'no price pairs parsed',
                rawLen: res.text.length,
              });
              stored = true;
            }
          } catch (e) {
            lastErr = (e as Error).message;
            if (attempt === 1) cache.set(watch.list_url, { status: 'error', quotes: [], reason: lastErr });
          }
        }
        if (!cache.has(watch.list_url)) {
          cache.set(watch.list_url, { status: 'error', quotes: [], reason: lastErr || 'fetch failed' });
        }
        await sleep(800); // polite once-daily pacing between distinct list URLs
      }

      const page = cache.get(watch.list_url)!;
      if (page.status !== 'ok') {
        await db.query(
          `INSERT INTO price_snapshots
           (product_id, source_key, price_cny, price_type, raw, source_url, trust_level, status, fail_reason)
           VALUES ($1,'pconline_ref',NULL,'unknown',$2::jsonb,$3,'third_party',$4,$5)`,
          [
            productId,
            JSON.stringify({ list_url: watch.list_url, reason: page.reason, rawLen: page.rawLen }),
            watch.list_url,
            page.status,
            page.reason || 'pconline list unavailable',
          ],
        );
        if (page.status === 'error') summary.error++;
        else summary.unknown++;
        summary.details.push({ product: watch.product_key, status: page.status, reason: page.reason });
        continue;
      }

      const best = pickBest(page.quotes, watch);
      if (!best) {
        await db.query(
          `INSERT INTO price_snapshots
           (product_id, source_key, price_cny, price_type, raw, source_url, trust_level, status, fail_reason)
           VALUES ($1,'pconline_ref',NULL,'unknown',$2::jsonb,$3,'third_party','unknown',$4)`,
          [
            productId,
            JSON.stringify({
              list_url: watch.list_url,
              parsed_count: page.quotes.length,
              sample: page.quotes.slice(0, 5),
            }),
            watch.list_url,
            'no title matched watch keywords on first list page',
          ],
        );
        summary.unknown++;
        summary.details.push({
          product: watch.product_key,
          status: 'unknown',
          reason: 'no_match',
          parsed_count: page.quotes.length,
        });
        continue;
      }

      await db.query(
        `INSERT INTO price_snapshots
         (product_id, source_key, price_cny, price_type, raw, source_url, data_time, trust_level, status)
         VALUES ($1,'pconline_ref',$2,'list',$3::jsonb,$4,NOW(),'third_party','ok')`,
        [
          productId,
          best.price_cny,
          JSON.stringify({
            matched_title: best.title,
            note: 'PConline 公开参考报价，非京东自营到手价',
            list_url: watch.list_url,
          }),
          watch.list_url,
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
         last_error = CASE WHEN $2>0 THEN $3 ELSE CASE WHEN $1=0 THEN $4 ELSE NULL END END,
         updated_at=NOW()
       WHERE key='pconline_ref'`,
      [
        summary.ok,
        summary.error,
        'one or more PConline fetches errored',
        summary.unknown ? 'partial/unknown matches' : null,
      ],
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
