import type { Db } from '../db/client.js';
import { env } from '../config/env.js';
import type { CollectSummary } from './types.js';

const SERIES = [
  { id: 'DGS2', name: 'US 2Y Treasury Yield' },
  { id: 'DGS10', name: 'US 10Y Treasury Yield' },
  { id: 'DGS20', name: 'US 20Y Treasury Yield' },
  { id: 'DGS30', name: 'US 30Y Treasury Yield' },
  { id: 'T10Y2Y', name: 'US 10Y-2Y Treasury Spread' },
  { id: 'FEDFUNDS', name: 'Federal Funds Effective Rate' },
  { id: 'CPIAUCSL', name: 'US CPI All Urban SA' },
  { id: 'PCEPI', name: 'US PCE Price Index' },
  { id: 'UNRATE', name: 'US Unemployment Rate' },
  { id: 'DTWEXBGS', name: 'Trade Weighted USD Index (Broad)' },
  { id: 'DEXCHUS', name: 'CNY per USD Spot (H.10)' },
  { id: 'BAMLH0A0HYM2', name: 'ICE BofA US High Yield OAS' },
  { id: 'BAMLC0A0CM', name: 'ICE BofA US Corporate OAS (IG)' },
  { id: 'DCOILWTICO', name: 'WTI Crude Oil Spot' },
  { id: 'VIXCLS', name: 'CBOE Volatility Index (VIX)' },
];

async function fetchFredCsv(seriesId: string): Promise<{ date: string; value: number | null; url: string; raw: string }> {
  const end = new Date();
  const start = new Date();
  start.setFullYear(start.getFullYear() - 1);
  const cosd = start.toISOString().slice(0, 10);
  const coed = end.toISOString().slice(0, 10);
  const url = `https://fred.stlouisfed.org/graph/fredgraph.csv?id=${seriesId}&cosd=${cosd}&coed=${coed}`;
  const res = await fetch(url, { headers: { 'User-Agent': 'DIY-Buy-Radar/0.1 (research; +local)' } });
  if (!res.ok) throw new Error(`FRED CSV HTTP ${res.status}`);
  const text = await res.text();
  const lines = text.trim().split(/\r?\n/).filter(Boolean);
  // Find last non-empty numeric value
  for (let i = lines.length - 1; i >= 1; i--) {
    const parts = lines[i].split(',');
    if (parts.length < 2) continue;
    const date = parts[0];
    const rawVal = parts[1]?.trim();
    if (!rawVal || rawVal === '.') continue;
    const value = Number(rawVal);
    if (Number.isFinite(value)) return { date, value, url, raw: lines[i] };
  }
  return { date: coed, value: null, url, raw: text.slice(0, 200) };
}

async function fetchFredApi(seriesId: string): Promise<{ date: string; value: number | null; url: string; raw: unknown } | null> {
  if (!env.fredApiKey) return null;
  const url = `https://api.stlouisfed.org/fred/series/observations?series_id=${seriesId}&api_key=${env.fredApiKey}&file_type=json&sort_order=desc&limit=5`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`FRED API HTTP ${res.status}`);
  const json = (await res.json()) as { observations?: Array<{ date: string; value: string }> };
  const obs = json.observations?.find((o) => o.value && o.value !== '.');
  if (!obs) return { date: new Date().toISOString().slice(0, 10), value: null, url, raw: json };
  return { date: obs.date, value: Number(obs.value), url, raw: obs };
}

export async function collectMacro(db: Db): Promise<CollectSummary> {
  const summary: CollectSummary = { collector: 'macro', ok: 0, unknown: 0, error: 0, details: [] };
  const run = await db.query<{ id: number }>(
    `INSERT INTO collect_runs (collector, status) VALUES ('macro','running') RETURNING id`,
  );
  const runId = run.rows[0].id;

  try {
    for (const s of SERIES) {
      try {
        let date: string;
        let value: number | null;
        let url: string;
        let raw: unknown;
        let sourceKey = 'fred_csv';

        const api = await fetchFredApi(s.id);
        if (api) {
          ({ date, value, url, raw } = api);
          sourceKey = 'fred_api';
        } else {
          const csv = await fetchFredCsv(s.id);
          ({ date, value, url, raw } = csv);
        }

        const status = value == null ? 'unknown' : 'ok';
        await db.query(
          `INSERT INTO macro_snapshots
           (series_id, series_name, value, unit, source_key, source_url, observation_date, trust_level, status, fail_reason, raw)
           VALUES ($1,$2,$3,$4,$5,$6,$7,'official',$8,$9,$10::jsonb)`,
          [
            s.id,
            s.name,
            value,
            'index_or_percent',
            sourceKey,
            url,
            date,
            status,
            value == null ? 'empty observation' : null,
            JSON.stringify({ raw }),
          ],
        );
        if (status === 'ok') summary.ok++;
        else summary.unknown++;
        summary.details.push({ series: s.id, status, value, observation_date: date, source: sourceKey });
      } catch (e) {
        summary.error++;
        const msg = (e as Error).message;
        await db.query(
          `INSERT INTO macro_snapshots
           (series_id, series_name, value, unit, source_key, source_url, observation_date, trust_level, status, fail_reason, raw)
           VALUES ($1,$2,NULL,'index_or_percent','fred_csv',$3,NULL,'official','error',$4,'{}'::jsonb)`,
          [s.id, s.name, `https://fred.stlouisfed.org/series/${s.id}`, msg],
        );
        summary.details.push({ series: s.id, status: 'error', reason: msg });
      }
    }

    await db.query(
      `UPDATE data_sources SET last_ok_at = CASE WHEN $1 > 0 THEN NOW() ELSE last_ok_at END,
         last_error = CASE WHEN $2 > 0 THEN $3 ELSE NULL END, updated_at = NOW()
       WHERE key IN ('fred_csv','fred_api')`,
      [summary.ok, summary.error, summary.error ? JSON.stringify(summary.details.filter((d) => d.status === 'error')) : null],
    );

    await db.query(
      `UPDATE collect_runs SET finished_at=NOW(), status='done', summary=$2::jsonb WHERE id=$1`,
      [runId, JSON.stringify(summary)],
    );
  } catch (e) {
    await db.query(
      `UPDATE collect_runs SET finished_at=NOW(), status='error', error=$2 WHERE id=$1`,
      [runId, (e as Error).message],
    );
    throw e;
  }

  return summary;
}
