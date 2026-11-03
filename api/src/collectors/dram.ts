import type { Db } from '../db/client.js';
import type { CollectSummary } from './types.js';
import { fetchText, looksGated } from './http.js';

const SOURCE_URL = 'https://www.trendforce.com/price/dram/dram_spot';
const SOURCE_KEY = 'trendforce_dram_spot';

export type DramRow = {
  item: string;
  daily_high: number;
  daily_low: number;
  session_high: number;
  session_low: number;
  session_avg: number;
  change_pct: number | null;
};

/** Parse public TrendForce DRAM Spot HTML table (not /api/* which robots disallow). */
export function parseTrendforceDramSpot(html: string): { rows: DramRow[]; dataTime: string | null } {
  const rows: DramRow[] = [];
  const update =
    html.match(/Last Update\s+([0-9]{4}-[0-9]{2}-[0-9]{2}\s+[0-9]{2}:[0-9]{2}[^\n<]*)/i)?.[1]?.trim() ||
    null;

  // Item label followed by five lcd-num-l cells (daily H/L, session H/L, avg)
  const re =
    /(DDR[0-9][^<]{2,80}?)<\/span>\s*<\/td>\s*<td class="lcd-num-l">([0-9.]+)<\/td>\s*<td class="lcd-num-l">([0-9.]+)<\/td>\s*<td class="lcd-num-l">([0-9.]+)<\/td>\s*<td class="lcd-num-l">([0-9.]+)<\/td>\s*<td class="lcd-num-l">([0-9.]+)<\/td>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const item = m[1].replace(/<[^>]+>/g, '').trim();
    const nums = m.slice(2, 7).map(Number);
    if (!item || nums.some((n) => !Number.isFinite(n))) continue;
    // change % nearby
    const slice = html.slice(m.index, m.index + 450);
    const ch = slice.match(/([+\-–—]?\s*[0-9]+\.[0-9]+)\s*%/);
    let change: number | null = null;
    if (ch) {
      const raw = ch[1].replace(/[–—]/g, '-').replace(/\s+/g, '');
      const n = Number(raw);
      change = Number.isFinite(n) ? n : null;
    }
    rows.push({
      item,
      daily_high: nums[0],
      daily_low: nums[1],
      session_high: nums[2],
      session_low: nums[3],
      session_avg: nums[4],
      change_pct: change,
    });
  }
  return { rows, dataTime: update };
}

export async function collectDram(db: Db): Promise<CollectSummary> {
  const summary: CollectSummary = { collector: 'dram', ok: 0, unknown: 0, error: 0, details: [] };
  const run = await db.query<{ id: number }>(
    `INSERT INTO collect_runs (collector, status) VALUES ('dram','running') RETURNING id`,
  );
  const runId = run.rows[0].id;

  try {
    const res = await fetchText(SOURCE_URL);
    if (!res.ok) {
      summary.error++;
      await db.query(
        `INSERT INTO chip_spot_snapshots
         (market, item, source_key, source_url, trust_level, status, fail_reason, raw)
         VALUES ('dram_spot','ALL',$1,$2,'third_party','error',$3,$4::jsonb)`,
        [SOURCE_KEY, SOURCE_URL, `HTTP ${res.status}`, JSON.stringify({ snippet: res.text.slice(0, 300) })],
      );
      await db.query(`UPDATE data_sources SET last_error=$1, updated_at=NOW() WHERE key=$2`, [
        `HTTP ${res.status}`,
        SOURCE_KEY,
      ]);
    } else if (looksGated(res.text) && !/DDR5 16Gb/i.test(res.text)) {
      summary.unknown++;
      await db.query(
        `INSERT INTO chip_spot_snapshots
         (market, item, source_key, source_url, trust_level, status, fail_reason, raw)
         VALUES ('dram_spot','ALL',$1,$2,'third_party','unknown',$3,$4::jsonb)`,
        [SOURCE_KEY, SOURCE_URL, 'page looks gated', JSON.stringify({ snippet: res.text.slice(0, 300) })],
      );
    } else {
      const { rows, dataTime } = parseTrendforceDramSpot(res.text);
      if (!rows.length) {
        summary.unknown++;
        await db.query(
          `INSERT INTO chip_spot_snapshots
           (market, item, source_key, source_url, trust_level, status, fail_reason, raw)
           VALUES ('dram_spot','ALL',$1,$2,'third_party','unknown',$3,$4::jsonb)`,
          [
            SOURCE_KEY,
            SOURCE_URL,
            'parsed zero DRAM spot rows',
            JSON.stringify({ len: res.text.length, dataTime }),
          ],
        );
        summary.details.push({ status: 'unknown', reason: 'parse_empty' });
      } else {
        const dataTimeIso = dataTime
          ? // TrendForce stamps GMT+8
            new Date(dataTime.replace(' (GMT+8)', '+08:00').replace(' ', 'T')).toISOString()
          : null;
        for (const r of rows) {
          await db.query(
            `INSERT INTO chip_spot_snapshots
             (market, item, session_avg, session_high, session_low, daily_high, daily_low, change_pct,
              currency, source_key, source_url, data_time, trust_level, status, raw)
             VALUES ('dram_spot',$1,$2,$3,$4,$5,$6,$7,'USD',$8,$9,$10,'third_party','ok',$11::jsonb)`,
            [
              r.item,
              r.session_avg,
              r.session_high,
              r.session_low,
              r.daily_high,
              r.daily_low,
              r.change_pct,
              SOURCE_KEY,
              SOURCE_URL,
              dataTimeIso,
              JSON.stringify({ ...r, page_last_update: dataTime }),
            ],
          );
          summary.ok++;
        }
        summary.details.push({ status: 'ok', count: rows.length, data_time: dataTime, sample: rows[0] });
        await db.query(
          `UPDATE data_sources SET last_ok_at=NOW(), last_error=NULL, updated_at=NOW() WHERE key=$1`,
          [SOURCE_KEY],
        );
      }
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
