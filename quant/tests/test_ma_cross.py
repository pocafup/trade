"""
双均线交叉信号测试。

包含：
  1. 常规功能测试（买入/卖出/持有触发条件）
  2. 前视偏差专项测试 —— 用两种方法验证第 T 天的信号不依赖未来数据
"""
from __future__ import annotations

from datetime import date

import numpy as np
import pandas as pd
import pytest

from models.ma_cross import signal


# ── 工具 ───────────────────────────────────────────────────────────────────────

def _make_prices(values: list[float]) -> pd.Series:
    idx = pd.date_range("2020-01-02", periods=len(values), freq="B")  # 工作日
    return pd.Series(values, index=idx, dtype=float)


def _ramp(start: float, end: float, n: int) -> list[float]:
    """生成从 start 线性变化到 end 的 n 个价格。"""
    return list(np.linspace(start, end, n))


# ── 均线预热期 ─────────────────────────────────────────────────────────────────

def test_no_signal_before_warmup():
    """
    前 49 行（slow=50 的窗口未满）均线无法计算，信号应全为 0。
    """
    prices = _make_prices(list(range(1, 61)))  # 60 个价格
    sig = signal(prices)
    assert (sig.iloc[:49] == 0).all()


# ── 买入信号 ──────────────────────────────────────────────────────────────────

def test_buy_signal_on_golden_cross():
    """
    构造快线从慢线下方穿越到上方的场景：
      - 前 50 天下跌（快线 < 慢线）
      - 后 30 天快速上涨（快线穿越慢线）
    验证穿越点出现 +1 信号。
    """
    # 先下跌再上涨，迫使 MA20 穿越 MA50
    down = _ramp(100.0, 70.0, 50)
    up   = _ramp(70.0, 110.0, 30)
    prices = _make_prices(down + up)
    sig = signal(prices)
    assert 1 in sig.values, "应在均线穿越时产生买入信号（+1）"

def test_buy_signal_value_is_one():
    """买入信号的值应严格为 +1。"""
    rng = np.random.default_rng(42)
    prices = _make_prices(list(100.0 * np.exp(np.cumsum(rng.normal(0.001, 0.02, 300)))))
    sig = signal(prices)
    assert set(sig.unique()).issubset({-1, 0, 1})


# ── 卖出信号 ──────────────────────────────────────────────────────────────────

def test_sell_signal_on_death_cross():
    """
    构造快线从慢线上方穿越到下方的场景：
      - 前 50 天上涨（快线 > 慢线）
      - 后 30 天快速下跌（快线穿越慢线向下）
    验证穿越点出现 −1 信号。
    """
    up   = _ramp(70.0, 110.0, 50)
    down = _ramp(110.0, 70.0, 30)
    prices = _make_prices(up + down)
    sig = signal(prices)
    assert -1 in sig.values, "应在均线向下穿越时产生卖出信号（−1）"


# ── 持有（无穿越）─────────────────────────────────────────────────────────────

def test_hold_when_no_crossover():
    """
    价格单调上涨时，快线始终在慢线上方，不发生穿越，
    预热后所有信号均为 0（持有）。
    """
    prices = _make_prices(list(np.linspace(100.0, 200.0, 100)))
    sig = signal(prices, fast=5, slow=10)
    # 跳过预热期（前 9 行）
    assert (sig.iloc[10:] == 0).all()


# ── 自定义参数 ────────────────────────────────────────────────────────────────

def test_custom_fast_slow_windows():
    """signal() 使用 fast=5, slow=10 时，应在前 9 行全为 0。"""
    prices = _make_prices(list(range(1, 21)))
    sig = signal(prices, fast=5, slow=10)
    assert (sig.iloc[:9] == 0).all()


# ── 前视偏差专项测试 ──────────────────────────────────────────────────────────

def test_no_lookahead_bias_by_truncation():
    """
    【前视偏差测试①：截断法】

    方法：
      (a) 用完整 300 天序列计算信号，记录第 T=150 天的值。
      (b) 截断序列至第 T 天（后面 149 天全部丢弃），重新计算信号，
          取最后一个值。
      (c) 断言 (a) == (b)。

    如果 rolling 偷看了未来数据，(b) 的信号就会与 (a) 不同。
    pandas rolling() 默认右对齐（只看历史），故两者应严格相等。
    """
    rng = np.random.default_rng(2024)
    prices = pd.Series(
        100.0 * np.exp(np.cumsum(rng.normal(0.0, 0.02, 300))),
        index=pd.date_range("2023-01-01", periods=300),
    )
    T = 150  # 均线已预热（T > slow=50）

    sig_full = signal(prices)
    sig_trunc = signal(prices.iloc[: T + 1])

    assert sig_full.iloc[T] == sig_trunc.iloc[-1], (
        f"前视偏差！完整序列的信号={sig_full.iloc[T]}，"
        f"截断到第 {T} 天后信号={sig_trunc.iloc[-1]}，两者不一致"
    )


def test_no_lookahead_bias_by_future_modification():
    """
    【前视偏差测试②：污染法】

    方法：
      (a) 计算原始序列第 T=150 天的信号。
      (b) 把 T+1 之后的价格全部替换为极端值 99999，
          重新计算第 T 天的信号。
      (c) 断言 (a) == (b)。

    如果信号函数访问了未来数据，极端值会改变 T 天的信号。
    正确实现时，T 天的 rolling 均线只看 [T-49, T]，不受后面数据影响。
    """
    rng = np.random.default_rng(2025)
    prices = pd.Series(
        100.0 * np.exp(np.cumsum(rng.normal(0.0, 0.02, 300))),
        index=pd.date_range("2023-01-01", periods=300),
    )
    T = 150

    sig_original = signal(prices).iloc[T]

    prices_tampered = prices.copy()
    prices_tampered.iloc[T + 1 :] = 99999.0   # 用极端值"污染"未来

    sig_tampered = signal(prices_tampered).iloc[T]

    assert sig_original == sig_tampered, (
        f"前视偏差！原始信号={sig_original}，"
        f"污染未来数据后信号={sig_tampered}，两者不一致"
    )


def test_no_lookahead_bias_multiple_dates():
    """
    对 T=60, 100, 150, 200 四个日期分别做截断测试，全部应通过。
    """
    rng = np.random.default_rng(2026)
    prices = pd.Series(
        100.0 * np.exp(np.cumsum(rng.normal(0.0, 0.02, 250))),
        index=pd.date_range("2023-01-01", periods=250),
    )

    for T in [60, 100, 150, 200]:
        sig_full  = signal(prices)
        sig_trunc = signal(prices.iloc[: T + 1])
        assert sig_full.iloc[T] == sig_trunc.iloc[-1], (
            f"T={T} 时存在前视偏差"
        )


# ── 信号稀疏性（大多数时候应为持有）────────────────────────────────────────────

def test_signals_are_sparse():
    """
    穿越事件应该是少数：+1 和 −1 的总数应远小于总行数。
    若信号过于密集，说明均线逻辑有误。
    """
    rng = np.random.default_rng(100)
    prices = pd.Series(
        100.0 * np.exp(np.cumsum(rng.normal(0.001, 0.015, 500))),
        index=pd.date_range("2022-01-01", periods=500),
    )
    sig = signal(prices)
    n_crossovers = (sig != 0).sum()
    assert n_crossovers < len(sig) * 0.1, (
        f"穿越信号占比 {n_crossovers/len(sig):.1%}，超过 10%，均线逻辑可能有误"
    )
