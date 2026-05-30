"""
双均线交叉信号（Golden Cross / Death Cross），可选趋势过滤。

信号定义
--------
  +1（买入）：快均线从下方穿越慢均线，且（若启用趋势过滤）价格 > 趋势均线
  −1（卖出）：快均线从上方穿越慢均线（不受趋势过滤影响，持仓可随时卖出）
   0（持有）：无穿越事件

趋势过滤（trend 参数）
----------------------
  当 trend 不为 None 时，第 T 天发出买入信号额外需满足：
    prices[T] > MA(trend)[T]
  MA(trend)[T] 只用 [T−trend+1, T] 的数据，无前视偏差。
  未满足趋势均线预热期（前 trend−1 天）时，NaN > NaN 为 False，买入自动屏蔽。
  卖出信号不受此约束——已持仓时不论趋势均线位置均可发出卖出信号。

无前视偏差保证
--------------
  对于第 T 天，所有计算只用 [0, T] 区间数据：
    ma_fast[T]、ma_slow[T]、ma_trend[T] 均为右对齐滚动窗口
    prev_diff[T] = diff[T-1]（shift(1) 向历史偏移）
"""
from __future__ import annotations

import pandas as pd


def signal(
    prices: pd.Series,
    fast: int = 20,
    slow: int = 50,
    trend: int | None = None,
) -> pd.Series:
    """
    双均线交叉信号，可选趋势均线过滤。

    Parameters
    ----------
    prices : 日线收盘价格序列（DatetimeIndex）
    fast   : 快均线窗口，默认 20 日
    slow   : 慢均线窗口，默认 50 日
    trend  : 趋势过滤均线窗口（None = 不过滤）。
             设为 200 时，仅在收盘价高于 200 日均线时接受买入信号。

    Returns
    -------
    pd.Series[int]，值为 +1 / −1 / 0，与 prices 共享索引。
    """
    ma_fast = prices.rolling(window=fast, min_periods=fast).mean()
    ma_slow = prices.rolling(window=slow, min_periods=slow).mean()

    diff      = ma_fast - ma_slow
    prev_diff = diff.shift(1)   # 前一天差值，向历史偏移，无前视偏差

    crossed_up   = (prev_diff < 0) & (diff > 0)   # 金叉：从下方穿越
    crossed_down = (prev_diff > 0) & (diff < 0)   # 死叉：从上方穿越

    if trend is not None:
        # 趋势均线：MA(trend)[T] = mean(prices[T-trend+1 : T+1])，只看历史
        ma_trend = prices.rolling(window=trend, min_periods=trend).mean()
        # 价格低于趋势均线（或均线尚未预热）时屏蔽买入；NaN 比较返回 False，自动屏蔽预热期
        above_trend = prices > ma_trend
        crossed_up  = crossed_up & above_trend

    sig = pd.Series(0, index=prices.index, dtype=int)
    sig[crossed_up]   = 1
    sig[crossed_down] = -1

    return sig
