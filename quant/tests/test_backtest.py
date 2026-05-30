"""
回测引擎测试。

重点验证：
  1. T+1 成交（买入和卖出都在 T+1 开盘价，而非 T 收盘价）
  2. 买入持有策略与直接计算结果精确一致
  3. 手续费双向扣除
  4. 边界情况：无信号、重复信号、未平仓
"""
from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from backtest.engine import BacktestResult, Trade, run


# ── 测试工具 ───────────────────────────────────────────────────────────────────

def _ohlcv(
    opens: list[float],
    closes: list[float],
) -> pd.DataFrame:
    n = len(opens)
    dates = pd.date_range("2020-01-02", periods=n, freq="B")
    return pd.DataFrame(
        {
            "Open":   opens,
            "High":   [max(o, c) * 1.005 for o, c in zip(opens, closes)],
            "Low":    [min(o, c) * 0.995 for o, c in zip(opens, closes)],
            "Close":  closes,
            "Volume": [100_000] * n,
        },
        index=dates,
    )


def _sig(values: list[int], ohlcv: pd.DataFrame) -> pd.Series:
    return pd.Series(values, index=ohlcv.index, dtype=int)


# ── T+1 成交专项测试 ───────────────────────────────────────────────────────────

class TestT1Execution:
    """证明引擎在 T+1 开盘价成交，绝不用 T 收盘价。"""

    def test_buy_executes_at_t_plus_1_open(self):
        """
        构造：
          index 2（T）发出买入信号，收盘价 = 102
          index 3（T+1）开盘价 = 200（与收盘价 102 有巨大缺口）
          index 5  发出卖出信号 → index 6 执行（完成往返）

        断言：
          - 买入成交日 = index 3（不是 index 2）
          - 买入成交价 = 200（不是 102，即不用 T 收盘价）

        如果引擎错误地在 T 收盘价 102 成交，entry_price 会明显偏低。
        """
        opens  = [99,  100, 101, 200, 201, 202, 203, 204]
        closes = [100, 101, 102, 103, 104, 105, 106, 107]
        ohlcv  = _ohlcv(opens, closes)
        #                  0   1   2   3   4   5   6   7
        sigs   = _sig([0, 0, 1, 0, 0, -1, 0, 0], ohlcv)

        result = run(ohlcv, sigs, commission=0.0)

        assert len(result.trades) == 1
        t = result.trades[0]
        # T+1 = index 3，开盘 200（不是 T=index 2 收盘价 102）
        assert t.entry_date  == ohlcv.index[3]
        assert t.entry_price == pytest.approx(200.0)

    def test_sell_executes_at_t_plus_1_open(self):
        """
        卖出信号同样在 T+1 开盘价成交。
        index 2 发出卖出信号 → index 3 以开盘价 500 成交。
        """
        opens  = [100, 101, 102, 500, 103]
        closes = [100, 101, 102, 103, 104]
        ohlcv  = _ohlcv(opens, closes)
        sigs   = _sig([1, 0, -1, 0, 0], ohlcv)

        result = run(ohlcv, sigs, commission=0.0)

        assert len(result.trades) == 1
        t = result.trades[0]
        # 卖出信号在 index 2 → 在 index 3 以开盘 500 成交
        assert t.exit_date  == ohlcv.index[3]
        assert t.exit_price == pytest.approx(500.0)

    def test_t_day_close_price_never_used_for_execution(self):
        """
        把 T 天的收盘价设成极端值，T+1 成交价不受影响。
        """
        opens  = [100, 101, 102, 103, 104, 105]
        # 把 index 2 的收盘价设成 999（极端值，但成交只看 Open）
        closes = [100, 101, 999, 103, 104, 105]
        ohlcv  = _ohlcv(opens, closes)
        sigs   = _sig([1, 0, -1, 0, 0, 0], ohlcv)

        result = run(ohlcv, sigs, commission=0.0)

        t = result.trades[0]
        # 卖出在 index 2 信号 → index 3 开盘 103（不是收盘 999）
        assert t.exit_price == pytest.approx(103.0)


# ── 买入持有一致性测试 ─────────────────────────────────────────────────────────

class TestBuyAndHoldConsistency:
    """
    全程持有策略（第 0 天信号买入，之后不卖出）的回测结果
    应与手动计算精确一致。
    """

    def test_equity_matches_direct_formula(self):
        """
        手动公式：
          在 index 1 开盘价买入（T+1 规则），shares = cash / (open[1] * (1+c))
          持有到最后一天收盘（无卖出手续费，权益 = shares * close[-1]）
          total_return = (shares * close[-1]) / initial − 1
        """
        commission = 0.001
        initial    = 10_000.0

        prices = np.linspace(100.0, 160.0, 60)
        opens  = prices * 0.998
        ohlcv  = _ohlcv(list(opens), list(prices))
        sigs   = _sig([1] + [0] * 59, ohlcv)

        result = run(ohlcv, sigs, initial_capital=initial, commission=commission)

        # 手动计算
        entry_price      = opens[1]
        shares_expected  = initial / (entry_price * (1 + commission))
        final_equity     = shares_expected * prices[-1]
        expected_return  = final_equity / initial - 1

        assert result.total_return == pytest.approx(expected_return, rel=1e-9)

    def test_no_trade_commission_zero_return(self):
        """无信号、无交易，权益始终等于初始资金。"""
        ohlcv  = _ohlcv([100, 110, 120, 130], [100, 110, 120, 130])
        sigs   = _sig([0, 0, 0, 0], ohlcv)
        result = run(ohlcv, sigs, initial_capital=5_000)
        assert result.total_return == pytest.approx(0.0, abs=1e-12)
        assert (result.equity == 5_000.0).all()


# ── 手续费测试 ────────────────────────────────────────────────────────────────

class TestCommission:

    def test_commission_reduces_return(self):
        """有手续费时总收益低于无手续费时。"""
        opens  = list(np.linspace(100.0, 130.0, 10))
        closes = list(np.linspace(100.0, 130.0, 10))
        ohlcv  = _ohlcv(opens, closes)
        sigs   = _sig([1, 0, 0, 0, 0, -1, 0, 0, 0, 0], ohlcv)

        r0   = run(ohlcv, sigs, commission=0.0)
        r001 = run(ohlcv, sigs, commission=0.001)

        assert r001.total_return < r0.total_return

    def test_round_trip_same_price_causes_loss(self):
        """
        买入价 = 卖出价（无净价格变化）：
          无手续费 → 收益 ≈ 0
          有手续费 → 亏损（双向手续费之和约 0.2%）
        """
        ohlcv = _ohlcv([100, 100, 100, 100], [100, 100, 100, 100])
        sigs  = _sig([1, 0, -1, 0], ohlcv)

        r_free = run(ohlcv, sigs, commission=0.0)
        r_fee  = run(ohlcv, sigs, commission=0.001)

        assert r_free.total_return == pytest.approx(0.0, abs=1e-9)
        assert r_fee.total_return < -0.001   # 亏超过 0.1%

    def test_commission_charged_on_both_sides(self):
        """
        用数学关系验证买卖各收一次手续费。
        买入价 P_e，卖出价 P_x，手续费 c：
          pnl_pct = P_x*(1−c) / (P_e*(1+c)) − 1
        """
        ohlcv  = _ohlcv([100, 100, 110, 110], [100, 100, 110, 110])
        sigs   = _sig([1, 0, -1, 0], ohlcv)
        c      = 0.002

        result = run(ohlcv, sigs, commission=c)

        t = result.trades[0]
        # entry_price = open[1] = 100，exit_price = open[2] = 110
        expected_pnl_pct = 110 * (1 - c) / (100 * (1 + c)) - 1
        assert t.pnl_pct == pytest.approx(expected_pnl_pct, rel=1e-9)


# ── 边界情况 ──────────────────────────────────────────────────────────────────

class TestEdgeCases:

    def test_sell_ignored_when_not_holding(self):
        """无持仓时，卖出信号被忽略，权益不变。"""
        ohlcv  = _ohlcv([100, 101, 102, 103], [100, 101, 102, 103])
        sigs   = _sig([-1, -1, -1, -1], ohlcv)
        result = run(ohlcv, sigs, initial_capital=10_000)
        assert result.n_trades == 0
        assert (result.equity == 10_000.0).all()

    def test_duplicate_buy_signal_no_doubling(self):
        """已持仓时，重复买入信号不加仓（只在空仓时才买）。"""
        ohlcv  = _ohlcv([100, 101, 102, 103, 104, 105], [100, 101, 102, 103, 104, 105])
        sigs   = _sig([1, 1, 1, -1, 0, 0], ohlcv)
        result = run(ohlcv, sigs, commission=0.0)
        # 只执行一次买入（index 1）
        assert result.n_trades == 1
        assert result.trades[0].entry_date == ohlcv.index[1]

    def test_open_position_at_end_recorded(self):
        """回测结束时仍持仓，open_entry_date 应被记录。"""
        ohlcv  = _ohlcv([100, 101, 102, 103], [100, 101, 102, 103])
        sigs   = _sig([1, 0, 0, 0], ohlcv)
        result = run(ohlcv, sigs)
        assert result.has_open_position
        assert result.open_entry_date == ohlcv.index[1]
        assert result.open_entry_price == pytest.approx(101.0)

    def test_signal_alignment_with_missing_dates(self):
        """信号序列日期不完整时，缺失日期填 0（不交易）。"""
        ohlcv  = _ohlcv([100, 101, 102, 103, 104], [100, 101, 102, 103, 104])
        # 只提供部分日期的信号
        partial_sigs = pd.Series([1, -1], index=ohlcv.index[[0, 3]])
        result = run(ohlcv, partial_sigs, commission=0.0)
        assert len(result.trades) == 1

    def test_equity_curve_reflects_open_position(self):
        """未平仓时，权益曲线应反映持仓市值（随收盘价变化）。"""
        opens  = [100, 100, 100, 100]
        closes = [100, 100, 110, 120]   # 持仓后涨价
        ohlcv  = _ohlcv(opens, closes)
        sigs   = _sig([1, 0, 0, 0], ohlcv)

        result = run(ohlcv, sigs, initial_capital=10_000, commission=0.0)

        # index 1 以 100 买入 100 股，之后跟随收盘价
        assert result.equity.iloc[2] == pytest.approx(100 * 110)
        assert result.equity.iloc[3] == pytest.approx(100 * 120)


# ── 绩效指标 ──────────────────────────────────────────────────────────────────

class TestMetrics:

    def test_total_return_formula(self):
        """10% 上涨（无手续费买入持有）→ total_return ≈ 10%"""
        ohlcv  = _ohlcv([100, 100, 100, 100, 100], [100, 100, 100, 100, 110])
        sigs   = _sig([1, 0, 0, 0, 0], ohlcv)
        result = run(ohlcv, sigs, commission=0.0)
        assert result.total_return == pytest.approx(0.10, rel=1e-6)

    def test_win_rate_all_winning(self):
        """所有交易盈利 → 胜率 = 100%"""
        opens  = list(np.linspace(100.0, 200.0, 10))
        closes = list(np.linspace(100.0, 200.0, 10))
        ohlcv  = _ohlcv(opens, closes)
        sigs   = _sig([1, 0, 0, 0, 0, -1, 0, 0, 0, 0], ohlcv)
        result = run(ohlcv, sigs, commission=0.0)
        assert result.win_rate == pytest.approx(1.0)

    def test_win_rate_nan_when_no_trades(self):
        """无完成交易 → 胜率 = NaN（分母为 0）"""
        ohlcv  = _ohlcv([100] * 5, [100] * 5)
        sigs   = _sig([0] * 5, ohlcv)
        result = run(ohlcv, sigs)
        assert np.isnan(result.win_rate)

    def test_max_drawdown_is_negative(self):
        """最大回撤应 ≤ 0（单调上涨策略除外）"""
        np.random.seed(42)
        prices = 100.0 * np.exp(np.cumsum(np.random.normal(0.001, 0.02, 200)))
        ohlcv  = _ohlcv(list(prices), list(prices))
        sigs   = _sig([1] + [0] * 199, ohlcv)
        result = run(ohlcv, sigs)
        assert result.max_dd <= 0
