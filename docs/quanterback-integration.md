# quanterback 对接准备（调研结论 + 配置方案）

> 状态：仅调研，未实现。2026-07 基于 ~/Source/quanterback 当时的代码探索。
> 动手前先重新确认它的结构没变（特别是 `src/quanterback/cli.py` 的 `wire()` 和 config 加载）。

## quanterback 是什么

LLM 多智能体驱动的 Alpaca 模拟盘交易系统：四个 agent（基本面/技术面/情绪/风控）
对每个候选标的辩论 → 通过回测风险闸门 → 提交 ATR 括号单（入场+止损+止盈）到
Alpaca Paper。通过 Telegram 操作。

**关键事实：它没有任何 HTTP API。** 集成面只有四个：

| 入口 | 说明 | 适合 |
|---|---|---|
| CLI（`quanterback scan/positions/trades/...`） | stdout 是人读文本，无 `--json` | 不适合程序调用 |
| Python 库（`quanterback.cli.wire()` + `ScanPipeline`） | 干净但要 Python ≥3.12 + 全套密钥 | 触发分析 |
| SQLite（`/data/quanterback.sqlite`，WAL） | decisions/orders/positions/trades，JSON 列 | 读取结果 |
| Telegram bot | 人用的操作通道 | 不适合服务间对接 |

## 方向 A：trade 读取它的分析结果（推荐先做）

**零 LLM 成本、零 quanterback 改动**，只读它的 SQLite。

数据在哪：
- 表 `decisions`：`summary_json`（标的快照）、`decision_json`（BUY/PASS + 策略参数 +
  rationale + confidence）、`agent_debate_json`（四 agent 各自的多空立场和理由）
- 表 `positions`（状态机，每 ticker 唯一活跃仓）、`trades`（已平仓盈亏：pnl_usd/pnl_pct/
  holding_hours/exit_reason）、`backtests`（`report_json`、`passed`、`failed_checks`）
- Schema 定义：`src/quanterback/adapters/store/schema.py`

配置步骤（到时候做）：
1. docker-compose：把 quanterback 的数据 volume 以**只读**挂进 quant 容器，如
   `quanterback_data:/qb-data:ro`；本地开发直接指向
   `~/Source/quanterback/data/quanterback.sqlite`
2. quant/ 加 env `QUANTERBACK_DB_PATH`，连接串用
   `file:...?mode=ro`（参照 `quant/data/holdings.py` 的只读连接写法）
3. quant/ 加端点（如 `GET /quanterback/decisions?ticker=X&limit=N`）：查 SQLite、
   解析 JSON 列、原样透传 agent 辩论内容
4. Next.js 加代理路由 + 在个股页/宏观页加展示块

注意：跨容器读 WAL 模式的 SQLite，若遇到 `database is locked`，用
`PRAGMA query_only` + 短超时重试即可（它的写入频率很低）。

## 方向 B：trade 触发它分析我的持仓

从 trade 对指定 ticker 现场跑四 agent 辩论（dry-run，不下单）。

可行路径：在 quanterback 仓库里加一个薄 FastAPI wrapper（约 50 行）：

```python
# 伪代码——写的时候对照 cli.py 的 wire() 实际签名
from quanterback.config import AppConfig
from quanterback.cli import wire

config = AppConfig.load([Path("config/quanterback.toml"),
                         Path("config/quanterback.local.toml")])  # 传自定义路径，绕开硬编码的 /config
pipeline, state_service, _tg = wire(config)

@app.post("/analyze")
def analyze(tickers: list[str]):
    run_id = pipeline.run_for_tickers(tickers, trigger_label="trade-app",
                                      force_dry_run=True)   # 只出决策，不提交订单
    # 用 run_id 从它的 sqlite 里把 decisions 捞出来返回
```

硬性条件：
- Python ≥ 3.12（quanterback 的要求；quant/ 服务当前环境未必满足，所以 wrapper
  放它仓库里、单独跑一个进程/容器更干净）
- 配置**只从 TOML 读**（`config.py` 没有实现环境变量 fallback，尽管 toml 注释里
  提到过）：`[alpaca] api_key+secret`、`[telegram] bot_token`、`[llm] anthropic_api_key`
  三组都是启动必填
- 每次分析消耗真实 LLM 调用（四 agent 辩论），要考虑触发频率和费用
- `wire()` 会连 Telegram，通知会发到配置的 chat_ids——wrapper 里可注入
  自定义 Notifier（接口在 `src/quanterback/interfaces/notify.py`）静音

## 铁律边界（重要）

quanterback 用新闻、情绪和 LLM 判断——正是本项目铁律 5 排除、铁律 3 要求与
确定性风险指标分开的东西。集成时必须：

1. **展示分区**：它的输出放独立区块（如"AI 观点"），带来源标注，绝不混入
   /risk 页的波动率/回撤/Beta/VaR 等确定性计算
2. **不入库**：它的决策不写进 trade.db，不参与持仓/盈亏/风险的任何计算，
   只做展示层的参考信息
3. **回测原则**：若将来想把它的信号当策略用，必须先走 quant/backtest 的
   无前视回测流程（铁律 1/2），它自带的 backtests 表不能替代

## 建议顺序

1. 方向 A（1-2 小时的活，无风险无成本）
2. 用一段时间，确认展示形式有用后再考虑方向 B
