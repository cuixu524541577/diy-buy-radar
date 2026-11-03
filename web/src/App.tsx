import { useCallback, useEffect, useState } from 'react';
import {
  api,
  type GpuRentRow,
  type MacroRow,
  type PriceRow,
  type Product,
  type ScoreRow,
  type SourceRow,
} from './api/client';

function Pill({ status }: { status: string }) {
  const s = (status || 'unknown').toLowerCase();
  return <span className={`pill ${s}`}>{status}</span>;
}

function fmtTime(t?: string | null) {
  if (!t) return '—';
  try {
    return new Date(t).toLocaleString('zh-CN', { hour12: false });
  } catch {
    return t;
  }
}

export default function App() {
  const [health, setHealth] = useState<Awaited<ReturnType<typeof api.health>> | null>(null);
  const [products, setProducts] = useState<Product[]>([]);
  const [prices, setPrices] = useState<PriceRow[]>([]);
  const [macros, setMacros] = useState<MacroRow[]>([]);
  const [rents, setRents] = useState<GpuRentRow[]>([]);
  const [scores, setScores] = useState<ScoreRow[]>([]);
  const [sources, setSources] = useState<SourceRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState('');
  const [manualKey, setManualKey] = useState('gpu-4070tis');
  const [manualPrice, setManualPrice] = useState('');

  const refresh = useCallback(async () => {
    const [h, p, pr, m, g, s, src] = await Promise.all([
      api.health(),
      api.products(),
      api.prices(),
      api.macro(),
      api.gpuRent(),
      api.scores(),
      api.sources(),
    ]);
    setHealth(h);
    setProducts(p.items);
    setPrices(pr.items);
    setMacros(m.items);
    setRents(g.items);
    setScores(s.items);
    setSources(src.items);
  }, []);

  useEffect(() => {
    refresh().catch((e) => setFlash(String(e)));
  }, [refresh]);

  async function runCollect(only = 'all') {
    setBusy(true);
    setFlash('采集中…');
    try {
      const res = await api.collect(only);
      setFlash(JSON.stringify(res.scores_preview, null, 2));
      await refresh();
    } catch (e) {
      setFlash(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function runWeekly() {
    setBusy(true);
    try {
      const res = await api.weekly();
      setFlash(JSON.stringify(res, null, 2));
    } catch (e) {
      setFlash(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function submitManual() {
    const price = Number(manualPrice);
    if (!Number.isFinite(price)) {
      setFlash('请输入有效价格');
      return;
    }
    setBusy(true);
    try {
      await api.manualPrice({
        product_key: manualKey,
        price_cny: price,
        note: 'UI 人工录入京东自营到手价',
      });
      await api.collect('all').catch(() => null);
      // recompute via scores endpoint collect already scores; refresh
      setFlash(`已录入 ${manualKey} = ¥${price}`);
      await refresh();
    } catch (e) {
      setFlash(String(e));
    } finally {
      setBusy(false);
    }
  }

  const latestByProduct = new Map<string, PriceRow>();
  for (const p of prices) {
    if (!latestByProduct.has(p.product_key)) latestByProduct.set(p.product_key, p);
  }

  return (
    <div className="wrap">
      <header>
        <div>
          <h1>DIY Buy Radar</h1>
          <div className="sub">
            Phase-2 MVP · {health?.platform || '…'} · 预算 ¥{health?.budget_cny ?? '—'} · DB {health?.db || '…'} ·{' '}
            {fmtTime(health?.time)}
          </div>
        </div>
        <div className="actions">
          <button disabled={busy} onClick={() => runCollect('all')}>
            采集全部
          </button>
          <button className="secondary" disabled={busy} onClick={() => runCollect('macro')}>
            仅宏观
          </button>
          <button className="secondary" disabled={busy} onClick={() => runCollect('gpu_rent')}>
            仅 GPU 租赁
          </button>
          <button className="secondary" disabled={busy} onClick={() => runCollect('jd')}>
            仅京东
          </button>
          <button className="secondary" disabled={busy} onClick={runWeekly}>
            生成周报
          </button>
          <button className="secondary" disabled={busy} onClick={() => refresh()}>
            刷新
          </button>
        </div>
      </header>

      {flash ? <div className="flash">{flash}</div> : null}

      <div className="grid" style={{ marginBottom: '1rem' }}>
        <div className="card">
          <h2>总览 / 入手评分</h2>
          <p className="muted">缺数据标 unknown，不填 0。权重 30/20/15/10/10/15。</p>
          <table>
            <thead>
              <tr>
                <th>配件</th>
                <th>总分</th>
                <th>建议</th>
                <th>置信度</th>
              </tr>
            </thead>
            <tbody>
              {scores.map((s) => (
                <tr key={s.product_key}>
                  <td>
                    {s.product_name}
                    <div className="muted">{s.category}</div>
                  </td>
                  <td>{s.total_score ?? <span className="pill unknown">unknown</span>}</td>
                  <td>
                    <Pill status={s.recommendation} />
                  </td>
                  <td>{(Number(s.confidence) * 100).toFixed(0)}%</td>
                </tr>
              ))}
              {!scores.length ? (
                <tr>
                  <td colSpan={4} className="muted">
                    暂无评分 — 先点「采集全部」
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>

        <div className="card">
          <h2>人工补价（京东失败时）</h2>
          <p className="muted">仅记录你亲眼看到的公开到手价，系统不会编造。</p>
          <div className="actions" style={{ marginBottom: '0.5rem' }}>
            <select value={manualKey} onChange={(e) => setManualKey(e.target.value)}>
              {products.map((p) => (
                <option key={p.key} value={p.key}>
                  {p.name}
                </option>
              ))}
            </select>
            <input
              placeholder="价格 CNY"
              value={manualPrice}
              onChange={(e) => setManualPrice(e.target.value)}
              style={{ width: 120, padding: '0.45rem', borderRadius: 8, border: '1px solid var(--border)', background: 'transparent', color: 'inherit' }}
            />
            <button disabled={busy} onClick={submitManual}>
              提交
            </button>
          </div>
          <div className="muted">Jobs: {health?.jobs?.enabled ? 'BullMQ 已启用' : `未启用 (${health?.jobs?.reason || 'n/a'})`}</div>
        </div>
      </div>

      <div className="card" style={{ marginBottom: '1rem' }}>
        <h2>配件与最新价格</h2>
        <table>
          <thead>
            <tr>
              <th>配件</th>
              <th>最新价</th>
              <th>状态</th>
              <th>采集时间</th>
              <th>说明</th>
            </tr>
          </thead>
          <tbody>
            {products.map((p) => {
              const pr = latestByProduct.get(p.key);
              return (
                <tr key={p.key}>
                  <td>
                    {p.name}
                    <div className="muted">
                      {p.jd_url ? (
                        <a href={p.jd_url} target="_blank" rel="noreferrer">
                          京东链接
                        </a>
                      ) : (
                        p.key
                      )}
                    </div>
                  </td>
                  <td>{pr?.price_cny != null ? `¥${pr.price_cny}` : '—'}</td>
                  <td>{pr ? <Pill status={pr.status} /> : <Pill status="unknown" />}</td>
                  <td>{fmtTime(pr?.collected_at)}</td>
                  <td className="muted">{pr?.fail_reason || pr?.source_key || p.notes || ''}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="grid" style={{ marginBottom: '1rem' }}>
        <div className="card">
          <h2>宏观摘要</h2>
          <table>
            <thead>
              <tr>
                <th>序列</th>
                <th>值</th>
                <th>观测日</th>
                <th>状态</th>
              </tr>
            </thead>
            <tbody>
              {macros.map((m) => (
                <tr key={m.series_id}>
                  <td>
                    {m.series_id}
                    <div className="muted">{m.series_name}</div>
                  </td>
                  <td>{m.value ?? '—'}</td>
                  <td>{m.observation_date || '—'}</td>
                  <td>
                    <Pill status={m.status} />
                  </td>
                </tr>
              ))}
              {!macros.length ? (
                <tr>
                  <td colSpan={4} className="muted">
                    暂无
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>

        <div className="card">
          <h2>GPU 租赁快照</h2>
          <table>
            <thead>
              <tr>
                <th>提供商</th>
                <th>型号</th>
                <th>USD/hr</th>
                <th>状态</th>
              </tr>
            </thead>
            <tbody>
              {rents.slice(0, 15).map((r, i) => (
                <tr key={`${r.provider}-${r.gpu_model}-${i}`}>
                  <td>
                    {r.provider}
                    <div className="muted">{r.billing_mode}</div>
                  </td>
                  <td>{r.gpu_model}</td>
                  <td>{r.price_usd_hr ?? '—'}</td>
                  <td>
                    <Pill status={r.status} />
                  </td>
                </tr>
              ))}
              {!rents.length ? (
                <tr>
                  <td colSpan={4} className="muted">
                    暂无
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card">
        <h2>数据源可信度</h2>
        <table>
          <thead>
            <tr>
              <th>源</th>
              <th>可信度</th>
              <th>上次成功</th>
              <th>备注</th>
            </tr>
          </thead>
          <tbody>
            {sources.map((s) => (
              <tr key={s.key}>
                <td>
                  {s.name}
                  <div className="muted">
                    {s.url ? (
                      <a href={s.url} target="_blank" rel="noreferrer">
                        {s.key}
                      </a>
                    ) : (
                      s.key
                    )}
                  </div>
                </td>
                <td>
                  <Pill status={s.trust_level} />
                </td>
                <td>{fmtTime(s.last_ok_at)}</td>
                <td className="muted">{s.last_error || s.notes || ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
