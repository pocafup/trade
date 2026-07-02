# Handoff — Trade Tracker

最后更新：2026-06-05

---

## 项目结构

```
trade/
  src/                    Next.js 前端 (App Router, TypeScript)
    app/
      page.tsx            主页（持仓总览 + 今日看涨 + 风险速览卡片）
      risk/page.tsx       完整风险分析面板（独立页面）
      stock/[ticker]/     个股详情页
      api/
        portfolio/        持仓 + 盈亏计算（调 yahoo.ts getQuote）
        risk/             代理到 quant:8000/risk/portfolio
        stock/[ticker]/   调 getQuoteSummary，含财报
        daily-focus/      AI 今日看涨 + 持仓风险预警
        debug/            诊断端点：GET /api/debug?t=ARM
  lib/
    yahoo.ts              Yahoo Finance 封装（getQuote / getQuoteSummary）
    daily-focus.ts        AI 分析逻辑（Claude Haiku / Gemini Flash）
    db.ts                 SQLite (Node 内置 node:sqlite，非 better-sqlite3)
    lots.ts               批次(lot)纯函数计算 + lots.test.ts 单元测试
  quant/                  Python FastAPI 量化服务
    main.py               GET /risk/portfolio 端点
    data/
      holdings.py         只读读取 trade.db 持仓
      prices.py           Yahoo Finance 价格缓存（yfinance）
    risk/portfolio.py     协方差矩阵、Euler 风险分解、Beta/Sharpe/VaR
    tests/                pytest 单元测试
    pyproject.toml        Poetry 依赖管理
    Dockerfile            python:3.12-slim，CMD uvicorn --host 0.0.0.0
  docker-compose.yml
  data/trade.db           SQLite（Docker volume trade_data 挂载）
```

---

## Docker 部署

### docker-compose.yml 关键配置

```yaml
services:
  trade:
    environment:
      - QUANT_SERVICE_URL=http://quant:8000   # 容器间通信，不是 127.0.0.1

  quant:
    volumes:
      - trade_data:/data:ro                   # 与 trade 共享同一 SQLite
    environment:
      - DB_PATH=/data/trade.db
```

- `trade` 容器调用 quant 必须用服务名 `http://quant:8000`，`127.0.0.1:8000` 在容器内不通
- `trade_data` volume 以只读方式挂进 quant，quant 通过 `DB_PATH` 环境变量找到 trade.db
- 每次代码更新后需要 `docker compose up -d --build` 重建镜像

### 服务器标准更新流程

```bash
git pull
docker compose up -d --build
```

只改前端：`--build trade`；只改 quant：`--build quant`

---

## 风险分析模块

### 数据流

```
trade.db → quant/data/holdings.py → quant/risk/portfolio.py
                                            ↓
                              GET /risk/portfolio (FastAPI)
                                            ↓
                          src/app/api/risk/route.ts (Next.js 代理)
                                            ↓
                          src/app/risk/page.tsx (完整面板)
                          src/app/page.tsx (速览卡片)
```

### quant 服务数据源优先级

1. `trade.db` 持仓 ≥ 3 只 → `source: "db"`
2. 否则回退到 `quant/my_portfolio.json` → `source: "json"`（已加入 .gitignore）

### quant 本地启动（服务器）

```bash
cd quant
poetry install          # 首次
poetry run python -m uvicorn main:app --host 0.0.0.0 --port 8000
```

Docker 内自动用 Dockerfile CMD 启动，无需手动。

### 返回字段（/risk/portfolio）

```json
{
  "source": "db|json",
  "source_detail": "...",
  "portfolio": {
    "portfolio_vol": 0.341,      // 年化波动（乘100得%）
    "weighted_avg_vol": 0.563,
    "diversification_benefit": 0.222,
    "max_dd": -0.45,
    "beta": 1.23,
    "sharpe": 0.87,
    "var95": -0.032,
    "cvar95": -0.048
  },
  "assets": [                    // 按 risk_contribution 降序
    { "symbol": "ARM", "weight": 0.18, "risk_contribution": 0.26,
      "risk_tier": "高", "vol": 0.55, "beta": 1.8, "sharpe": 1.1 }
  ],
  "correlation": { "ARM": { "MU": 0.59, ... } },
  "clusters": { "AI/半导体/高Beta": { ... } }
}
```

---

## Yahoo Finance API（yahoo.ts）

### 已知坑

1. **Next.js Data Cache 缓存问题**：所有 `fetch` 调用必须加 `cache: 'no-store'`，否则 Yahoo Finance 响应被永久缓存（`force-dynamic` 只管路由级，不管内部 fetch）。已修复，见 yahoo.ts `yfFetch`。

2. **crumb 认证**：`getQuote` 和 `getQuoteSummary` 都必须用 `needsCrumb = true`，否则 Yahoo 可能返回 401 或空数据。`getAuth()` 维护 50 分钟内存缓存。

3. **earnings 模块不稳定**：Yahoo Finance 的 `earnings` 模块（`earningsChart.quarterly`）经常返回空。`getQuoteSummary` 已加备用路径：同时请求 `earningsHistory` 模块，两者取先有数据的那个。

4. **财报调试**（待完成）：访问 `/api/debug?t=ARM` 可查看原始 Yahoo Finance 响应结构，确认 `earnings`/`earningsHistory`/`incomeStatementHistoryQuarterly` 哪个字段有数据。**这个 debug 端点需要在财报问题修复后删除或加鉴权。**

### 内存缓存 TTL

| 缓存 | TTL |
|------|-----|
| quoteCache（实时价格） | 15 秒 |
| summaryCache（详情页） | 60 秒 |
| chartCache（走势图 1d） | 15 秒 |
| chartCache（其他） | 5 分钟 |
| crumb/cookie | 50 分钟 |

---

## daily-focus（今日看涨 + 风险预警）

- 数据源：Yahoo Finance screener（day_gainers, most_actives）+ trending
- AI：优先用 `ANTHROPIC_API_KEY`（Claude Haiku），fallback 用 `GEMINI_API_KEY`（Gemini Flash）
- 结果缓存 1 小时（模块级，容器重启清零）
- **持仓来源**：`daily-focus/route.ts` 用净持股 SQL 查询（`net > 0.0001`），只传当前持有的票给 AI，已清仓的不包含
- **预警过滤**：`parseResponse` 中 alerts 只允许 `isHeld = true` 的候选股，防止 AI 把市场热股（如 INTC）混入持仓预警

---

## 主页风险速览卡片

位置：今日看涨区块 → **风险速览卡片** → Tab 切换栏

行为：
- 挂载时请求 `/api/risk`（不加入 30s 自动刷新，避免频繁调 quant）
- 显示：年化波动 / Beta / 最高风险持仓（`assets[0]`，已按 risk_contribution 降序）
- 数值着色：波动 > 35% 红，> 25% 琥珀，否则绿；Beta > 1.3 红，> 1.0 琥珀
- quant 未启动时显示灰色占位提示，不报错
- 整卡可点击，跳转 `/risk` 完整面板

---

## 财报数据（反复出问题，必读）

**症状**：个股详情页"往期财报"区块消失。

**根本原因**：Yahoo Finance 会不定期把季度 EPS 数据从一个模块搬到另一个模块，无预警。

### 根本原因（2026-06-05 确认）

**`earnings` 模块此前被捆绑在含 `summaryDetail` 的大请求里**。只要 `summaryDetail` 等模块失败，整个请求返回 null，earnings 跟着丢失。**已修复：`earnings` 现在是独立请求。**

### 当前解析优先级（`yahoo.ts` `getQuoteSummary`）

每条路径均独立请求，互不影响：

| 优先级 | 模块 | 字段路径 | 包含 |
|--------|------|----------|------|
| 1 | `earnings`（独立请求） | `earningsChart.quarterly[].{date,actual,estimate}` + `financialsChart.quarterly[].{revenue,earnings}` | EPS实际+预期+营收 |
| 2 | `earningsHistory` | `history[].{epsActual,epsEstimate,quarter.fmt}` | EPS实际+预期 |
| 3 | `incomeStatementHistoryQuarterly` | `incomeStatementHistory[].{endDate,totalRevenue,netIncome}` | 营收+净利润（无EPS） |

路径 1 → 2 → 3 依次尝试，全空才显示空。

### 实测数据结构（ARM，2026-06-05）

- `earnings.earningsChart.quarterly[].date` 格式：`"2Q2025"`（直接传给前端 `fmtQuarter`）
- `earningsHistory.history[].quarter.fmt` 格式：**`"YYYY-MM-DD"`**（如 `"2025-06-30"`），用 `-` 分割，月份 ÷ 3 向上取整得季度
- `earningsHistory.history[].period` 是 `"-4q"` 等相对标签，**不是**季度名称，不要用这个字段

### 排查步骤

**第一步**：访问 `/api/debug?t=ARM`，看 `lengths` 字段：

```json
{ "earningsQLen": 0, "earningsHistLen": 0, "incomeQLen": 4, "trendLen": 5 }
```

哪个 `Len > 0`，就说明哪条路径当前有数据。

**第二步**：根据结果修改 `getQuoteSummary`（`src/lib/yahoo.ts`）：
- 路径 1 有数据但显示空 → 检查 `earningsChart.quarterly` 字段名是否变了（看 `path1_earnings_quarterly` 原始结构）
- 路径 2 有数据但显示空 → 检查 `quarter.fmt` 格式，日期转季度逻辑在那里
- 路径 3 是兜底（目前已接入），只显示营收，没有 EPS
- 路径 4（`earningsTrend`）只有分析师预期，没有历史实际值，通常用处不大

**第三步**：改完后把 `lengths` 的新状态更新回这个表格。

### 注意
- `earningsHistory.history[].period` 是 `"+4q"` 这类相对标签，**不是**季度名称；真正的日期在 `quarter.fmt`（格式 `"M/DD/YYYY"`）
- `incomeStatementHistoryQuarterly.incomeStatementHistory[].endDate.fmt` 格式是 `"YYYY-MM-DD"`，季度转换：月份 ÷ 3 向上取整

---

## 批次(Lot)卖出与超卖校验（2026-07-02）

### 数据模型
- 每笔买入 = 一个批次；卖出通过 `sell_allocations` 表分配到一个或多个买入批次：
  `sell_allocations(id, sell_txn_id → transactions, buy_txn_id → transactions, quantity, created_at, UNIQUE(sell_txn_id, buy_txn_id))`
- `transactions` 表不变，仍 append-only；持仓数量类计算（chart/daily-focus/quant Python）不受影响
- 首次启动迁移 `migrateSellAllocations()`（db.ts）：存量卖出按 **FIFO** 回填分配；
  存量超卖（卖出多于此前买入）能配多少配多少，剩余留空 + console.warn
- 同日无时分秒，排序规则：日期 → 买入先于卖出 → created_at → id（`lots.ts compareTxnsForFifo`）

### 成本/盈亏口径 = 批次具体识别法（2026-07-02 起）
- 持仓成本 = **剩余批次**加权成本（`weightedAvgCost`），卖掉某批后成本只反映没卖的批次
- 已实现盈亏 = Σ(卖价 − 所卖批次买价) × 分配股数（`sellRealizedPnl`）
- 旧口径（持仓页终身买入均价 / 盈亏页移动平均）已废弃——两者本来就互相矛盾
- 无法配对的存量超卖残量：成本兜底 = 卖出日前买入加权均价，无买入则 = 卖价（零盈亏）

### API
- `GET /api/lots?ticker=X` → `{ticker, lots:[{buy_txn_id,date,price,quantity,remaining}], totalRemaining}`
- `POST /api/transactions` 卖出可带 `allocations:[{buy_txn_id,quantity}]`；不带则服务端 FIFO 自动分配。
  校验（400）：批次存在且属于本人本股票、买入日 ≤ 卖出日、不超剩余量、合计 = 卖出股数、持仓充足。
  写入用 `BEGIN IMMEDIATE` 防并发穿插
- `DELETE /api/transactions/[id]`：删卖出会连同分配一起删（批次恢复）；
  删已被配对的买入 → **409**，要先删对应卖出

### 测试
- `npm test`（Node ≥23.6，零依赖跑 TS）：`src/lib/lots.test.ts` 覆盖全部批次数学

---

## 未解决 / 待跟进

1. **财报 EPS 数据**：如果路径 1/2 都是 0，当前兜底到路径 3（仅营收）。下次炸了先看 `/api/debug?t=ARM` 的 `lengths`，按上面排查步骤处理。
2. **主页资产价格刷新**：已加 `cache: 'no-store'` + crumb，如果还有问题先访问 `/api/debug?t=ARM` 确认 `quote.ok` 是否为 true。
3. **debug 端点**（`/api/debug`）：诊断用，建议加 middleware 鉴权（目前 401 需要登录才能访问，已有一定保护）。
