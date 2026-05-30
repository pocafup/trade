"""
双均线交叉信号（Golden Cross / Death Cross）。

信号定义
--------
  +1（买入）：快均线从下方穿越慢均线（前一日 fast < slow，当日 fast > slow）
  −1（卖出）：快均线从上方穿越慢均线（前一日 fast > slow，当日 fast < slow）
   0（持有）：无穿越事件

无前视偏差保证
--------------
  pandas rolling(n).mean() 在第 T 行使用 [T−n+1, T] 区间的数据，
  不读取 T+1 及之后的任何数据。
  加上 shift(1)（取前一天的差值）同样只向历史方向偏移。
  因此信号函数满足：sig(prices[:T]) == sig(prices)[:T]，
  即截断未来数据不影响历史信号值——本模块的测试文件专门验证了这一点。
"""
from __future__ import annotations

import pandas as pd


def signal(
    prices: pd.Series,
    fast: int = 20,
    slow: int = 50,
) -> pd.Series:
    """
    计算双均线交叉信号序列。

    Parameters
    ----------
    prices : 日线收盘价格序列（DatetimeIndex）
    fast   : 快均线窗口，默认 20 日
    slow   : 慢均线窗口，默认 50 日

    Returns
    -------
    pd.Series[int]，值为 +1 / −1 / 0，与 prices 共享索引。
    前 slow−1 行因均线未预热，全部为 0。

    无前视偏差说明
    -------------
    对于第 T 天：
      ma_fast[T]  = mean(prices[T-fast+1 : T+1])  ← 仅用 T 及之前
      ma_slow[T]  = mean(prices[T-slow+1 : T+1])  ← 仅用 T 及之前
      prev_diff[T] = diff[T-1]                    ← 前一天已知值
    所有计算均不依赖 T+1 及之后的数据。
    """
    # rolling 默认右对齐，min_periods=window 确保不足窗口时输出 NaN（而非虚假均值）
    ma_fast = prices.rolling(window=fast, min_periods=fast).mean()
    ma_slow = prices.rolling(window=slow, min_periods=slow).mean()

    # diff > 0 表示快线在慢线上方
    diff = ma_fast - ma_slow

    # prev_diff：前一天的差值（shift(1) 是向历史偏移，无前视偏差）
    prev_diff = diff.shift(1)

    # 穿越判断：严格过零（避免"恰好相等"时误触发）
    crossed_up   = (prev_diff < 0) & (diff > 0)   # 从下方穿越 → 买入
    crossed_down = (prev_diff > 0) & (diff < 0)   # 从上方穿越 → 卖出

    sig = pd.Series(0, index=prices.index, dtype=int)
    sig[crossed_up]   = 1
    sig[crossed_down] = -1

    return sig
