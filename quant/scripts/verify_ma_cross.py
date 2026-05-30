"""
用 AAPL 两年数据跑双均线信号，打印最近 20 个交易日。
运行：cd quant/ && python scripts/verify_ma_cross.py
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import pandas as pd
from data.prices import fetch
from models.ma_cross import signal


def main() -> None:
    print("拉取 AAPL 两年日线数据 …\n")
    data = fetch(["AAPL"], lookback="2y")
    prices = data["AAPL"]["Close"]

    sig = signal(prices, fast=20, slow=50)
    ma20 = prices.rolling(20).mean()
    ma50 = prices.rolling(50).mean()

    df = pd.DataFrame({
        "收盘价": prices,
        "MA20":   ma20,
        "MA50":   ma50,
        "信号值":  sig,
    })
    df["信号"] = df["信号值"].map({1: "▲ 买入", -1: "▼ 卖出", 0: "— 持有"})

    last20 = df.tail(20).copy()
    last20.index = last20.index.strftime("%Y-%m-%d")

    print(f"AAPL 双均线交叉信号（MA{20} / MA{50}）— 最近 20 个交易日\n")
    print(
        last20[["收盘价", "MA20", "MA50", "信号"]].to_string(
            float_format="{:.2f}".format
        )
    )

    # 统计整段历史的信号分布
    total = len(sig.dropna())
    buys  = (sig == 1).sum()
    sells = (sig == -1).sum()
    print(f"\n历史信号统计（共 {total} 个交易日）")
    print(f"  买入信号：{buys} 次")
    print(f"  卖出信号：{sells} 次")
    print(f"  无信号（持有）：{total - buys - sells} 天")

    # 当前均线位置
    current_diff = ma20.iloc[-1] - ma50.iloc[-1]
    status = "快线在慢线上方（多头排列）" if current_diff > 0 else "快线在慢线下方（空头排列）"
    print(f"\n当前状态：{status}（MA20−MA50 = {current_diff:.2f}）")


if __name__ == "__main__":
    main()
