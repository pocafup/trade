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

import os
import sqlite3
from pathlib import Path

# 优先读环境变量 DB_PATH（Docker 部署时注入），否则按本地相对路径推断
_DEFAULT_DB = (
    Path(os.environ["DB_PATH"])
    if os.environ.get("DB_PATH")
    else Path(__file__).parent.parent.parent / "data" / "trade.db"
)

# 浮点残值过滤阈值：净持股低于此值视为已清仓
_MIN_SHARES = 1e-9

# 全账号合计（脚本/单用户场景）。参数：(_MIN_SHARES,)
_SQL_ALL = """
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

# 单账号隔离（多租户场景）。WHERE user_id 过滤放在内层聚合前，
# 确保只统计该用户的买卖。参数：(user_id, _MIN_SHARES)
_SQL_BY_USER = """
SELECT ticker, net_shares
FROM (
    SELECT
        ticker,
        SUM(CASE WHEN type = 'buy'  THEN quantity ELSE 0.0 END) -
        SUM(CASE WHEN type = 'sell' THEN quantity ELSE 0.0 END) AS net_shares
    FROM transactions
    WHERE user_id = ?
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


def load_holdings(
    db_path: Path | str | None = None,
    user_id: int | None = None,
) -> dict[str, float]:
    """
    读取 trade.db 中的当前净持仓。

    参数
    ────
    db_path : trade.db 的路径。None → 使用默认路径（../data/trade.db）。
    user_id : 账号隔离。None → 合计所有账号（脚本/单用户场景）；
              传入整数 → 只统计该 user_id 的买卖（多租户隔离）。

    返回
    ────
    {ticker: net_shares}
      - 键为大写股票代码，值为净持股数（浮点，保留小数股精度）
      - 已清仓或净持股极小（< 1e-9）的标的不会出现在结果里
      - 若 transactions 表为空（或该用户无持仓），返回空字典

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

    if user_id is None:
        sql, params = _SQL_ALL, (_MIN_SHARES,)
    else:
        sql, params = _SQL_BY_USER, (user_id, _MIN_SHARES)

    uri = _db_uri(path)
    con = sqlite3.connect(uri, uri=True)
    try:
        rows = con.execute(sql, params).fetchall()
    finally:
        con.close()

    return {ticker: float(shares) for ticker, shares in rows}
