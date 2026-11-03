import type { Db } from '../db/client.js';
import { DEFAULT_WEIGHTS, recommendationFromScore, type WeightKey } from '../config/weights.js';
import { env } from '../config/env.js';

type Component = {
  key: WeightKey;
  score: number | null; // null = unknown, NEVER fake 0
  weight: number;
  evidence: string[];
  missing?: string;
};

function clamp(n: number, lo = 0, hi = 100) {
  return Math.max(lo, Math.min(hi, n));
}

async function loadWeights(db: Db): Promise<Record<WeightKey, number>> {
  const { rows } = await db.query<{ value: Record<WeightKey, number> }>(
    `SELECT value FROM app_settings WHERE key='score_weights'`,
  );
  return { ...DEFAULT_WEIGHTS, ...(rows[0]?.value || {}) };
}

async function latestPrice(db: Db, productId: number) {
  const { rows } = await db.query<{
    price_cny: string | null;
    status: string;
    collected_at: string;
    source_key: string;
  }>(
    `SELECT price_cny::text, status, collected_at::text, source_key
     FROM price_snapshots WHERE product_id=$1 ORDER BY collected_at DESC LIMIT 1`,
    [productId],
  );
  return rows[0] || null;
}

async function priceHistory(db: Db, productId: number, days: number) {
  const { rows } = await db.query<{ price_cny: string; collected_at: string }>(
    `SELECT price_cny::text, collected_at::text FROM price_snapshots
     WHERE product_id=$1 AND price_cny IS NOT NULL AND status='ok'
       AND collected_at >= NOW() - ($2 || ' days')::interval
     ORDER BY collected_at ASC`,
    [productId, String(days)],
  );
  return rows.map((r) => ({ price: Number(r.price_cny), at: r.collected_at }));
}

async function gpuRentTrend(db: Db): Promise<'down' | 'up' | 'flat' | 'unknown'> {
  const { rows } = await db.query<{ d: string; avg: string }>(
    `SELECT date_trunc('day', collected_at)::date::text AS d, AVG(price_usd_hr)::text AS avg
     FROM gpu_rent_snapshots
     WHERE status='ok' AND price_usd_hr IS NOT NULL AND gpu_model ILIKE '%4090%'
     GROUP BY 1 ORDER BY 1 DESC LIMIT 14`,
  );
  if (rows.length < 2) return 'unknown';
  const newest = Number(rows[0].avg);
  const oldest = Number(rows[rows.length - 1].avg);
  if (![newest, oldest].every(Number.isFinite)) return 'unknown';
  const delta = (newest - oldest) / oldest;
  if (delta < -0.05) return 'down';
  if (delta > 0.05) return 'up';
  return 'flat';
}

async function macroPressure(db: Db): Promise<'tight' | 'ease' | 'neutral' | 'unknown'> {
  const { rows } = await db.query<{ series_id: string; value: string }>(
    `SELECT DISTINCT ON (series_id) series_id, value::text
     FROM macro_snapshots
     WHERE series_id IN ('DGS10','FEDFUNDS') AND status='ok' AND value IS NOT NULL
     ORDER BY series_id, collected_at DESC`,
  );
  if (!rows.length) return 'unknown';
  const map = Object.fromEntries(rows.map((r) => [r.series_id, Number(r.value)]));
  const y10 = map.DGS10;
  const ff = map.FEDFUNDS;
  if (y10 == null && ff == null) return 'unknown';
  const ref = y10 ?? ff;
  if (ref >= 4.5) return 'tight';
  if (ref <= 2.5) return 'ease';
  return 'neutral';
}

function personalNeedScore(category: string): { score: number; evidence: string[] } {
  // From locked MVP profile: no GPU, AI image/video heavy → GPU & DDR5 highest need
  if (category === 'gpu') return { score: 90, evidence: ['当前无显卡', 'AI 图片/视频为主要用途'] };
  if (category === 'memory') return { score: 80, evidence: ['DDR5 为优先监测', '可后补内存策略'] };
  if (category === 'cpu') return { score: 70, evidence: ['锁定 9600X 平台', '核显可过渡'] };
  if (category === 'motherboard') return { score: 65, evidence: ['与 9600X 配套'] };
  return { score: 40, evidence: ['非 MVP 优先配件'] };
}

function productCycleScore(category: string, model: string | null): { score: number | null; evidence: string[]; missing?: string } {
  const m = (model || '').toUpperCase();
  if (category === 'gpu') {
    if (m.includes('5070') || m.includes('5080') || m.includes('5090')) {
      return { score: 45, evidence: ['50 系较新，旧品降价窗口可能仍在打开'] };
    }
    if (m.includes('4070') || m.includes('4080') || m.includes('4090')) {
      return { score: 70, evidence: ['40 系进入清库/换代期，性价比窗口需结合实价'] };
    }
  }
  if (category === 'cpu' && m.includes('9600X')) {
    return { score: 60, evidence: ['AM5 中期平台，升级空间尚可'] };
  }
  if (category === 'memory') {
    return { score: 55, evidence: ['DDR5 周期受服务器需求扰动大，需实价'] };
  }
  return { score: null, missing: 'product_cycle_heuristic_insufficient', evidence: [] };
}

export async function scoreProduct(db: Db, productId: number) {
  const weights = await loadWeights(db);
  const { rows: prows } = await db.query<{
    id: number;
    key: string;
    category: string;
    name: string;
    model: string | null;
  }>(`SELECT id, key, category, name, model FROM products WHERE id=$1`, [productId]);
  const product = prows[0];
  if (!product) throw new Error(`product ${productId} not found`);

  const components: Component[] = [];
  const missing: string[] = [];

  // 1) Price attractiveness
  const latest = await latestPrice(db, productId);
  const hist90 = await priceHistory(db, productId, 90);
  let priceComp: Component;
  if (!latest || latest.status !== 'ok' || latest.price_cny == null) {
    priceComp = {
      key: 'priceAttractiveness',
      score: null,
      weight: weights.priceAttractiveness,
      evidence: [],
      missing: 'no_valid_price_snapshot',
    };
    missing.push('priceAttractiveness');
  } else {
    const price = Number(latest.price_cny);
    const evidence = [`最新价 ¥${price} (${latest.source_key} @ ${latest.collected_at})`];
    let score: number | null = null;
    if (hist90.length >= 3) {
      const avg = hist90.reduce((a, b) => a + b.price, 0) / hist90.length;
      const min = Math.min(...hist90.map((h) => h.price));
      const vsAvg = (avg - price) / avg; // positive if below avg
      const nearLow = min > 0 ? 1 - (price - min) / min : 0;
      score = clamp(50 + vsAvg * 100 + nearLow * 20);
      evidence.push(`90日均价约 ¥${avg.toFixed(0)}`, `样本内最低 ¥${min}`);
    } else {
      // Not enough history — mark unknown for this component (do NOT invent relative score)
      score = null;
      missing.push('priceAttractiveness_history');
      evidence.push('历史样本不足（需≥3个有效价），价格吸引力标为 unknown');
    }
    priceComp = {
      key: 'priceAttractiveness',
      score,
      weight: weights.priceAttractiveness,
      evidence,
      missing: score == null ? 'insufficient_history' : undefined,
    };
  }
  components.push(priceComp);

  // 2) Perf per price — needs price + category heuristics; without price → unknown
  if (priceComp.score == null && priceComp.missing) {
    components.push({
      key: 'perfPerPrice',
      score: null,
      weight: weights.perfPerPrice,
      evidence: [],
      missing: 'depends_on_valid_price',
    });
    missing.push('perfPerPrice');
  } else if (latest?.price_cny != null && latest.status === 'ok') {
    const price = Number(latest.price_cny);
    let score: number | null = null;
    const evidence: string[] = [];
    if (product.category === 'gpu') {
      const vram = product.model?.includes('4070') ? 16 : product.model?.includes('5070') ? 12 : null;
      if (vram && price > 0) {
        const yuanPerGb = price / vram;
        // Heuristic bands for CNY/GB — not fabricated market prices, just mapping function once price known
        score = clamp(100 - (yuanPerGb - 150) / 5);
        evidence.push(`粗算 ¥${yuanPerGb.toFixed(0)}/GB 显存（仅作相对映射，非行业标准）`);
      } else {
        score = null;
        missing.push('perfPerPrice_gpu_spec');
      }
    } else if (product.category === 'memory') {
      score = clamp(100 - price / 50);
      evidence.push('DDR5 以容量套装价格粗映射');
    } else if (product.category === 'cpu') {
      score = clamp(100 - price / 40);
      evidence.push('CPU 以平台锁定下的价格粗映射');
    } else {
      score = null;
      missing.push('perfPerPrice_category');
    }
    components.push({
      key: 'perfPerPrice',
      score,
      weight: weights.perfPerPrice,
      evidence,
      missing: score == null ? 'insufficient_spec_or_mapping' : undefined,
    });
    if (score == null) missing.push('perfPerPrice');
  } else {
    components.push({
      key: 'perfPerPrice',
      score: null,
      weight: weights.perfPerPrice,
      evidence: [],
      missing: 'no_valid_price',
    });
    missing.push('perfPerPrice');
  }

  // 3) Supply — MVP: unknown unless we have repeated ok snapshots
  const hist30 = await priceHistory(db, productId, 30);
  if (hist30.length >= 2) {
    components.push({
      key: 'supply',
      score: 55,
      weight: weights.supply,
      evidence: [`30日内 ${hist30.length} 次有效公开价样本（弱信号，非库存数据）`],
    });
  } else {
    components.push({
      key: 'supply',
      score: null,
      weight: weights.supply,
      evidence: [],
      missing: 'no_inventory_feed',
    });
    missing.push('supply');
  }

  // 4) Product cycle
  const cycle = productCycleScore(product.category, product.model);
  components.push({
    key: 'productCycle',
    score: cycle.score,
    weight: weights.productCycle,
    evidence: cycle.evidence,
    missing: cycle.missing,
  });
  if (cycle.score == null) missing.push('productCycle');

  // 5) AI compute environment
  const rent = await gpuRentTrend(db);
  const macro = await macroPressure(db);
  if (rent === 'unknown' && macro === 'unknown') {
    components.push({
      key: 'aiComputeEnv',
      score: null,
      weight: weights.aiComputeEnv,
      evidence: [],
      missing: 'gpu_rent_or_macro_insufficient',
    });
    missing.push('aiComputeEnv');
  } else {
    let score = 50;
    const evidence: string[] = [];
    if (rent === 'down') {
      score += 15;
      evidence.push('消费级相关租赁价样本趋势偏降（弱信号）');
    } else if (rent === 'up') {
      score -= 10;
      evidence.push('租赁价样本趋势偏升');
    } else if (rent === 'flat') evidence.push('租赁价样本大致平稳');
    else evidence.push('租赁趋势 unknown');
    if (macro === 'tight') {
      score -= 5;
      evidence.push('宏观利率偏紧（可能压制边缘 CapEx）');
    } else if (macro === 'ease') {
      score += 5;
      evidence.push('宏观利率偏松');
    }
    components.push({
      key: 'aiComputeEnv',
      score: clamp(score),
      weight: weights.aiComputeEnv,
      evidence,
    });
  }

  // 6) Personal need
  const need = personalNeedScore(product.category);
  components.push({
    key: 'personalNeed',
    score: need.score,
    weight: weights.personalNeed,
    evidence: need.evidence,
  });

  // Aggregate: only known components; if weight coverage < 50% → total unknown
  const known = components.filter((c) => c.score != null);
  const knownWeight = known.reduce((a, c) => a + c.weight, 0);
  const confidence = clamp(knownWeight * 100, 0, 100) / 100;

  let total: number | null = null;
  let rationale: string;
  if (knownWeight < 0.5) {
    total = null;
    rationale = `有效权重仅 ${(knownWeight * 100).toFixed(0)}%（<50%），总分标为 unknown，不填 0。缺失: ${missing.join(', ') || 'n/a'}。预算参考 ¥${env.budgetCny}。`;
  } else {
    const renorm = known.map((c) => ({ ...c, w: c.weight / knownWeight }));
    total = renorm.reduce((a, c) => a + (c.score as number) * c.w, 0);
    total = Math.round(total * 10) / 10;
    rationale = `按已知分量重归一化后得分 ${total}；置信度 ${(confidence * 100).toFixed(0)}%。缺失: ${
      missing.join(', ') || '无'
    }。`;
  }

  const recommendation = recommendationFromScore(total);

  const { rows: saved } = await db.query<{ id: number }>(
    `INSERT INTO scores (product_id, scope, category, total_score, recommendation, confidence, components, weights, missing, rationale)
     VALUES ($1,'product',$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9) RETURNING id`,
    [
      product.id,
      product.category,
      total,
      recommendation,
      confidence,
      JSON.stringify(components),
      JSON.stringify(weights),
      missing,
      rationale,
    ],
  );

  return {
    score_id: saved[0].id,
    product,
    total_score: total,
    recommendation,
    confidence,
    components,
    missing,
    rationale,
    budget_cny: env.budgetCny,
  };
}

export async function scoreAllActive(db: Db) {
  const { rows } = await db.query<{ id: number }>(`SELECT id FROM products WHERE active=TRUE ORDER BY priority ASC`);
  const out = [];
  for (const r of rows) out.push(await scoreProduct(db, r.id));
  return out;
}
