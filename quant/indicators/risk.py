"""
风险指标模块。

所有函数接受日线收盘价格序列（pandas Series），返回标量。
约定：
  - 年度交易日数 = 252
  - 收益率使用对数收益率 r_t = ln(P_t / P_{t-1})，方便时间累加
  - VaR / CVaR 置信水平默认 95%（即关注最坏 5% 的情况）
"""
from __future__ import annotations

import numpy as np
import pandas as pd

TRADING_DAYS = 252  # 一年交易日数


# ── 内部工具 ───────────────────────────────────────────────────────────────────

def _log_returns(prices: pd.Series) -> pd.Series:
    """计算对数收益率序列，去掉第一行 NaN。"""
    return np.log(prices / prices.shift(1)).dropna()


# ── 年化波动率 ─────────────────────────────────────────────────────────────────

def annualized_volatility(prices: pd.Series) -> float:
    """
    年化波动率 = σ_日 × √252

    推导：
      日对数收益率的标准差 σ_日 衡量"每天价格随机波动的幅度"。
      由于独立随机变量的方差可加：σ_年² = σ_日² × 252
      因此 σ_年 = σ_日 × √252。
      结果越大，价格越"颠簸"。
    """
    r = _log_returns(prices)
    return float(r.std() * np.sqrt(TRADING_DAYS))


# ── 最大回撤 ───────────────────────────────────────────────────────────────────

def max_drawdown(prices: pd.Series) -> float:
    """
    最大回撤 = min_t { (P_t − max_{s≤t} P_s) / max_{s≤t} P_s }

    推导：
      cummax() 在每个时间点记录"截至当天的历史最高价"（无前视偏差）。
      (P_t − 历史峰值) / 历史峰值 就是当天相对峰值的跌幅（负数）。
      取所有时间点的最小值，即最深的那次下跌。
      返回负数，例如 −0.35 表示最大曾从峰值跌去 35%。
    """
    running_max = prices.cummax()          # 截至当天的历史最高
    drawdown = (prices - running_max) / running_max
    return float(drawdown.min())


# ── Beta ──────────────────────────────────────────────────────────────────────

def beta(stock_prices: pd.Series, benchmark_prices: pd.Series) -> float:
    """
    Beta = Cov(r_股, r_基准) / Var(r_基准)

    推导：
      回归 r_股 = α + β × r_基准 + ε，β 即斜率，表示基准每变动 1%
      时股票预期变动多少。
      β = 1：与市场同步；β = 1.5：市场涨 1% 时股票涨约 1.5%。
      这里用对数收益率，两序列按日期取交集对齐。
    """
    r_s = _log_returns(stock_prices)
    r_b = _log_returns(benchmark_prices)
    # 只保留两序列都有数据的交易日
    aligned = pd.concat([r_s, r_b], axis=1, join="inner")
    aligned.columns = ["stock", "bench"]
    cov_mat = aligned.cov()
    return float(cov_mat.loc["stock", "bench"] / cov_mat.loc["bench", "bench"])


# ── 夏普比率 ──────────────────────────────────────────────────────────────────

def sharpe_ratio(prices: pd.Series, risk_free_annual: float = 0.0) -> float:
    """
    夏普比率 = (年化超额收益) / (年化波动率)
             = (μ_日 − r_f_日) / σ_日 × √252

    推导：
      超额收益 = 投资回报 − 无风险利率（如国债利率）。
      夏普 = 每承担一单位"总波动"能赚多少超额收益。
      > 1 通常认为不错，> 2 很优秀，< 0 表示跑输无风险资产。
    """
    r = _log_returns(prices)
    rf_daily = risk_free_annual / TRADING_DAYS
    return float((r.mean() - rf_daily) / r.std() * np.sqrt(TRADING_DAYS))


# ── 索提诺比率 ────────────────────────────────────────────────────────────────

def sortino_ratio(prices: pd.Series, risk_free_annual: float = 0.0) -> float:
    """
    索提诺比率 = (年化超额收益) / (下行偏差)

    下行偏差 σ_d = sqrt( mean( min(r_t − r_f_日, 0)² ) ) × √252

    推导：
      与夏普的区别：分母只惩罚"向下的波动"。
      上涨（正收益）不算风险，只有跌破目标收益率才算风险。
      对于非对称收益策略（上涨多、下跌少）比夏普更公平。
      分母用全部 n 个交易日计算均值（而非只取负收益的 n'），
      这样样本量保持一致，不同时期可比。
    """
    r = _log_returns(prices)
    rf_daily = risk_free_annual / TRADING_DAYS
    excess_mean_daily = r.mean() - rf_daily

    # 只保留低于目标收益率的部分，正收益一律视为 0
    below_target = np.minimum(r.values - rf_daily, 0.0)
    downside_var_daily = np.mean(below_target ** 2)

    if downside_var_daily == 0:
        return float("inf")

    return float(excess_mean_daily / np.sqrt(downside_var_daily) * np.sqrt(TRADING_DAYS))


# ── 历史法 VaR ────────────────────────────────────────────────────────────────

def var_historical(prices: pd.Series, confidence: float = 0.95) -> float:
    """
    历史法 VaR（在险价值，Value at Risk）

    VaR_{c} = 收益率序列的第 (1−c)×100 百分位数

    直觉：
      在置信水平 c=95% 下，VaR 是"最坏 5% 情形的边界"。
      例如 VaR = −0.023 表示：历史上有 95% 的交易日，
      单日损失不超过 2.3%（另外 5% 的日子亏得更多）。
      历史法直接用实际收益率排序，不假设正态分布。
    """
    r = _log_returns(prices)
    return float(np.percentile(r, (1.0 - confidence) * 100))


# ── 历史法 CVaR ───────────────────────────────────────────────────────────────

def cvar_historical(prices: pd.Series, confidence: float = 0.95) -> float:
    """
    历史法 CVaR（条件在险价值 / 期望损失，Expected Shortfall）

    CVaR_{c} = E[ r | r ≤ VaR_{c} ]
             = 超过 VaR 阈值的那些极端亏损日的平均收益率

    直觉：
      VaR 只回答"最坏 5% 的边界在哪里"，但不告诉你跌破后平均跌多少。
      CVaR 回答"一旦进入最坏 5% 的情形，平均亏多少"。
      CVaR 比 VaR 更保守、更能反映尾部风险，常用于压力测试。
    """
    r = _log_returns(prices)
    var = var_historical(prices, confidence)
    tail = r[r <= var]
    return float(tail.mean())
