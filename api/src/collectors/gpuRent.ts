import type { Db } from '../db/client.js';
import type { CollectSummary } from './types.js';

type ParsedOffer = {
  provider: string;
  gpu_model: string;
  price_usd_hr: number;
  billing_mode: string;
  source_url: string;
};

function parseMoney(s: string): number | null {
  const m = s.replace(/,/g, '').match(/\$?\s*([0-9]+(?:\.[0-9]+)?)/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

/** Parse RunPod markdown/HTML-ish text for known GPU list prices */
export function parseRunpodPricing(text: string, sourceUrl: string): ParsedOffer[] {
  const offers: ParsedOffer[] = [];
  // Prefer schema.org AggregateOffer blocks if present
  const offerBlocks = [...text.matchAll(/"name"\s*:\s*"(Community Cloud|Secure Cloud)"\s*,\s*"price"\s*:\s*"([0-9.]+)"[\s\S]*?"description"\s*:\s*"([^"]+)"/g)];
  for (const b of offerBlocks) {
    const mode = b[1] === 'Secure Cloud' ? 'secure' : 'community';
    const price = Number(b[2]);
    const desc = b[3];
    const gpu = desc.replace(/\s+per-hour.*$/i, '').replace(/\s+on Runpod.*$/i, '').trim();
    if (Number.isFinite(price) && gpu) {
      offers.push({ provider: 'runpod', gpu_model: gpu, price_usd_hr: price, billing_mode: mode, source_url: sourceUrl });
    }
  }
  if (offers.length) return dedupe(offers);

  // Fallback: lines like "H100 SXM" near "$3.99/hr"
  const lines = text.split(/\n+/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const priceMatch = line.match(/\$([0-9]+(?:\.[0-9]+)?)\s*\/\s*hr/i);
    if (!priceMatch) continue;
    const price = Number(priceMatch[1]);
    const window = [lines[i - 2], lines[i - 1], line, lines[i + 1]].filter(Boolean).join(' ');
    const gpuMatch = window.match(
      /\b(B300|B200|H200|H100(?:\s+(?:SXM|PCIe|NVL))?|A100(?:\s+(?:SXM|PCIe))?|L40S|L40|L4|RTX\s*5090|RTX\s*4090|RTX\s*3090|RTX\s*A6000|RTX\s*6000\s*Ada|A40|A10)\b/i,
    );
    if (!gpuMatch || !Number.isFinite(price)) continue;
    offers.push({
      provider: 'runpod',
      gpu_model: gpuMatch[1].replace(/\s+/g, ' ').trim(),
      price_usd_hr: price,
      billing_mode: /secure/i.test(window) ? 'secure' : 'on_demand',
      source_url: sourceUrl,
    });
  }
  return dedupe(offers);
}

export function parseLambdaPricing(text: string, sourceUrl: string): ParsedOffer[] {
  const offers: ParsedOffer[] = [];
  let m: RegExpExecArray | null;

  // Markdown/HTML table rows containing NVIDIA + $price
  const tableRe =
    /(NVIDIA[\w\s.\-]{2,40}?)\s*\|[^|\n]*\|[^|\n]*\|[^|\n]*\|[^|\n]*\|\s*\$([0-9]+(?:\.[0-9]+)?)/gi;
  while ((m = tableRe.exec(text))) {
    const model = m[1].replace(/\s+/g, ' ').trim();
    const price = Number(m[2]);
    if (Number.isFinite(price)) {
      offers.push({
        provider: 'lambda',
        gpu_model: model,
        price_usd_hr: price,
        billing_mode: 'on_demand',
        source_url: sourceUrl,
      });
    }
  }

  // Loose: "NVIDIA H100" ... "$3.99" within 120 chars
  const loose =
    /NVIDIA\s+((?:HGX\s+)?(?:B200|H100|A100|GH200|A10|A6000|Tesla\s+V100)(?:\s+(?:SXM6|SXM|PCIe))?)/gi;
  while ((m = loose.exec(text))) {
    const model = `NVIDIA ${m[1]}`.replace(/\s+/g, ' ').trim();
    const slice = text.slice(m.index, m.index + 160);
    const pm = slice.match(/\$([0-9]+(?:\.[0-9]+)?)/);
    if (!pm) continue;
    const price = Number(pm[1]);
    if (!Number.isFinite(price)) continue;
    offers.push({
      provider: 'lambda',
      gpu_model: model,
      price_usd_hr: price,
      billing_mode: 'on_demand',
      source_url: sourceUrl,
    });
  }
  return dedupe(offers);
}

function dedupe(offers: ParsedOffer[]): ParsedOffer[] {
  const map = new Map<string, ParsedOffer>();
  for (const o of offers) {
    const k = `${o.provider}|${o.gpu_model}|${o.billing_mode}|${o.price_usd_hr}`;
    map.set(k, o);
  }
  return [...map.values()];
}

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'DIY-Buy-Radar/0.1 (research; public pricing snapshot)',
      Accept: 'text/html,application/xhtml+xml',
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

async function storeOffers(db: Db, offers: ParsedOffer[], provider: string, sourceUrl: string, summary: CollectSummary) {
  if (!offers.length) {
    summary.unknown++;
    await db.query(
      `INSERT INTO gpu_rent_snapshots
       (provider, gpu_model, price_usd_hr, billing_mode, source_url, trust_level, status, fail_reason, raw)
       VALUES ($1,'ALL',NULL,'on_demand',$2,'official','unknown',$3,$4::jsonb)`,
      [provider, sourceUrl, 'parsed zero offers from public page', JSON.stringify({ note: 'parse_empty' })],
    );
    summary.details.push({ provider, status: 'unknown', reason: 'parse_empty' });
    return;
  }
  for (const o of offers) {
    await db.query(
      `INSERT INTO gpu_rent_snapshots
       (provider, gpu_model, price_usd_hr, billing_mode, source_url, data_time, trust_level, status, raw)
       VALUES ($1,$2,$3,$4,$5,NOW(),'official','ok',$6::jsonb)`,
      [o.provider, o.gpu_model, o.price_usd_hr, o.billing_mode, o.source_url, JSON.stringify(o)],
    );
    summary.ok++;
  }
  summary.details.push({ provider, status: 'ok', count: offers.length });
}

export async function collectGpuRent(db: Db): Promise<CollectSummary> {
  const summary: CollectSummary = { collector: 'gpu_rent', ok: 0, unknown: 0, error: 0, details: [] };
  const run = await db.query<{ id: number }>(
    `INSERT INTO collect_runs (collector, status) VALUES ('gpu_rent','running') RETURNING id`,
  );
  const runId = run.rows[0].id;

  try {
    // RunPod
    try {
      const url = 'https://www.runpod.io/pricing';
      const text = await fetchText(url);
      const offers = parseRunpodPricing(text, url);
      await storeOffers(db, offers, 'runpod', url, summary);
      await db.query(`UPDATE data_sources SET last_ok_at=NOW(), last_error=NULL, updated_at=NOW() WHERE key='runpod_pricing'`);
    } catch (e) {
      summary.error++;
      const msg = (e as Error).message;
      await db.query(
        `INSERT INTO gpu_rent_snapshots
         (provider, gpu_model, price_usd_hr, billing_mode, source_url, trust_level, status, fail_reason)
         VALUES ('runpod','ALL',NULL,'on_demand','https://www.runpod.io/pricing','official','error',$1)`,
        [msg],
      );
      await db.query(`UPDATE data_sources SET last_error=$1, updated_at=NOW() WHERE key='runpod_pricing'`, [msg]);
      summary.details.push({ provider: 'runpod', status: 'error', reason: msg });
    }

    // Lambda
    try {
      const url = 'https://lambda.ai/pricing';
      const text = await fetchText(url);
      const offers = parseLambdaPricing(text, url);
      await storeOffers(db, offers, 'lambda', url, summary);
      await db.query(`UPDATE data_sources SET last_ok_at=NOW(), last_error=NULL, updated_at=NOW() WHERE key='lambda_pricing'`);
    } catch (e) {
      summary.error++;
      const msg = (e as Error).message;
      await db.query(
        `INSERT INTO gpu_rent_snapshots
         (provider, gpu_model, price_usd_hr, billing_mode, source_url, trust_level, status, fail_reason)
         VALUES ('lambda','ALL',NULL,'on_demand','https://lambda.ai/pricing','official','error',$1)`,
        [msg],
      );
      await db.query(`UPDATE data_sources SET last_error=$1, updated_at=NOW() WHERE key='lambda_pricing'`, [msg]);
      summary.details.push({ provider: 'lambda', status: 'error', reason: msg });
    }

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

// silence unused in some builds
void parseMoney;
