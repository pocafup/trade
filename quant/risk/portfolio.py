"""
组合风险监控模块。

输入：{symbol: 持仓市值} 的字典（也支持持股数量或权重，见 input_type）。
数据：一律通过 data/prices.py 的 fetch() 取（复权 SMA 口径）。
输出：PortfolioMetrics dataclass，含组合层面和单只股票层面的完整风险指标。

组合波动率算法（协方差法）
──────────────────────────
  σ_p = sqrt( w' · Σ · w · 252 )

  w：n 维权重向量（Σ w_i = 1）
  Σ：n×n 日对数收益率协方差矩阵（未年化，单位 per day²）
  乘以 252 是年化步骤。

  与直接加权平均波动率（Σ w_i·σ_i）的区别：
    加权平均假设所有资产相关系数 = 1（同步涨跌），是上界。
    协方差法利用实际相关性，正确捕捉分散化降险效果。
    两者之差即"分散化收益"。

风险贡献度算法（Euler 分解）
──────────────────────────
  RC_i = w_i · (Σ·w)_i / σ_p²

  其中 (Σ·w)_i 是资产 i 与组合收益率的协方差（等于边际风险贡献之分子）。
  满足 Euler 齐次性：Σ RC_i = 1。
  RC_i > w_i 意味该资产贡献了超出市值权重的风险（风险集中）。
"""
from __future__ import annotations

import warnings
from dataclasses import dataclass

import numpy as np
import pandas as pd

from data.prices import fetch
from indicators.risk import (
    max_drawdown,
    beta as _beta_fn,
    sharpe_ratio,
    sortino_ratio,
    var_historical,
    cvar_historical,
)

TRADING_DAYS = 252

_VOL_HIGH = 0.40   # 年化波动 > 40% → 高风险
_VOL_MED  = 0.20   # 年化波动 20-40% → 中风险；< 20% → 低风险


# ── 数据结构 ─────────────────────────────────────────────────────────────────

@dataclass
class AssetMetrics:
    """单只持仓的风险指标。"""
    symbol:            str
    weight:            float   # 市值权重（0~1）
    market_value:      float   # 持仓市值（与 holdings 同单位）
    vol:               float   # 年化波动率
    max_dd:            float   # 最大回撤（负数）
    beta:              float   # Beta（相对 SPY）
    sharpe:            float   # 年化夏普比率
    sortino:           float   # 年化索提诺比率
    var95:             float   # 1日 95% 历史 VaR（对数收益率，负数）
    cvar95:            float   # 1日 95% 历史 CVaR（负数）
    risk_contribution: float   # 对组合总方差的贡献比（0~1，加总=1）
    risk_tier:         str     # "高" / "中" / "低"


@dataclass
class PortfolioMetrics:
    """组合层面的完整风险指标。"""
    total_value:             float
    n_assets:                int
    start_date:              str    # 有效回测起点（ISO 格式）
    end_date:                str    # 数据末端（ISO 格式）

    # 波动率：协方差法 vs 加权平均法
    portfolio_vol:           float  # sqrt(w'Σw·252)
    weighted_avg_vol:        float  # Σ w_i·σ_i（忽略相关性的上界）
    diversification_benefit: float  # = weighted_avg_vol − portfolio_vol（正=有效分散）

    # 组合其他指标
    max_dd:   float
    beta:     float   # 组合 Beta（vs SPY）
    sharpe:   float
    var95:    float   # 1日 95% 历史 VaR
    cvar95:   float   # 1日 95% 历史 CVaR

    # 明细
    per_asset:   dict[str, AssetMetrics]  # 键为 symbol
    correlation: pd.DataFrame             # n×n Pearson 相关系数矩阵（日对数收益率）


# ── 内部核心计算 ──────────────────────────────────────────────────────────────

def _portfolio_vol_from_cov(weights: np.ndarray, cov_daily: np.ndarray) -> float:
    """
    年化组合波动率 = sqrt( w' · Σ · w · 252 )

    cov_daily：日对数收益率协方差矩阵（未年化，shape n×n）
    weights：权重向量（shape n，和为 1）
    """
    daily_var = float(weights @ cov_daily @ weights)   # w'Σw（日方差）
    return float(np.sqrt(max(daily_var, 0.0) * TRADING_DAYS))


def _risk_contributions(weights: np.ndarray, cov_daily: np.ndarray) -> np.ndarray:
    """
    各资产风险贡献度（Euler 分解）。

    RC_i = w_i · (Σ·w)_i / (w'·Σ·w)

    推导：
      σ_p = sqrt(w'Σw)，对 w_i 求偏导 → ∂σ_p/∂w_i = (Σw)_i / σ_p
      Euler 齐次性：σ_p = Σ w_i · ∂σ_p/∂w_i  → Σ RC_i = σ_p
      归一化后：RC_i% = w_i · (Σw)_i / σ_p² ，Σ RC_i% = 1
    """
    cov_w    = cov_daily @ weights          # Σw，向量
    port_var = float(weights @ cov_w)       # w'Σw = σ_p²（日）
    if port_var < 1e-14:
        return np.ones(len(weights)) / len(weights)
    return weights * cov_w / port_var


def _risk_tier(vol: float) -> str:
    if vol > _VOL_HIGH:
        return "高"
    if vol > _VOL_MED:
        return "中"
    return "低"


# ── 主函数 ─────────────────────────────────────────────────────────────────────

def compute_portfolio_risk(
    holdings: dict[str, float],
    lookback: str = "2y",
    input_type: str = "value",
    risk_free: float = 0.0,
    cache_path=None,
) -> PortfolioMetrics:
    """
    计算组合风险指标。

    参数
    ────
    holdings   : {symbol: 数量}
                  input_type="value"  → 数量 = 持仓市值（USD 或任意货币单位）
                  input_type="shares" → 数量 = 持股数量（用最新收盘价换算市值）
                  input_type="weight" → 数量 = 权重（无需和为 1，函数自动归一化）
    lookback   : 数据回看窗口（传给 fetch()），例如 "2y"、"1y"
    risk_free  : 年化无风险利率，用于夏普/索提诺计算
    cache_path : 可选，覆盖 fetch() 默认缓存路径
    """
    symbols = list(holdings.keys())
    # 始终拉 SPY 作为 Beta 基准，若用户持仓已含 SPY 则不重复
    need_spy = "SPY" not in symbols
    all_syms = symbols + (["SPY"] if need_spy else [])

    kw = {} if cache_path is None else {"cache_path": cache_path}
    raw = fetch(all_syms, lookback=lookback, **kw)

    # 只保留持仓标的（不含 SPY）的收盘价，对齐到公共交易日
    prices_df = pd.DataFrame(
        {s: raw[s]["Close"] for s in symbols if s in raw and not raw[s].empty}
    ).dropna(how="any")

    if prices_df.empty:
        raise ValueError("价格数据为空，请检查股票代码和回看区间。")

    missing = [s for s in symbols if s not in prices_df.columns]
    if missing:
        warnings.warn(f"以下标的数据缺失，已跳过：{missing}", stacklevel=2)

    syms = list(prices_df.columns)

    # SPY 价格（与持仓日期对齐，用于 Beta）
    spy_prices: pd.Series | None = None
    if "SPY" in raw and not raw["SPY"].empty:
        spy_prices = raw["SPY"]["Close"].reindex(prices_df.index)

    # ── 市值权重 ──────────────────────────────────────────────────────────────
    if input_type == "value":
        mv = {s: float(holdings[s]) for s in syms}
    elif input_type == "shares":
        mv = {s: float(holdings[s]) * float(prices_df[s].iloc[-1]) for s in syms}
    elif input_type == "weight":
        raw_w = {s: float(holdings[s]) for s in syms}
        total_w = sum(raw_w.values())
        mv = {s: raw_w[s] / total_w for s in syms}   # 当成"规模"，归一化到 1
    else:
        raise ValueError(f"input_type 须为 'value'/'shares'/'weight'，收到: {input_type!r}")

    total_mv = sum(mv.values())
    weights  = {s: mv[s] / total_mv for s in syms}

    # ── 日对数收益率 ───────────────────────────────────────────────────────────
    log_ret = (np.log(prices_df / prices_df.shift(1))).dropna()
    w_arr   = np.array([weights[s] for s in syms])

    # ── 协方差矩阵与组合波动率 ─────────────────────────────────────────────────
    cov_daily      = log_ret.cov().values                          # n×n 日协方差
    port_vol       = _portfolio_vol_from_cov(w_arr, cov_daily)    # 协方差法年化
    ind_vols       = log_ret.std() * np.sqrt(TRADING_DAYS)        # 各股年化波动
    weighted_avg_v = float((w_arr * ind_vols.values).sum())        # 加权平均（上界）
    div_benefit    = weighted_avg_v - port_vol

    # ── 风险贡献度 ─────────────────────────────────────────────────────────────
    rc_arr = _risk_contributions(w_arr, cov_daily)

    # ── 组合日收益率序列 ───────────────────────────────────────────────────────
    # 近似：Σ w_i · ln(P_i_t / P_i_{t-1})。对日度数据误差 < 0.01%。
    port_log_ret = log_ret @ w_arr                                 # pd.Series
    # 组合权益曲线：从 1.0 出发，逐日复利
    port_equity = pd.concat([
        pd.Series([1.0], index=[log_ret.index[0] - pd.offsets.BDay(1)]),
        pd.Series(np.exp(port_log_ret.cumsum().values), index=log_ret.index),
    ])

    # ── 组合级绩效指标 ─────────────────────────────────────────────────────────
    port_max_dd = max_drawdown(port_equity)
    port_sharpe = sharpe_ratio(port_equity, risk_free_annual=risk_free)

    # 组合 Beta = Cov(r_p, r_SPY) / Var(r_SPY)
    port_beta = float("nan")
    if spy_prices is not None:
        spy_log = np.log(spy_prices / spy_prices.shift(1)).dropna()
        common  = port_log_ret.index.intersection(spy_log.index)
        if len(common) >= 30:
            p = port_log_ret.reindex(common).values
            s = spy_log.reindex(common).values
            cov_ps    = float(np.cov(p, s, ddof=1)[0, 1])
            var_s     = float(np.var(s, ddof=1))
            port_beta = cov_ps / var_s if var_s > 1e-14 else float("nan")

    # 组合 VaR / CVaR（直接从组合日对数收益率的经验分布取）
    port_var95  = float(np.percentile(port_log_ret.values, 5.0))
    tail_mask   = port_log_ret.values <= port_var95
    port_cvar95 = float(port_log_ret.values[tail_mask].mean()) if tail_mask.any() else float("nan")

    # ── 单股指标 ──────────────────────────────────────────────────────────────
    per_asset: dict[str, AssetMetrics] = {}
    for i, sym in enumerate(syms):
        p  = prices_df[sym]
        w  = weights[sym]
        rc = float(rc_arr[i])
        v  = float(ind_vols[sym])

        b = _beta_fn(p, spy_prices) if spy_prices is not None else float("nan")

        per_asset[sym] = AssetMetrics(
            symbol            = sym,
            weight            = w,
            market_value      = mv[sym],
            vol               = v,
            max_dd            = max_drawdown(p),
            beta              = b,
            sharpe            = sharpe_ratio(p, risk_free_annual=risk_free),
            sortino           = sortino_ratio(p, risk_free_annual=risk_free),
            var95             = var_historical(p),
            cvar95            = cvar_historical(p),
            risk_contribution = rc,
            risk_tier         = _risk_tier(v),
        )

    corr_matrix = log_ret.corr()

    return PortfolioMetrics(
        total_value             = total_mv,
        n_assets                = len(syms),
        start_date              = str(log_ret.index[0].date()),
        end_date                = str(log_ret.index[-1].date()),
        portfolio_vol           = port_vol,
        weighted_avg_vol        = weighted_avg_v,
        diversification_benefit = div_benefit,
        max_dd                  = port_max_dd,
        beta                    = port_beta,
        sharpe                  = port_sharpe,
        var95                   = port_var95,
        cvar95                  = port_cvar95,
        per_asset               = per_asset,
        correlation             = corr_matrix,
    )
