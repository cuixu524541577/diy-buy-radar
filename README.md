# DIY Buy Radar — Phase-2 MVP

Ryzen 9600X 平台入手时机监测最小闭环：免费宏观/DRAM/GPU 租赁日更、合规公开页参考价抽样、京东自营（失败则人工）、可配置评分、周报文件生成。

**纪律：绝不编造价格或宏观数字。采集失败写 `null` + `fail_reason`。不绕登录、验证码、付费墙。**

## 已锁定配置

| 项 | 值 |
|----|----|
| 平台 | Ryzen 9600X |
| 优先 | 显卡 + DDR5 |
| 预算 | ≈ ¥7000 |
| 国内价 | 京东自营公开价（常失败）+ PConline **参考价**日更抽样；ZOL 脆弱 |
| 周报邮箱 | 不内置。各自在 `.env` 填写 `WEEKLY_REPORT_TO`、`AGENT_EMAIL_FROM` |
| Vast | 暂不定，MVP 不依赖 |

## 免费 / 低摩擦数据源清单

| 源 | 指标 | 频率 | 方式 | 状态 | 说明 |
|----|------|------|------|------|------|
| [FRED CSV](https://fred.stlouisfed.org/graph/fredgraph.csv) | 美债、Fed、CPI/PCE、失业率、美元指数、USD/CNY、信用利差、WTI、VIX | 日/周/月 | 免费 CSV（可选 `FRED_API_KEY`） | **稳定已接入** | 无需 key |
| [RunPod Pricing](https://www.runpod.io/pricing) | GPU 小时标价 | 日更 | 公开页 | **稳定已接入** | 标价≠拍卖成交 |
| [Lambda Pricing](https://lambda.ai/pricing) | GPU on-demand 标价 | 日更 | 公开页 | **稳定已接入** | 同上 |
| [TrendForce DRAM Spot](https://www.trendforce.com/price/dram/dram_spot) | DDR5/DDR4 芯片现货 Session Avg 等 | 日更 | 公开 HTML | **稳定已接入** | `robots.txt` 禁止 `/api/*`，只采公开页 |
| [PConline 产品报价](https://product.pconline.com.cn/) | CPU/内存/显卡公开参考价 | 日更 | 列表页 HTML（GBK） | **已接入** | 第三方参考价，非京东到手 |
| [ZOL 显卡报价](https://detail.zol.com.cn/vga/) | 显卡参考价 | 日更 | 列表页 HTML | **脆弱** | 常 challenge→`unknown` |
| [海纳开放平台](https://ai.zhidemai.com/haina-platform) | 电商 SKU 价/史 | 日更 | **需申请 API Key** | 未接 | 登录后申请；审核后才有数 |
| [值得买开放平台](https://openapi.zhidemai.com/) | 商品价 API | — | App Key + OAuth | 未接 | 暂不自助开放 |
| [Keepa](https://keepa.com/api-docs/) | Amazon 价格史 | — | 付费 API | **不做** | 无京东/天猫/Amazon.cn domain |
| 京东自营 HTML | 到手价 | — | 公开页 | **常失败** | 反爬；建议人工或正规联盟 API |
| 闲鱼成交 | 二手成交 | — | — | **不做** | 挂牌≠成交；无合规成交 API |
| TrendForce 合约详报 / Gold+ | 合约价明细 | — | 会员墙 | **不做自动** | 仅可用公开新闻摘要人工录入 |
| Fed / ECB 决议摘要 | 利率预期 | 会后 | 人工/RSS | 半自动 | 不伪造点阵概率 |

### 明确不做

- 绕过京东/ZOL 登录、验证码、风控 challenge
- Keepa 充数中国 DIY 价
- 把参考价伪称为京东自营到手价
- 抓取 `trendforce.com/api/*`（robots 禁止）

### 本机实测（箱时区 UTC-5，约 2026-11-03）

| Collector | 结果 |
|-----------|------|
| `dram` | **ok=6**（例：DDR5 16Gb 4800/5600 Session Avg **61.5 USD**，Last Update 2026-11-03 11:00 GMT+8） |
| `pconline` | **ok=3**：9600X **¥1949**、DDR5-6000 32GB kit **¥559**、RTX 5070 **¥4599**；4070 Ti SUPER / B650 Tomahawk 首页无匹配→`unknown` |
| `zol` | **unknown**（challenge/gate） |
| `gpu_rent` | **ok=48**（RunPod 42 + Lambda 6） |
| `jd` | 仍失败→`unknown`（需人工 `POST /prices/manual`） |

## 日更如何开启

默认 **一天一次**采集 + 评分。

| 环境 | 机制 | 默认 cron（箱时区 = 用户 UTC-5） |
|------|------|----------------------------------|
| `SKIP_REDIS=0` 且本机 Redis `6379` 可达 | BullMQ repeatable | `DAILY_CRON=15 10 * * *`（约 10:15） |
| `SKIP_REDIS=1` 或 Redis 不可达 | **node-cron** 同表达式 | 同上；周报 `WEEKLY_CRON=0 9 * * 1` |

> **说明：** Cursor「Redis」插件/技能 ≠ 本机 `redis-server`。本开发箱 apt 源 500、无 Docker sock，**无法起本地 Redis**；保持 `SKIP_REDIS=1`，日更由 node-cron 承担，**不破坏 PGlite 路径**。Compose 部署时设 `SKIP_REDIS=0` 即可走 BullMQ。

手动立即跑：

```bash
curl -X POST 'http://localhost:3001/collect?only=all'
# 或单源：macro | gpu_rent | dram | pconline | zol | jd
npm run collect -w api -- dram
npm run collect -w api -- pconline
```

需要用户申请的 key（可选）：

| Key | 用途 |
|-----|------|
| `FRED_API_KEY` | 可选；无 key 时 FRED CSV 已够用 |
| 海纳 / 值得买开放平台 | 正规电商价；申请通过前不自动调用 |
| 京东联盟/开放平台 | 正规到手价；需资质，MVP 未接 |

## 快速启动（Docker Compose）

```bash
cd /workspace/diy-buy-radar
cp .env.example .env
# 可选：FRED_API_KEY=...
docker compose up --build
```

- API: http://localhost:3001/health  
- Web: http://localhost:5173  

Compose 内含 Postgres + Redis；此时应 `SKIP_REDIS=0`，走 BullMQ 日更。

## 无 Docker 本地开发（PGlite）

```bash
cd /workspace/diy-buy-radar
# .env：
# USE_PGLITE=1
# SKIP_REDIS=1          # 无本机 Redis；日更由 node-cron
# DAILY_CRON=15 10 * * *
# WEEKLY_CRON=0 9 * * 1

npm install
USE_PGLITE=1 SKIP_REDIS=1 npm run dev -w api
```

## API 端点（增补）

| Method | Path | 说明 |
|--------|------|------|
| POST | `/collect?only=all\|macro\|gpu_rent\|dram\|pconline\|zol\|jd` | 手动采集 + 评分 |
| GET | `/chip-spot` | TrendForce 等芯片现货快照 |
| GET | `/prices` | 含 `pconline_ref` / `zol_ref` / `jd_public` / `manual_entry` |
| POST | `/prices/manual` | 京东到手价人工补录（推荐） |

## 京东为何仍建议人工 / 正规 API

实测公开 HTML 与旧价接口在数据中心 IP 上几乎全部失败。合规选项：

1. 你在浏览器看到到手价后 `POST /prices/manual`
2. 申请值得买海纳 / 开放平台 API（需审核）
3. 京东官方联盟/开放平台（需资质，本 MVP 未接）

PConline 参考价只作供需与相对高低的旁证，**评分仍应优先你录入的京东到手价**。首页未出现的型号（如 4070 Ti SUPER、B650 Tomahawk）会标 `unknown`，不会伪造。

## 评分权重（可配置）

- 价格吸引力 30% · 性能价格比 20% · 供需 15% · 产品周期 10% · AI 算力环境 10% · 个人需求 15%  
- 有效权重 < 50% → 总分 `unknown`（禁止填 0）

## 目录

```
diy-buy-radar/
  api/          Fastify + collectors + scoring + daily jobs
  web/          React + Vite
  data/reports/ 周报输出
  docker-compose.yml
```
