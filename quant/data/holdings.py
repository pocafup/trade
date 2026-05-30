"""
从 trade.db 读取当前净持仓。

只读：以 SQLite URI mode=ro 连接，杜绝任何写入操作。
输出：{ticker: net_shares}，可直接传给
      compute_portfolio_risk(holdings, input_type="shares")。
价格不在此处获取——由 data/prices.py 的 fetch() 统一拉取。

净持股计算：
  net_shares = Σ buy_qty  −  Σ sell_qty  （按 ticker 分组）

  只保留 net_shares > _MIN_SHARES 的行，过滤掉因浮点精度产生的
  极小残值（如 10.0 买入、9.9999999999 卖出后余 1e-10 股）。
  保留小数股精度（REAL 列），支持小数股券商。
"""
from __future__ import annotations

import sqlite3
from pathlib import Path

# trade.db 默认位置：quant/data/holdings.py → ../../../data/trade.db
_DEFAULT_DB = Path(__file__).parent.parent.parent / "data" / "trade.db"

# 浮点残值过滤阈值：净持股低于此值视为已清仓
_MIN_SHARES = 1e-9

_SQL = """
SELECT ticker, net_shares
FROM (
    SELECT
        ticker,
        SUM(CASE WHEN type = 'buy'  THEN quantity ELSE 0.0 END) -
        SUM(CASE WHEN type = 'sell' THEN quantity ELSE 0.0 END) AS net_shares
    FROM transactions
    GROUP BY ticker
)
WHERE net_shares > ?
ORDER BY ticker
"""


def _db_uri(path: Path) -> str:
    """
    把文件路径转成 SQLite URI（只读模式）。

    SQLite URI 格式：file:///驱动:/路径?mode=ro
    Windows 路径反斜线须转正斜线；as_posix() 完成这一步。
    """
    return f"file:///{path.resolve().as_posix()}?mode=ro"


def load_holdings(db_path: Path | str | None = None) -> dict[str, float]:
    """
    读取 trade.db 中的当前净持仓。

    参数
    ────
    db_path : trade.db 的路径。None → 使用默认路径（../data/trade.db）。

    返回
    ────
    {ticker: net_shares}
      - 键为大写股票代码，值为净持股数（浮点，保留小数股精度）
      - 已清仓或净持股极小（< 1e-9）的标的不会出现在结果里
      - 若 transactions 表为空，返回空字典

    异常
    ────
    FileNotFoundError : db_path 指向的文件不存在
    sqlite3.OperationalError : 尝试写入时（因 mode=ro 会立刻报错）
    """
    path = Path(db_path) if db_path is not None else _DEFAULT_DB

    if not path.exists():
        raise FileNotFoundError(
            f"trade.db 不存在：{path}\n"
            "请确认 trade 应用已运行过并初始化了数据库。"
        )

    uri = _db_uri(path)
    con = sqlite3.connect(uri, uri=True)
    try:
        rows = con.execute(_SQL, (_MIN_SHARES,)).fetchall()
    finally:
        con.close()

    return {ticker: float(shares) for ticker, shares in rows}
