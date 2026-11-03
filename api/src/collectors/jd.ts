import type { Db } from '../db/client.js';
import type { CollectSummary } from './types.js';

type ProductRow = {
  id: number;
  key: string;
  name: string;
  jd_sku: string | null;
  jd_url: string | null;
};

/**
 * Attempt to read a public JD item page.
 * JD frequently blocks datacenter IPs / bots — on failure we store status=unknown
 * with fail_reason and NEVER invent a price.
 */
async function tryFetchJdPrice(sku: string, url: string): Promise<{
  price: number | null;
  status: 'ok' | 'unknown' | 'error';
  reason: string | null;
  raw: Record<string, unknown>;
}> {
  const headers = {
    'User-Agent':
      'Mozilla/5.0 (compatible; DIY-Buy-Radar/0.1; +https://localhost; research price snapshot)',
    Accept: 'text/html,application/xhtml+xml,application/json',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
  };

  // 1) Legacy public price JSON (often blocked)
  try {
    const priceApi = `https://p.3.cn/prices/mgets?skuIds=J_${sku}`;
    const res = await fetch(priceApi, { headers });
    if (res.ok) {
      const json = (await res.json()) as Array<{ p?: string; op?: string; m?: string }>;
      const row = json?.[0];
      const p = row?.p != null ? Number(row.p) : NaN;
      if (Number.isFinite(p) && p > 0) {
        return { price: p, status: 'ok', reason: null, raw: { endpoint: priceApi, row } };
      }
      return {
        price: null,
        status: 'unknown',
        reason: 'price API returned empty/invalid price',
        raw: { endpoint: priceApi, json },
      };
    }
  } catch (e) {
    // continue to HTML
    void e;
  }

  // 2) Item HTML page — look for common price markers without bypassing login walls
  try {
    const res = await fetch(url, { headers, redirect: 'follow' });
    const text = await res.text();
    if (!res.ok) {
      return {
        price: null,
        status: 'error',
        reason: `item page HTTP ${res.status}`,
        raw: { url, status: res.status, snippet: text.slice(0, 300) },
      };
    }
    if (/验证|登录|risk|captcha|禁止访问|访问受限/i.test(text) && !/\$?\d{3,5}/.test(text)) {
      return {
        price: null,
        status: 'unknown',
        reason: 'page looks gated/captcha; use manual_entry',
        raw: { url, snippet: text.slice(0, 400) },
      };
    }
    const patterns = [
      /"p":"([0-9]+(?:\.[0-9]+)?)"/,
      /"price":\s*"?([0-9]+(?:\.[0-9]+)?)"?/,
      /price:\s*'([0-9]+(?:\.[0-9]+)?)'/,
      /J-p-\d+[^>]*>\s*([0-9]+(?:\.[0-9]+)?)/,
    ];
    for (const re of patterns) {
      const m = text.match(re);
      if (m) {
        const p = Number(m[1]);
        if (Number.isFinite(p) && p > 1 && p < 100000) {
          return { price: p, status: 'ok', reason: null, raw: { url, match: m[0] } };
        }
      }
    }
    return {
      price: null,
      status: 'unknown',
      reason: 'could not extract public price from HTML; use POST /prices/manual',
      raw: { url, len: text.length, snippet: text.slice(0, 400) },
    };
  } catch (e) {
    return {
      price: null,
      status: 'error',
      reason: (e as Error).message,
      raw: { url },
    };
  }
}

export async function collectJd(db: Db): Promise<CollectSummary> {
  const summary: CollectSummary = { collector: 'jd', ok: 0, unknown: 0, error: 0, details: [] };
  const run = await db.query<{ id: number }>(
    `INSERT INTO collect_runs (collector, status) VALUES ('jd','running') RETURNING id`,
  );
  const runId = run.rows[0].id;

  try {
    const { rows: products } = await db.query<ProductRow>(
      `SELECT id, key, name, jd_sku, jd_url FROM products WHERE active=TRUE AND jd_sku IS NOT NULL ORDER BY priority ASC`,
    );

    for (const p of products) {
      const url = p.jd_url || `https://item.jd.com/${p.jd_sku}.html`;
      const result = await tryFetchJdPrice(p.jd_sku!, url);
      await db.query(
        `INSERT INTO price_snapshots
         (product_id, source_key, price_cny, price_type, in_stock, raw, source_url, data_time, trust_level, status, fail_reason)
         VALUES ($1,'jd_public',$2,$3,NULL,$4::jsonb,$5,CASE WHEN $6='ok' THEN NOW() ELSE NULL END,$7,$6,$8)`,
        [
          p.id,
          result.price,
          result.status === 'ok' ? 'list' : 'unknown',
          JSON.stringify(result.raw),
          url,
          result.status,
          result.status === 'ok' ? 'official' : 'unknown',
          result.reason,
        ],
      );
      if (result.status === 'ok') summary.ok++;
      else if (result.status === 'unknown') summary.unknown++;
      else summary.error++;
      summary.details.push({
        product: p.key,
        sku: p.jd_sku,
        status: result.status,
        price_cny: result.price,
        reason: result.reason,
      });
    }

    // Always ensure a manual_entry placeholder note exists in details
    summary.details.push({
      note: '若京东公开价失败，请 POST /prices/manual {product_key, price_cny, source_url?, note?}',
    });

    await db.query(
      `UPDATE data_sources SET last_ok_at = CASE WHEN $1>0 THEN NOW() ELSE last_ok_at END,
         last_error = CASE WHEN $2>0 THEN $3 ELSE CASE WHEN $4>0 THEN $5 ELSE NULL END END,
         updated_at=NOW()
       WHERE key='jd_public'`,
      [
        summary.ok,
        summary.error,
        'one or more JD fetches errored',
        summary.unknown,
        'JD public price unavailable; use manual_entry',
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
