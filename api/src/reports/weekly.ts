import fs from 'node:fs';
import path from 'node:path';
import type { Db } from '../db/client.js';
import { env } from '../config/env.js';
import { scoreAllActive } from '../scoring/calculator.js';

function esc(s: string) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export async function generateWeeklyReport(db: Db) {
  const scored = await scoreAllActive(db);
  const now = new Date();
  const stamp = now.toISOString().replace(/[:.]/g, '-');

  const { rows: macros } = await db.query<{
    series_id: string;
    series_name: string;
    value: string | null;
    observation_date: string | null;
    status: string;
    source_url: string | null;
  }>(
    `SELECT DISTINCT ON (series_id) series_id, series_name, value::text, observation_date::text, status, source_url
     FROM macro_snapshots ORDER BY series_id, collected_at DESC`,
  );

  const { rows: rents } = await db.query<{
    provider: string;
    gpu_model: string;
    price_usd_hr: string | null;
    billing_mode: string;
    status: string;
    collected_at: string;
  }>(
    `SELECT provider, gpu_model, price_usd_hr::text, billing_mode, status, collected_at::text
     FROM gpu_rent_snapshots
     WHERE collected_at >= NOW() - interval '7 days'
     ORDER BY collected_at DESC LIMIT 40`,
  );

  const { rows: prices } = await db.query<{
    product_key: string;
    name: string;
    price_cny: string | null;
    status: string;
    fail_reason: string | null;
    collected_at: string;
    source_key: string;
  }>(
    `SELECT p.key AS product_key, p.name, s.price_cny::text, s.status, s.fail_reason, s.collected_at::text, s.source_key
     FROM price_snapshots s
     JOIN products p ON p.id = s.product_id
     WHERE s.id IN (SELECT MAX(id) FROM price_snapshots GROUP BY product_id)
     ORDER BY p.priority ASC`,
  );

  const knownScores = scored.filter((s) => s.total_score != null);
  const unknownScores = scored.filter((s) => s.total_score == null);
  const best = [...knownScores].sort((a, b) => (b.total_score as number) - (a.total_score as number))[0];
  const worst = [...knownScores].sort((a, b) => (a.total_score as number) - (b.total_score as number))[0];

  const overall =
    knownScores.length === 0
      ? null
      : Math.round(
          (knownScores.reduce((a, s) => a + (s.total_score as number), 0) / knownScores.length) * 10,
        ) / 10;

  const advice =
    overall == null
      ? 'unknown — 关键价格/历史样本不足，暂不给出买入建议'
      : overall >= 65
        ? '部分买 — 仅对高分且有实价证据的配件'
        : overall >= 45
          ? '继续等待'
          : '继续等待（分数偏低或以 unknown 为主）';

  const md = `# DIY Buy Radar 周报

- 生成时间（UTC）：${now.toISOString()}
- 用户时区参考：Etc/GMT+5 (UTC-5)
- 平台：${env.platform}
- 预算：¥${env.budgetCny}
- 收件人：${env.weeklyReportTo || '未配置（请设置 WEEKLY_REPORT_TO）'}
- 发信地址：${env.agentEmailFrom || '未配置（请设置 AGENT_EMAIL_FROM）'}

## 1. 整体入手评分

${overall == null ? '**unknown**（有效配件分不足）' : `**${overall}** / 100`}

建议：**${advice}**

## 2. 各配件评分

| 配件 | 类别 | 总分 | 建议 | 置信度 | 缺失 |
|------|------|------|------|--------|------|
${scored
  .map(
    (s) =>
      `| ${s.product.name} | ${s.product.category} | ${s.total_score ?? 'unknown'} | ${s.recommendation} | ${(s.confidence * 100).toFixed(0)}% | ${s.missing.join('; ') || '-'} |`,
  )
  .join('\n')}

## 3. 当前相对更值得关注

${best ? `${best.product.name}（${best.total_score}）` : '无（全部 unknown）'}

## 4. 当前相对最不建议冲动购买

${worst ? `${worst.product.name}（${worst.total_score}）` : unknownScores.map((s) => s.product.name).join(', ') || '无'}

## 5–7. AI / GPU 租赁 / 宏观（快照）

### 宏观最新观测

${macros.length ? macros.map((m) => `- ${m.series_id} (${m.series_name}): ${m.value ?? 'unknown'} @ ${m.observation_date ?? 'n/a'} [${m.status}] ${m.source_url || ''}`).join('\n') : '- 无宏观数据'}

### GPU 租赁（近 7 日样本）

${rents.length ? rents.slice(0, 20).map((r) => `- ${r.provider} ${r.gpu_model} ${r.billing_mode}: ${r.price_usd_hr ?? 'unknown'} USD/hr [${r.status}] @ ${r.collected_at}`).join('\n') : '- 无租赁快照'}

### 京东/价格快照

${prices.map((p) => `- ${p.product_key}: ${p.price_cny != null ? '¥' + p.price_cny : 'unknown'} (${p.source_key}, ${p.status})${p.fail_reason ? ' — ' + p.fail_reason : ''} @ ${p.collected_at}`).join('\n')}

## 8. 未来 30–90 天关注点

- DDR5 与目标显卡的有效公开价是否开始连续可采集（结束 unknown）
- GPU 租赁公开价是否与消费级显卡零售价同向变化
- 美债/联邦基金利率是否维持高位并出现 CapEx 放缓的**多源**证据（单一宏观点不够）

## 9. 当前建议

**${advice}**

## 10. 理由 / 置信度 / 风险

- 理由：评分仅在有效权重≥50%时给出数值；否则为 unknown，禁止用 0 凑分。
- 置信度：见各配件 confidence；整体在价格历史不足时偏低。
- 风险：京东反爬导致零售价缺失；租赁价为官网标价非成交价；宏观不直接等于硬件底价。
- 推翻条件：出现连续可靠的零售降价 + AI 使用/收入仍增 + 供给改善的多源证据。

---

> 邮件发送：本文件由 API 生成，不直接发信。请用你在 .env 中配置的 ${env.agentEmailFrom || 'AGENT_EMAIL_FROM'} 发给 ${env.weeklyReportTo || 'WEEKLY_REPORT_TO'}。
> 调用：\`GET /reports/weekly/latest\` 或 \`npm run report:weekly -w api\`
`;

  const html = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"/><title>DIY Buy Radar 周报</title>
<style>body{font-family:system-ui,sans-serif;max-width:900px;margin:2rem auto;padding:0 1rem;line-height:1.5} table{border-collapse:collapse;width:100%} td,th{border:1px solid #ddd;padding:.4rem .6rem;font-size:14px} .unk{color:#a60}</style>
</head><body>
<h1>DIY Buy Radar 周报</h1>
<p>生成：${esc(now.toISOString())} · 平台 ${esc(env.platform)} · 预算 ¥${env.budgetCny}</p>
<p>整体评分：<strong class="${overall == null ? 'unk' : ''}">${overall == null ? 'unknown' : overall}</strong> · 建议：<strong>${esc(advice)}</strong></p>
<h2>配件评分</h2>
<table><thead><tr><th>配件</th><th>总分</th><th>建议</th><th>置信度</th></tr></thead><tbody>
${scored
  .map(
    (s) =>
      `<tr><td>${esc(s.product.name)}</td><td>${s.total_score ?? '<span class="unk">unknown</span>'}</td><td>${esc(s.recommendation)}</td><td>${(s.confidence * 100).toFixed(0)}%</td></tr>`,
  )
  .join('\n')}
</tbody></table>
<pre style="white-space:pre-wrap;background:#f6f8fa;padding:1rem;border-radius:8px">${esc(md)}</pre>
<p style="color:#666;font-size:12px">发信请自行配置：${esc(env.agentEmailFrom || 'AGENT_EMAIL_FROM')} → ${esc(env.weeklyReportTo || 'WEEKLY_REPORT_TO')}</p>
</body></html>`;

  fs.mkdirSync(env.reportsDir, { recursive: true });
  const mdName = `weekly-${stamp}.md`;
  const htmlName = `weekly-${stamp}.html`;
  const mdPath = path.join(env.reportsDir, mdName);
  const htmlPath = path.join(env.reportsDir, htmlName);
  const latestMd = path.join(env.reportsDir, 'weekly-latest.md');
  const latestHtml = path.join(env.reportsDir, 'weekly-latest.html');
  fs.writeFileSync(mdPath, md, 'utf8');
  fs.writeFileSync(htmlPath, html, 'utf8');
  fs.writeFileSync(latestMd, md, 'utf8');
  fs.writeFileSync(latestHtml, html, 'utf8');

  return {
    generated_at: now.toISOString(),
    overall_score: overall,
    advice,
    paths: { md: mdPath, html: htmlPath, latest_md: latestMd, latest_html: latestHtml },
    email: {
      to: env.weeklyReportTo || null,
      from: env.agentEmailFrom || null,
      subject: `DIY Buy Radar 周报 ${now.toISOString().slice(0, 10)} · 整体 ${overall ?? 'unknown'}`,
      note: env.weeklyReportTo
        ? '本服务不直接发信。请用 AGENT_EMAIL_FROM 把 latest 报告发给 WEEKLY_REPORT_TO。'
        : '未配置收件邮箱。请在 .env 设置 WEEKLY_REPORT_TO 与 AGENT_EMAIL_FROM。',
    },
    scored_count: scored.length,
    unknown_count: unknownScores.length,
  };
}

export function readLatestWeekly(format: 'md' | 'html' | 'meta' = 'md') {
  const md = path.join(env.reportsDir, 'weekly-latest.md');
  const html = path.join(env.reportsDir, 'weekly-latest.html');
  if (format === 'html') {
    if (!fs.existsSync(html)) return null;
    return { format, content: fs.readFileSync(html, 'utf8'), path: html };
  }
  if (!fs.existsSync(md)) return null;
  if (format === 'meta') {
    const st = fs.statSync(md);
    return {
      format: 'meta',
      path: md,
      html_path: fs.existsSync(html) ? html : null,
      mtime: st.mtime.toISOString(),
      size: st.size,
      email_to: env.weeklyReportTo || null,
      email_from: env.agentEmailFrom || null,
    };
  }
  return { format: 'md', content: fs.readFileSync(md, 'utf8'), path: md };
}
