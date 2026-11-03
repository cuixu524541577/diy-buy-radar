const BASE = (import.meta as ImportMeta & { env: Record<string, string> }).env.VITE_API_BASE || '/api';

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) throw new Error(`${path} → ${res.status}`);
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('text/markdown') || ct.includes('text/html')) {
    return (await res.text()) as T;
  }
  return res.json() as Promise<T>;
}

async function post<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${path} → ${res.status}`);
  return res.json() as Promise<T>;
}

export const api = {
  health: () => get<{ ok: boolean; db: string; platform: string; budget_cny: number; time: string; jobs: { enabled: boolean; reason?: string } }>('/health'),
  products: () => get<{ items: Product[] }>('/products'),
  prices: () => get<{ items: PriceRow[] }>('/prices?limit=50'),
  macro: () => get<{ items: MacroRow[] }>('/macro'),
  gpuRent: () => get<{ items: GpuRentRow[] }>('/gpu-rent?limit=40'),
  scores: () => get<{ items: ScoreRow[] }>('/scores'),
  sources: () => get<{ items: SourceRow[] }>('/data-sources'),
  collect: (only = 'all') => post<{ ok: boolean; summaries: unknown; scores_preview: unknown }>(`/collect?only=${only}`),
  weekly: () => post<unknown>('/reports/weekly'),
  manualPrice: (body: { product_key: string; price_cny: number; source_url?: string; note?: string }) =>
    post('/prices/manual', body),
};

export type Product = {
  id: number;
  key: string;
  category: string;
  name: string;
  brand: string | null;
  model: string | null;
  jd_sku: string | null;
  jd_url: string | null;
  notes: string | null;
};

export type PriceRow = {
  product_key: string;
  product_name: string;
  price_cny: string | null;
  status: string;
  fail_reason: string | null;
  source_key: string;
  collected_at: string;
  source_url: string | null;
};

export type MacroRow = {
  series_id: string;
  series_name: string;
  value: string | null;
  observation_date: string | null;
  status: string;
  source_url: string | null;
  collected_at: string;
};

export type GpuRentRow = {
  provider: string;
  gpu_model: string;
  price_usd_hr: string | null;
  billing_mode: string;
  status: string;
  collected_at: string;
  fail_reason: string | null;
};

export type ScoreRow = {
  product_key: string;
  product_name: string;
  category: string;
  total_score: string | null;
  recommendation: string;
  confidence: string;
  missing: string[];
  rationale: string;
  scored_at: string;
};

export type SourceRow = {
  key: string;
  name: string;
  category: string;
  url: string | null;
  trust_level: string;
  last_ok_at: string | null;
  last_error: string | null;
  notes: string | null;
};
