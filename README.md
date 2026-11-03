# DIY Buy Radar — Phase-2 MVP

Ryzen 9600X 平台入手时机监测最小闭环：京东自营公开价抽样、宏观（FRED）、GPU 租赁公开价快照、可配置评分、周报文件生成。

**纪律：绝不编造价格或宏观数字。采集失败写 `null` + `fail_reason`。**

## 已锁定配置

| 项 | 值 |
|----|----|
| 平台 | Ryzen 9600X |
| 优先 | 显卡 + DDR5 |
| 预算 | ≈ ¥7000 |
| 国内价 | 仅京东自营公开价（失败则人工录入） |
| 周报收件人 | `524541577@qq.com`（已授权） |
| 发信地址 | `cuixu524541577-54mbqn@mail.grokbot.com`（由主代理发送） |
| Vast | 暂不定，MVP 不依赖 |

## 快速启动（Docker Compose）

```bash
# 在仓库根目录
cp .env.example .env
# 可选：FRED_API_KEY=...
docker compose up --build
```

- API: http://localhost:3001/health  
- Web: http://localhost:5173  

首次可：

```bash
curl -X POST 'http://localhost:3001/collect?only=all'
curl -X POST http://localhost:3001/reports/weekly
curl http://localhost:3001/reports/weekly/latest
```

## 无 Docker 本地开发（本机已验证路径）

本环境可能没有 Docker。API 在 PostgreSQL 不可用时自动回退 **PGlite**；也可强制：

```bash
# 在仓库根目录
cp .env.example .env
# .env:
# USE_PGLITE=1
# SKIP_REDIS=1
# API_PORT=3001
# REPORTS_DIR=./data/reports

npm install
USE_PGLITE=1 SKIP_REDIS=1 npm run dev -w api
# 另一终端
npm run dev -w web
```

## API 端点

| Method | Path | 说明 |
|--------|------|------|
| GET | `/health` | 健康检查 |
| GET | `/products` | 配件列表 |
| GET | `/prices` | 价格快照 |
| POST | `/prices/manual` | 人工补价 `{product_key, price_cny, source_url?, note?}` |
| GET | `/macro` | 宏观最新 |
| GET | `/gpu-rent` | GPU 租赁快照 |
| GET | `/scores` | 各配件最新评分 |
| POST | `/scores/recompute` | 重算评分 |
| GET | `/data-sources` | 数据源与可信度 |
| POST | `/collect?only=all\|macro\|gpu_rent\|jd` | 手动采集 + 评分 |
| GET | `/events` | SSE heartbeat |
| POST | `/reports/weekly` | 生成周报 md/html |
| GET | `/reports/weekly/latest?format=md\|html\|meta` | 最新周报 |

## 周报与邮件

1. 生成：`POST /reports/weekly` 或 `npm run report:weekly -w api`  
2. 文件：`data/reports/weekly-latest.md` / `.html`  
3. 读取：`GET /reports/weekly/latest`  
4. **发送**：本 MVP **不**直接 SMTP。主代理用 agent inbox  
   `cuixu524541577-54mbqn@mail.grokbot.com` → `524541577@qq.com`，  
   主题/正文取自 latest 报告。定时可用 Grok Bot routine 调上述 API。

## 评分权重（可配置，`app_settings.score_weights`）

- 价格吸引力 30%  
- 性能价格比 20%  
- 供需 15%  
- 产品周期 10%  
- AI 算力环境 10%  
- 个人需求 15%  

有效权重 &lt; 50% → **总分 `unknown`**（禁止填 0）。

## 人工补价

京东常反爬。UI 提供表单，或：

```bash
curl -X POST http://localhost:3001/prices/manual \
  -H 'content-type: application/json' \
  -d '{"product_key":"gpu-4070tis","price_cny":5299,"source_url":"https://item.jd.com/...","note":"自营券后"}'
curl -X POST http://localhost:3001/scores/recompute
```

## 已知限制

- 京东公开价很可能失败 → `status=unknown`，需人工录入  
- Seed 中的 JD SKU 可能过期，需人工核对 `products.jd_sku`  
- GPU 租赁为官网标价，非拍卖成交价；区分 billing_mode  
- FRED：无 key 时走 CSV；官方 JSON API 需 `FRED_API_KEY`  
- BullMQ 需 Redis；`SKIP_REDIS=1` 时仅手动/CLI 触发  
- 无历史价时价格吸引力/趋势组件为 unknown  
- AI 产业收入/利用率等 Phase-1 标注不可自动项，MVP 未假装有数  

## 目录

```
./
  api/          Fastify + collectors + scoring
  web/          React + Vite
  data/reports/ 周报输出
  docker-compose.yml
```
