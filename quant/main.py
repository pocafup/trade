"""
Quant 风险服务 — FastAPI

监听 127.0.0.1:8000，不对公网开放。
前端通过 Next.js /api/risk 代理路由访问（鉴权在代理层做）。

启动方式：
  cd quant
  uvicorn main:app --host 127.0.0.1 --port 8000

端点
────
GET /            健康检查（快速）
GET /health      健康检查（快速）
GET /risk/portfolio
    数据源优先级：trade.db → my_portfolio.json（持仓 < 3 只时回退）
    返回字段：source / portfolio / assets / correlation / clusters
"""
from __future__ import annotations

import json
import math
import warnings
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException

from data.holdings import load_holdings
from risk import compute_portfolio_risk

# ── 配置 ──────────────────────────────────────────────────────────────────────

_QUANT_ROOT       = Path(__file__).parent
_JSON_PATH        = _QUANT_ROOT / "my_portfolio.json"
_DB_MIN_HOLDINGS  = 3        # trade.db 持仓少于此值 → 回退 JSON
_DEFAULT_LOOKBACK = "2y"
_DEFAULT_RF       = 0.045    # 年化无风险利率（近似联邦基金利率）

# 自定义集群（可扩展）
_CLUSTERS: dict[str, list[str]] = {
    "AI/半导体/高Beta": ["ARM", "MU", "TSLA", "NVDA", "PLTR"],
}

app = FastAPI(title="Quant Risk Service", version="0.2.0")


# ── 工具函数 ──────────────────────────────────────────────────────────────────

def _clean(x: Any) -> Any:
    """把 float NaN / ±Inf 转成 None（JSON null），其余原样返回。"""
    if isinstance(x, float) and (math.isnan(x) or math.isinf(x)):
        return None
    return x


def _load_source(user_id: int | None = None) -> tuple[dict[str, float], str, float, str, str, str]:
    """
    按优先级加载持仓。

    user_id 不为 None（多租户，前端 /api/risk 调用）：
      只读该账号自己的 trade.db 持仓，绝不回退到共享的 my_portfolio.json
      ——否则会把某个账号的演示持仓泄露给所有账号。该账号无持仓 → 503。

    user_id 为 None（脚本/单用户直连）：
      trade.db 合计持仓 ≥ 3 只 → 用 db；否则回退 my_portfolio.json。

    返回 (holdings, input_type, risk_free, lookback, source, source_detail)
      source = "db" | "json"
    """
    # ── 多租户：严格按账号隔离，不回退 JSON ──────────────────────────────────
    if user_id is not None:
        try:
            user_holdings = load_holdings(user_id=user_id)
        except FileNotFoundError:
            user_holdings = {}
        if not user_holdings:
            raise HTTPException(
                status_code=503,
                detail={
                    "error": "no_holdings",
                    "message": "该账号暂无持仓，请先在 trade 应用录入交易。",
                },
            )
        detail = f"trade.db（账号 #{user_id}，{len(user_holdings)} 只持仓）"
        return user_holdings, "shares", _DEFAULT_RF, _DEFAULT_LOOKBACK, "db", detail

    # ── 1. trade.db（合计，脚本/单用户）─────────────────────────────────────
    db_holdings: dict[str, float] = {}
    try:
        db_holdings = load_holdings()
    except FileNotFoundError:
        pass   # trade.db 不存在时静默回退

    if len(db_holdings) >= _DB_MIN_HOLDINGS:
        detail = f"trade.db（{len(db_holdings)} 只持仓）"
        return db_holdings, "shares", _DEFAULT_RF, _DEFAULT_LOOKBACK, "db", detail

    # ── 2. my_portfolio.json（回退）──────────────────────────────────────────
    if not _JSON_PATH.exists():
        raise HTTPException(
            status_code=503,
            detail={
                "error": "no_holdings_source",
                "message": (
                    f"trade.db 中只有 {len(db_holdings)} 只持仓（阈值 {_DB_MIN_HOLDINGS}），"
                    f"且 {_JSON_PATH.name} 不存在。"
                    "请在 trade 应用录入交易，或创建 quant/my_portfolio.json。"
                ),
            },
        )

    raw = json.loads(_JSON_PATH.read_text(encoding="utf-8"))
    json_holdings = {
        k: float(v) for k, v in raw.get("holdings", {}).items() if float(v) > 0
    }

    if not json_holdings:
        raise HTTPException(
            status_code=503,
            detail={
                "error": "empty_json_holdings",
                "message": f"{_JSON_PATH.name} 中所有持仓为 0，请填写真实持仓数据。",
            },
        )

    reason = (
        f"trade.db 持仓不足 {_DB_MIN_HOLDINGS} 只（当前 {len(db_holdings)} 只）"
        if db_holdings
        else "trade.db 不存在或无持仓"
    )
    detail = f"my_portfolio.json（{len(json_holdings)} 只持仓；回退原因：{reason}）"
    return (
        json_holdings,
        raw.get("input_type", "shares"),
        float(raw.get("risk_free", _DEFAULT_RF)),
        raw.get("lookback", _DEFAULT_LOOKBACK),
        "json",
        detail,
    )


def _cluster_stats(m, clusters: dict[str, list[str]]) -> dict:
    """计算各集群的集中度指标，返回可直接 JSON 序列化的 dict。"""
    result: dict = {}
    corr     = m.correlation
    all_syms = set(m.per_asset.keys())

    for name, members_raw in clusters.items():
        members = [s for s in members_raw if s in all_syms]
        if len(members) < 2:
            result[name] = {"error": "有效成员不足 2 只", "members": members}
            continue

        total_w  = sum(m.per_asset[s].weight            for s in members)
        total_rc = sum(m.per_asset[s].risk_contribution  for s in members)

        pairs = [
            {"s1": s1, "s2": s2, "rho": round(float(corr.loc[s1, s2]), 4)}
            for i, s1 in enumerate(members)
            for s2 in members[i + 1:]
        ]
        avg_rho  = sum(p["rho"] for p in pairs) / len(pairs)
        max_pair = max(pairs, key=lambda p: p["rho"])
        min_pair = min(pairs, key=lambda p: p["rho"])

        result[name] = {
            "members":                members,
            "total_weight":           round(total_w,  4),
            "total_risk_contribution": round(total_rc, 4),
            "rc_over_weight":         round(total_rc / total_w, 3) if total_w > 0 else None,
            "avg_correlation":        round(avg_rho,  4),
            "max_corr_pair":          {"symbols": [max_pair["s1"], max_pair["s2"]], "rho": max_pair["rho"]},
            "min_corr_pair":          {"symbols": [min_pair["s1"], min_pair["s2"]], "rho": min_pair["rho"]},
            "pairwise":               pairs,
        }

    return result


# ── 路由 ──────────────────────────────────────────────────────────────────────

@app.get("/")
def root():
    return {"service": "quant", "status": "ok"}


@app.get("/health")
def health():
    return {"status": "ok"}


@app.get("/risk/portfolio")
def portfolio_risk(user_id: int | None = None):
    """
    完整组合风险分析。

    参数
    ────
    user_id : 由前端 /api/risk 代理透传。传入 → 只分析该账号自己的持仓
              （多租户隔离，不回退共享 JSON）；省略 → 脚本/单用户模式，
              trade.db 合计持仓 ≥ 3 只用 db，否则回退 my_portfolio.json。

    价格统一由 data/prices.py 的 fetch()（Yahoo Finance，复权，SQLite 缓存）拉取。
    """
    holdings, input_type, risk_free, lookback, source, source_detail = _load_source(user_id)

    # warnings.catch_warnings 避免缺失标的的 warn 打印到日志
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        try:
            m = compute_portfolio_risk(
                holdings,
                lookback=lookback,
                input_type=input_type,
                risk_free=risk_free,
            )
        except ValueError as exc:
            raise HTTPException(status_code=503, detail={
                "error": "compute_failed",
                "message": str(exc),
            }) from exc

    # ── 单只资产序列化 ─────────────────────────────────────────────────────────
    assets = sorted(
        [
            {
                "symbol":            a.symbol,
                "weight":            round(a.weight, 4),
                "market_value":      round(a.market_value, 2),
                "vol":               _clean(round(a.vol,     4)),
                "max_dd":            _clean(round(a.max_dd,  4)),
                "beta":              _clean(round(a.beta,    3)),
                "sharpe":            _clean(round(a.sharpe,  3)),
                "sortino":           _clean(round(a.sortino, 3) if not math.isinf(a.sortino) else None),
                "var95":             _clean(round(a.var95,   4)),
                "cvar95":            _clean(round(a.cvar95,  4)),
                "risk_contribution": round(a.risk_contribution, 4),
                "risk_tier":         a.risk_tier,
            }
            for a in m.per_asset.values()
        ],
        key=lambda x: x["risk_contribution"],
        reverse=True,
    )

    # ── 相关性矩阵 DataFrame → {sym: {sym: float}} ─────────────────────────────
    corr_dict = {
        sym: {
            s2: round(float(m.correlation.loc[sym, s2]), 4)
            for s2 in m.correlation.columns
        }
        for sym in m.correlation.index
    }

    return {
        "source":        source,
        "source_detail": source_detail,
        "generated_at":  datetime.now(timezone.utc).isoformat(),
        "start_date":    m.start_date,
        "end_date":      m.end_date,
        "n_assets":      m.n_assets,
        "portfolio": {
            "total_value":             round(m.total_value,             2),
            "portfolio_vol":           round(m.portfolio_vol,           4),
            "weighted_avg_vol":        round(m.weighted_avg_vol,        4),
            "diversification_benefit": round(m.diversification_benefit, 4),
            "max_dd":                  round(m.max_dd,                  4),
            "beta":                    _clean(round(m.beta,   3)),
            "sharpe":                  _clean(round(m.sharpe, 3)),
            "var95":                   round(m.var95,  4),
            "cvar95":                  round(m.cvar95, 4),
        },
        "assets":      assets,
        "correlation": corr_dict,
        "clusters":    _cluster_stats(m, _CLUSTERS),
    }


# ── 直接执行入口 ───────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=8000, reload=False)
