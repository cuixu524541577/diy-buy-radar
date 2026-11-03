import type { Db } from './client.js';

const SOURCES = [
  {
    key: 'fred_csv',
    name: 'FRED Graph CSV (no key)',
    category: 'macro',
    url: 'https://fred.stlouisfed.org/graph/fredgraph.csv',
    trust_level: 'official',
    update_freq: 'daily',
    has_api: true,
    free: true,
    notes: 'Public CSV download; official API needs FRED_API_KEY',
  },
  {
    key: 'fred_api',
    name: 'FRED Web Service API',
    category: 'macro',
    url: 'https://api.stlouisfed.org/fred/',
    trust_level: 'official',
    update_freq: 'daily',
    has_api: true,
    free: true,
    notes: 'Requires FRED_API_KEY; skipped when unset',
  },
  {
    key: 'runpod_pricing',
    name: 'RunPod public pricing page',
    category: 'gpu_rent',
    url: 'https://www.runpod.io/pricing',
    trust_level: 'official',
    update_freq: 'ad_hoc',
    has_api: false,
    free: true,
    notes: 'Public list prices; not market-clearing auction prices',
  },
  {
    key: 'lambda_pricing',
    name: 'Lambda AI public pricing page',
    category: 'gpu_rent',
    url: 'https://lambda.ai/pricing',
    trust_level: 'official',
    update_freq: 'ad_hoc',
    has_api: false,
    free: true,
    notes: 'Public on-demand list prices',
  },
  {
    key: 'jd_public',
    name: '京东自营公开商品页',
    category: 'diy_price',
    url: 'https://item.jd.com/',
    trust_level: 'official',
    update_freq: 'ad_hoc',
    has_api: false,
    free: true,
    notes: '常反爬；失败则 manual_entry，不伪造价格',
  },
  {
    key: 'manual_entry',
    name: '人工录入',
    category: 'diy_price',
    url: null,
    trust_level: 'third_party',
    update_freq: 'manual',
    has_api: false,
    free: true,
    notes: 'POST /prices/manual',
  },
];

/** Seed SKUs — JD SKU IDs may go stale; collector marks unknown on failure. Never invent prices. */
const PRODUCTS = [
  {
    key: 'cpu-9600x',
    category: 'cpu',
    name: 'AMD Ryzen 5 9600X',
    brand: 'AMD',
    model: '9600X',
    specs: { cores: 6, threads: 12, socket: 'AM5', igpu: true },
    jd_sku: '100128688085',
    jd_url: 'https://item.jd.com/100128688085.html',
    priority: 10,
    notes: 'MVP 锁定平台 CPU；SKU 需人工核对',
  },
  {
    key: 'mb-b650-tomahawk',
    category: 'motherboard',
    name: 'MSI MAG B650 TOMAHAWK WIFI',
    brand: 'MSI',
    model: 'B650 TOMAHAWK WIFI',
    specs: { chipset: 'B650', socket: 'AM5' },
    jd_sku: '100066291366',
    jd_url: 'https://item.jd.com/100066291366.html',
    priority: 20,
    notes: 'B650 代表；SKU 可能变动',
  },
  {
    key: 'ram-ddr5-6000-32',
    category: 'memory',
    name: 'DDR5 6000 32GB (16x2) 代表性 SKU',
    brand: 'Generic',
    model: 'DDR5-6000-32GB',
    specs: { capacity_gb: 32, speed: 6000, kit: '2x16' },
    jd_sku: '100066920553',
    jd_url: 'https://item.jd.com/100066920553.html',
    priority: 5,
    notes: '优先监测；具体品牌可改',
  },
  {
    key: 'gpu-4070tis',
    category: 'gpu',
    name: 'GeForce RTX 4070 Ti SUPER 代表性 SKU',
    brand: 'NVIDIA',
    model: 'RTX 4070 Ti SUPER',
    specs: { vram_gb: 16, tier: '4070TiS' },
    jd_sku: '100086988198',
    jd_url: 'https://item.jd.com/100086988198.html',
    priority: 1,
    notes: '上一代高性价比目标之一',
  },
  {
    key: 'gpu-5070',
    category: 'gpu',
    name: 'GeForce RTX 5070 代表性 SKU',
    brand: 'NVIDIA',
    model: 'RTX 5070',
    specs: { vram_gb: 12, tier: '5070' },
    jd_sku: '100149584162',
    jd_url: 'https://item.jd.com/100149584162.html',
    priority: 2,
    notes: '新一代候选；SKU 需核对',
  },
];

export async function seedIfEmpty(db: Db): Promise<void> {
  const { rows } = await db.query<{ c: string }>('SELECT COUNT(*)::text AS c FROM products');
  const count = Number(rows[0]?.c || 0);

  for (const s of SOURCES) {
    await db.query(
      `INSERT INTO data_sources (key, name, category, url, trust_level, update_freq, has_api, free, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (key) DO UPDATE SET
         name=EXCLUDED.name, url=EXCLUDED.url, notes=EXCLUDED.notes, updated_at=NOW()`,
      [s.key, s.name, s.category, s.url, s.trust_level, s.update_freq, s.has_api, s.free, s.notes],
    );
  }

  await db.query(
    `INSERT INTO app_settings (key, value) VALUES ($1, $2::jsonb)
     ON CONFLICT (key) DO NOTHING`,
    [
      'profile',
      JSON.stringify({
        budget_cny: 7000,
        platform: 'Ryzen 9600X',
        existing: { ssd_gb: 512, gpu: null },
        uses: ['AI图片生成', 'ComfyUI', '视频制作', '摄影后期', '日常工作'],
        weekly_report_to: '524541577@qq.com',
      }),
    ],
  );

  await db.query(
    `INSERT INTO app_settings (key, value) VALUES ($1, $2::jsonb)
     ON CONFLICT (key) DO NOTHING`,
    [
      'score_weights',
      JSON.stringify({
        priceAttractiveness: 0.3,
        perfPerPrice: 0.2,
        supply: 0.15,
        productCycle: 0.1,
        aiComputeEnv: 0.1,
        personalNeed: 0.15,
      }),
    ],
  );

  if (count > 0) return;

  for (const p of PRODUCTS) {
    await db.query(
      `INSERT INTO products (key, category, name, brand, model, specs, jd_sku, jd_url, priority, notes)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10)`,
      [
        p.key,
        p.category,
        p.name,
        p.brand,
        p.model,
        JSON.stringify(p.specs),
        p.jd_sku,
        p.jd_url,
        p.priority,
        p.notes,
      ],
    );
  }
}
