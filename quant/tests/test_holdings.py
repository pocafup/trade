"""
Unit tests for data.holdings.load_holdings().

使用 tmp_path 隔离每个测试的 SQLite 数据库，不触碰真实 trade.db。
测试覆盖：
  - 空表返回空字典
  - 纯买入
  - 买入后部分卖出 → 净持股 = 买入 − 卖出
  - 买卖数量相等 → 清仓，不出现在结果里
  - 小数股（fractional shares）精度保留
  - 多只股票互不干扰
  - 浮点残值过滤（buy 10.0, sell 10 - ε → 视为清仓）
  - 只读模式：对同一文件发起 INSERT 时应抛出 OperationalError
  - 文件不存在时抛出 FileNotFoundError
  - 多租户：user_id 过滤使两个账号的持仓互不串账
  - user_id=None 时合计所有账号（向后兼容脚本/单用户）
"""
from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest

from data.holdings import _MIN_SHARES, load_holdings

# ── 建表 SQL（与 trade 应用的 db.ts 保持一致）────────────────────────────────

_CREATE = """
CREATE TABLE transactions (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    ticker     TEXT    NOT NULL,
    name       TEXT    NOT NULL DEFAULT '',
    type       TEXT    NOT NULL CHECK(type IN ('buy', 'sell')),
    quantity   REAL    NOT NULL CHECK(quantity > 0),
    price      REAL    NOT NULL CHECK(price >= 0),
    date       TEXT    NOT NULL,
    notes      TEXT    DEFAULT '',
    user_id    INTEGER
)
"""

_INSERT = """
INSERT INTO transactions (ticker, name, type, quantity, price, date, user_id)
VALUES (?, ?, ?, ?, ?, '2024-01-01', ?)
"""


# ── 测试用 DB 工具 ──────────────────────────────────────────────────────────

def _make_db(tmp_path: Path, rows: list[tuple], user_id: int = 1) -> Path:
    """
    在 tmp_path 下创建一个 SQLite，建好 transactions 表，插入 rows。

    rows 格式：(ticker, name, type, quantity, price) —— 全部归属同一个 user_id（默认 1）。
    """
    db = tmp_path / "trade.db"
    con = sqlite3.connect(db)
    con.execute(_CREATE)
    con.executemany(_INSERT, [(*r, user_id) for r in rows])
    con.commit()
    con.close()
    return db


def _make_db_multi(tmp_path: Path, rows: list[tuple]) -> Path:
    """
    多账号版本：每行显式带 user_id，用于验证账号隔离。

    rows 格式：(ticker, name, type, quantity, price, user_id)
    """
    db = tmp_path / "trade.db"
    con = sqlite3.connect(db)
    con.execute(_CREATE)
    con.executemany(_INSERT, rows)
    con.commit()
    con.close()
    return db


# ── 测试用例 ────────────────────────────────────────────────────────────────

def test_empty_table_returns_empty_dict(tmp_path):
    """transactions 表为空 → 返回 {}"""
    db = _make_db(tmp_path, [])
    assert load_holdings(db) == {}


def test_single_buy(tmp_path):
    """单笔买入 → 净持股 = 买入量"""
    db = _make_db(tmp_path, [("AAPL", "Apple", "buy", 10.0, 150.0)])
    result = load_holdings(db)
    assert set(result) == {"AAPL"}
    assert result["AAPL"] == pytest.approx(10.0)


def test_buy_then_partial_sell(tmp_path):
    """买入 10 股，卖出 3 股 → 净持股 7"""
    db = _make_db(tmp_path, [
        ("AAPL", "Apple", "buy",  10.0, 150.0),
        ("AAPL", "Apple", "sell",  3.0, 160.0),
    ])
    result = load_holdings(db)
    assert result["AAPL"] == pytest.approx(7.0)


def test_fully_sold_position_excluded(tmp_path):
    """买入 10 股，全部卖出 → 不出现在结果里"""
    db = _make_db(tmp_path, [
        ("TSLA", "Tesla", "buy",  10.0, 200.0),
        ("TSLA", "Tesla", "sell", 10.0, 220.0),
    ])
    assert load_holdings(db) == {}


def test_fractional_shares_preserved(tmp_path):
    """小数股精度不丢失（0.547789 股应原样保留）"""
    db = _make_db(tmp_path, [("MU", "Micron", "buy", 0.547789, 100.0)])
    result = load_holdings(db)
    assert result["MU"] == pytest.approx(0.547789, rel=1e-9)


def test_multiple_buys_accumulate(tmp_path):
    """多笔买入同一标的 → 合计持股"""
    db = _make_db(tmp_path, [
        ("NVDA", "Nvidia", "buy", 5.0, 400.0),
        ("NVDA", "Nvidia", "buy", 3.5, 420.0),
    ])
    result = load_holdings(db)
    assert result["NVDA"] == pytest.approx(8.5)


def test_multiple_tickers_isolated(tmp_path):
    """不同股票互不干扰"""
    db = _make_db(tmp_path, [
        ("AAPL", "Apple",  "buy",  10.0, 150.0),
        ("MSFT", "MS",     "buy",   5.0, 300.0),
        ("AAPL", "Apple",  "sell",  2.0, 160.0),
        ("MSFT", "MS",     "sell",  5.0, 310.0),  # MSFT 清仓
    ])
    result = load_holdings(db)
    assert set(result) == {"AAPL"}
    assert result["AAPL"] == pytest.approx(8.0)


def test_floating_point_residual_filtered(tmp_path):
    """
    buy 10.0, sell (10.0 - ε)，ε < _MIN_SHARES。
    净持股 ≈ ε，应被过滤，视为已清仓。
    """
    epsilon = _MIN_SHARES / 10          # 远小于阈值
    sell_qty = 10.0 - epsilon           # 卖出量略小于买入量
    db = _make_db(tmp_path, [
        ("BB", "BlackBerry", "buy",  10.0,     5.0),
        ("BB", "BlackBerry", "sell", sell_qty, 5.0),
    ])
    assert load_holdings(db) == {}


def test_threshold_boundary_included(tmp_path):
    """净持股恰好大于阈值（_MIN_SHARES * 2）→ 应出现在结果里"""
    above = _MIN_SHARES * 2
    sell_qty = 10.0 - above
    db = _make_db(tmp_path, [
        ("ARM", "Arm", "buy",  10.0,     60.0),
        ("ARM", "Arm", "sell", sell_qty, 61.0),
    ])
    result = load_holdings(db)
    assert "ARM" in result
    assert result["ARM"] == pytest.approx(above, rel=1e-6)


def test_read_only_rejects_write(tmp_path):
    """
    只读连接对同一 trade.db 发起 INSERT 时，
    SQLite 应立即抛出 OperationalError（attempt to write a readonly database）。
    """
    db = _make_db(tmp_path, [("AAPL", "Apple", "buy", 1.0, 100.0)])

    # 用相同路径以只读 URI 重新连接
    uri = f"file:///{db.resolve().as_posix()}?mode=ro"
    con = sqlite3.connect(uri, uri=True)
    with pytest.raises(sqlite3.OperationalError, match="readonly"):
        con.execute(
            "INSERT INTO transactions (ticker, name, type, quantity, price, date) "
            "VALUES ('X', '', 'buy', 1.0, 1.0, '2024-01-01')"
        )
    con.close()


def test_file_not_found_raises(tmp_path):
    """指向不存在文件时抛出 FileNotFoundError"""
    with pytest.raises(FileNotFoundError):
        load_holdings(tmp_path / "nonexistent.db")


def test_returns_float_values(tmp_path):
    """返回值必须是 float，不是 int 或 Decimal"""
    db = _make_db(tmp_path, [("JPM", "JPMorgan", "buy", 3, 200.0)])
    result = load_holdings(db)
    assert isinstance(result["JPM"], float)


def test_result_sorted_by_ticker(tmp_path):
    """
    返回字典的键在 Python 3.7+ 中按插入顺序，
    此处验证 SQL ORDER BY ticker 后以字母序读回。
    """
    db = _make_db(tmp_path, [
        ("TSLA", "Tesla",  "buy", 1.0, 200.0),
        ("AAPL", "Apple",  "buy", 2.0, 150.0),
        ("MSFT", "MS",     "buy", 3.0, 300.0),
    ])
    result = load_holdings(db)
    assert list(result.keys()) == sorted(result.keys())


def test_real_portfolio_scenario(tmp_path):
    """
    模拟真实场景：ARM 多笔买入、MU 部分卖出、WOOF 清仓。
    """
    db = _make_db(tmp_path, [
        ("ARM",  "Arm",        "buy",   100.0, 60.0),
        ("ARM",  "Arm",        "buy",    42.0, 65.0),
        ("MU",   "Micron",     "buy",    50.0, 90.0),
        ("MU",   "Micron",     "sell",    4.5, 95.0),
        ("WOOF", "Petco",      "buy",  1000.0,  3.0),
        ("WOOF", "Petco",      "sell", 1000.0,  3.5),  # 清仓
    ])
    result = load_holdings(db)
    assert set(result) == {"ARM", "MU"}
    assert result["ARM"]  == pytest.approx(142.0)
    assert result["MU"]   == pytest.approx(45.5)


# ── 多租户隔离 ──────────────────────────────────────────────────────────────

def test_user_id_isolation(tmp_path):
    """同一个 trade.db 里，两个账号的持仓互不串账。"""
    db = _make_db_multi(tmp_path, [
        ("AAPL", "Apple", "buy", 10.0, 150.0, 1),
        ("MSFT", "MS",    "buy",  5.0, 300.0, 1),
        ("TSLA", "Tesla", "buy",  7.0, 200.0, 2),
        ("AAPL", "Apple", "buy",  3.0, 155.0, 2),  # 账号2 也持有 AAPL，但份额独立
    ])
    u1 = load_holdings(db, user_id=1)
    u2 = load_holdings(db, user_id=2)

    assert set(u1) == {"AAPL", "MSFT"}
    assert u1["AAPL"] == pytest.approx(10.0)        # 只含账号1的 10 股

    assert set(u2) == {"TSLA", "AAPL"}
    assert u2["AAPL"] == pytest.approx(3.0)         # 只含账号2的 3 股，不混入账号1


def test_user_id_none_aggregates_all(tmp_path):
    """user_id=None → 合计所有账号（脚本/单用户向后兼容）。"""
    db = _make_db_multi(tmp_path, [
        ("AAPL", "Apple", "buy", 10.0, 150.0, 1),
        ("AAPL", "Apple", "buy",  3.0, 155.0, 2),
    ])
    allh = load_holdings(db)                          # 不传 user_id
    assert allh["AAPL"] == pytest.approx(13.0)        # 10 + 3 合计


def test_user_id_with_no_holdings_returns_empty(tmp_path):
    """查询一个没有任何交易的账号 → 空字典（不泄露其他账号持仓）。"""
    db = _make_db_multi(tmp_path, [
        ("AAPL", "Apple", "buy", 10.0, 150.0, 1),
    ])
    assert load_holdings(db, user_id=999) == {}
