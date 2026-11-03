-- DIY Buy Radar schema (Phase-2 MVP)

CREATE TABLE IF NOT EXISTS data_sources (
  id SERIAL PRIMARY KEY,
  key TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  url TEXT,
  trust_level TEXT NOT NULL DEFAULT 'unknown', -- official | third_party | media | rumor | unknown
  update_freq TEXT,
  has_api BOOLEAN DEFAULT FALSE,
  free BOOLEAN DEFAULT TRUE,
  notes TEXT,
  last_ok_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS products (
  id SERIAL PRIMARY KEY,
  key TEXT UNIQUE NOT NULL,
  category TEXT NOT NULL, -- cpu | motherboard | memory | gpu | ssd | psu | cooler | case
  name TEXT NOT NULL,
  brand TEXT,
  model TEXT,
  specs JSONB NOT NULL DEFAULT '{}',
  jd_sku TEXT,
  jd_url TEXT,
  msrp_cny NUMERIC,
  priority INT NOT NULL DEFAULT 100,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS price_snapshots (
  id SERIAL PRIMARY KEY,
  product_id INT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  source_key TEXT NOT NULL,
  price_cny NUMERIC, -- null if unknown / failed
  price_type TEXT NOT NULL DEFAULT 'list', -- list | coupon_est | manual_entry | unknown
  currency TEXT NOT NULL DEFAULT 'CNY',
  in_stock BOOLEAN,
  raw JSONB,
  source_url TEXT,
  collected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  data_time TIMESTAMPTZ,
  trust_level TEXT NOT NULL DEFAULT 'unknown',
  status TEXT NOT NULL DEFAULT 'ok', -- ok | unknown | error
  fail_reason TEXT
);

CREATE INDEX IF NOT EXISTS idx_price_snapshots_product_time
  ON price_snapshots(product_id, collected_at DESC);

CREATE TABLE IF NOT EXISTS macro_snapshots (
  id SERIAL PRIMARY KEY,
  series_id TEXT NOT NULL,
  series_name TEXT NOT NULL,
  value NUMERIC, -- null if unknown
  unit TEXT,
  source_key TEXT NOT NULL,
  source_url TEXT,
  observation_date DATE,
  collected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  trust_level TEXT NOT NULL DEFAULT 'official',
  status TEXT NOT NULL DEFAULT 'ok',
  fail_reason TEXT,
  raw JSONB
);

CREATE INDEX IF NOT EXISTS idx_macro_series_time
  ON macro_snapshots(series_id, collected_at DESC);

CREATE TABLE IF NOT EXISTS gpu_rent_snapshots (
  id SERIAL PRIMARY KEY,
  provider TEXT NOT NULL, -- runpod | lambda | other
  gpu_model TEXT NOT NULL,
  price_usd_hr NUMERIC,
  billing_mode TEXT NOT NULL DEFAULT 'on_demand', -- on_demand | reserved | community | secure
  region TEXT,
  source_url TEXT,
  collected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  data_time TIMESTAMPTZ,
  trust_level TEXT NOT NULL DEFAULT 'official',
  status TEXT NOT NULL DEFAULT 'ok',
  fail_reason TEXT,
  raw JSONB
);

CREATE INDEX IF NOT EXISTS idx_gpu_rent_time
  ON gpu_rent_snapshots(provider, gpu_model, collected_at DESC);

CREATE TABLE IF NOT EXISTS scores (
  id SERIAL PRIMARY KEY,
  product_id INT REFERENCES products(id) ON DELETE CASCADE,
  scope TEXT NOT NULL, -- product | category | build
  category TEXT,
  total_score NUMERIC, -- null if unknown / insufficient data
  recommendation TEXT, -- buy | consider | watch | avoid | unknown
  confidence NUMERIC NOT NULL DEFAULT 0,
  components JSONB NOT NULL DEFAULT '{}',
  weights JSONB NOT NULL DEFAULT '{}',
  missing TEXT[] NOT NULL DEFAULT '{}',
  rationale TEXT,
  scored_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_scores_time ON scores(scored_at DESC);

CREATE TABLE IF NOT EXISTS collect_runs (
  id SERIAL PRIMARY KEY,
  collector TEXT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'running',
  summary JSONB,
  error TEXT
);

CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS chip_spot_snapshots (
  id SERIAL PRIMARY KEY,
  market TEXT NOT NULL, -- dram_spot | module_spot | gddr_spot
  item TEXT NOT NULL,
  session_avg NUMERIC,
  session_high NUMERIC,
  session_low NUMERIC,
  daily_high NUMERIC,
  daily_low NUMERIC,
  change_pct NUMERIC,
  currency TEXT NOT NULL DEFAULT 'USD',
  source_key TEXT NOT NULL,
  source_url TEXT,
  data_time TIMESTAMPTZ,
  collected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  trust_level TEXT NOT NULL DEFAULT 'third_party',
  status TEXT NOT NULL DEFAULT 'ok',
  fail_reason TEXT,
  raw JSONB
);

CREATE INDEX IF NOT EXISTS idx_chip_spot_time
  ON chip_spot_snapshots(market, item, collected_at DESC);
