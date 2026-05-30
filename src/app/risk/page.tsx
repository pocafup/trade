'use client';

import { useState, useEffect, useCallback, Fragment } from 'react';
import { useRouter } from 'next/navigation';
import {
  ArrowLeft, RefreshCw, ShieldAlert, AlertTriangle,
  Database, FileJson,
} from 'lucide-react';

// ── Types ──────────────────────────────────────────────────────────────────────

interface Portfolio {
  total_value: number;
  portfolio_vol: number;
  weighted_avg_vol: number;
  diversification_benefit: number;
  max_dd: number;
  beta: number | null;
  sharpe: number | null;
  var95: number;
  cvar95: number;
}

interface Asset {
  symbol: string;
  weight: number;
  market_value: number;
  vol: number | null;
  max_dd: number | null;
  beta: number | null;
  sharpe: number | null;
  sortino: number | null;
  var95: number | null;
  cvar95: number | null;
  risk_contribution: number;
  risk_tier: '高' | '中' | '低';
}

interface ClusterData {
  members: string[];
  total_weight: number;
  total_risk_contribution: number;
  rc_over_weight: number | null;
  avg_correlation: number;
  max_corr_pair: { symbols: [string, string]; rho: number };
  min_corr_pair: { symbols: [string, string]; rho: number };
  pairwise: { s1: string; s2: string; rho: number }[];
  error?: string;
}

interface RiskData {
  source: 'db' | 'json';
  source_detail: string;
  generated_at: string;
  start_date: string;
  end_date: string;
  n_assets: number;
  portfolio: Portfolio;
  assets: Asset[];
  correlation: Record<string, Record<string, number>>;
  clusters: Record<string, ClusterData>;
}

// ── Formatters ─────────────────────────────────────────────────────────────────

function pct(v: number | null | undefined, d = 1): string {
  if (v == null) return '—';
  const x = v * 100;
  return `${x >= 0 ? '+' : ''}${x.toFixed(d)}%`;
}
function n2(v: number | null | undefined): string {
  if (v == null) return '—';
  return v.toFixed(2);
}
// Blue (positive ρ) → deeper = stronger correlation; amber for negative
function corrColor(rho: number): string {
  const t = Math.max(-1, Math.min(1, rho));
  if (t >= 0) return `rgba(79,142,247,${(t * 0.88).toFixed(2)})`;
  return `rgba(251,146,60,${(Math.abs(t) * 0.88).toFixed(2)})`;
}

// ── Source badge ───────────────────────────────────────────────────────────────

function SourceBadge({ source, detail }: { source: 'db' | 'json'; detail: string }) {
  return (
    <div
      title={detail}
      className={`flex items-center gap-1.5 px-2 py-0.5 rounded-md text-[10px] font-medium border ${
        source === 'db'
          ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30'
          : 'bg-amber-500/10  text-amber-400  border-amber-500/30'
      }`}
    >
      {source === 'db' ? <Database size={10} /> : <FileJson size={10} />}
      {source === 'db' ? '账本数据' : '备份 JSON'}
    </div>
  );
}

// ── Loading skeleton ───────────────────────────────────────────────────────────

function Skeleton() {
  return (
    <div className="space-y-4 animate-pulse">
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        {[...Array(6)].map((_, i) => (
          <div key={i} className="h-[84px] rounded-2xl bg-[#0F1520] border border-[#1E2D42]" />
        ))}
      </div>
      <div className="h-20 rounded-2xl bg-[#0F1520] border border-[#1E2D42]" />
      <div className="h-64 rounded-2xl bg-[#0F1520] border border-[#1E2D42]" />
      <div className="h-48 rounded-2xl bg-[#0F1520] border border-[#1E2D42]" />
      <p className="text-[11px] text-[#3A4E6A] text-center pt-1">
        正在从 Yahoo Finance 拉取价格数据，首次加载约需 30–60 秒…
      </p>
    </div>
  );
}

// ── Error panel ────────────────────────────────────────────────────────────────

function ErrorPanel({ err }: { err: Record<string, unknown> }) {
  const isDown = err.error === 'quant_unavailable';
  const msg =
    typeof err.message === 'string'
      ? err.message
      : typeof err.detail === 'object' && err.detail !== null
      ? String((err.detail as Record<string, unknown>).message ?? '')
      : typeof err.detail === 'string'
      ? err.detail
      : '未知错误';

  return (
    <div className="rounded-2xl bg-rose-950/30 border border-rose-500/30 p-6 space-y-4">
      <div className="flex items-center gap-2">
        <AlertTriangle size={15} className="text-rose-400 shrink-0" />
        <p className="text-sm font-semibold text-rose-300">
          {isDown ? 'quant 风险服务未启动' : '获取风险数据失败'}
        </p>
      </div>
      <p className="text-sm text-rose-200/70 leading-relaxed">{msg}</p>
      {isDown && (
        <div className="bg-[#0A0F18] rounded-xl p-4 border border-[#1E2D42]">
          <p className="text-[11px] text-[#6B7E9C] mb-2">在服务器终端执行以下命令：</p>
          <code className="text-xs font-mono text-[#4F8EF7] break-all">
            cd quant && python -m uvicorn main:app --host 127.0.0.1 --port 8000
          </code>
        </div>
      )}
    </div>
  );
}

// ── Overview cards ─────────────────────────────────────────────────────────────

function OverviewCards({ p }: { p: Portfolio }) {
  const cards = [
    {
      label: '年化波动率',
      value: pct(p.portfolio_vol),
      sub: `协方差法（分散化后）`,
      color: p.portfolio_vol > 0.3 ? 'text-rose-400' : p.portfolio_vol > 0.2 ? 'text-amber-400' : 'text-emerald-400',
    },
    {
      label: '最大回撤',
      value: pct(p.max_dd),
      sub: '历史峰谷最大跌幅',
      color: Math.abs(p.max_dd) > 0.3 ? 'text-rose-400' : 'text-[#E8EDFB]',
    },
    {
      label: 'Beta vs SPY',
      value: n2(p.beta),
      sub: '市场跌 1% → 组合跌 x%',
      color: (p.beta ?? 0) > 1.3 ? 'text-rose-400' : (p.beta ?? 0) > 1.1 ? 'text-amber-400' : 'text-[#E8EDFB]',
    },
    {
      label: '年化夏普比率',
      value: n2(p.sharpe),
      sub: '每单位波动的超额收益',
      color: (p.sharpe ?? 0) > 1 ? 'text-emerald-400' : (p.sharpe ?? 0) > 0 ? 'text-[#E8EDFB]' : 'text-rose-400',
    },
    {
      label: '1日 VaR 95%',
      value: pct(p.var95),
      sub: '95% 日损失不超过此值',
      color: 'text-[#E8EDFB]',
    },
    {
      label: '1日 CVaR 95%',
      value: pct(p.cvar95),
      sub: '最坏 5% 情形的平均损失',
      color: Math.abs(p.cvar95) > 0.04 ? 'text-rose-400' : 'text-[#E8EDFB]',
    },
  ];

  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
      {cards.map(c => (
        <div key={c.label} className="bg-[#0F1520] border border-[#1E2D42] rounded-2xl p-4">
          <p className="text-[10px] text-[#6B7E9C] uppercase tracking-wider mb-2">{c.label}</p>
          <p className={`text-2xl font-bold font-mono tracking-tight ${c.color}`}>{c.value}</p>
          <p className="text-[10px] text-[#3A4E6A] mt-1 leading-snug">{c.sub}</p>
        </div>
      ))}
    </div>
  );
}

// ── Diversification strip ──────────────────────────────────────────────────────

function DiversificationStrip({ p }: { p: Portfolio }) {
  const efficiencyPct = p.weighted_avg_vol > 0
    ? (p.diversification_benefit / p.weighted_avg_vol * 100).toFixed(0)
    : '0';

  return (
    <div className="bg-[#0F1520] border border-[#1E2D42] rounded-2xl p-4">
      <p className="text-[10px] text-[#6B7E9C] uppercase tracking-wider mb-3">分散化分析</p>
      <div className="flex items-center gap-3 flex-wrap">
        <div className="text-center">
          <p className="text-[10px] text-[#3A4E6A] mb-1">假设全部同向（上界）</p>
          <p className="font-mono font-semibold text-[#8B9CC0]">{pct(p.weighted_avg_vol)}</p>
        </div>
        <div className="text-[#2A3A54] text-xl flex-1 text-center hidden sm:block">→</div>
        <div className="text-center">
          <p className="text-[10px] text-[#3A4E6A] mb-1">实际波动率（协方差法）</p>
          <p className="font-mono font-semibold text-[#4F8EF7]">{pct(p.portfolio_vol)}</p>
        </div>
        <div className="ml-auto text-right sm:border-l sm:border-[#1E2D42] sm:pl-4">
          <p className="text-[10px] text-[#3A4E6A] mb-1">分散化节省 / 效率</p>
          <p className="font-mono font-bold text-emerald-400 text-xl">{pct(p.diversification_benefit)}</p>
          <p className="text-[10px] text-[#3A4E6A]">{efficiencyPct}% 的波动被分散掉</p>
        </div>
      </div>
    </div>
  );
}

// ── Risk table ─────────────────────────────────────────────────────────────────

function RiskTable({ assets }: { assets: Asset[] }) {
  return (
    <div className="bg-[#0F1520] border border-[#1E2D42] rounded-2xl overflow-hidden">
      <div className="px-4 py-3 border-b border-[#1E2D42]">
        <p className="text-[10px] font-medium text-[#6B7E9C] uppercase tracking-wider">
          单只风险明细 · 按风险贡献降序
        </p>
        <p className="text-[10px] text-[#3A4E6A] mt-0.5">
          橙色高亮行 = 风险贡献 / 市值权重 &gt; 1.2（此持仓承担了超出其市值比例的风险）
        </p>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[560px]">
          <thead>
            <tr className="border-b border-[#1E2D42]">
              {['代码', '市值权重', '风险贡献', 'RC / W', '年化波动', '最大回撤', '风险档'].map(h => (
                <th
                  key={h}
                  className="px-3 py-2.5 text-left text-[10px] font-medium text-[#6B7E9C] uppercase tracking-wider whitespace-nowrap first:pl-4 last:pr-4"
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {assets.map(a => {
              const rcw = a.weight > 0 ? a.risk_contribution / a.weight : 0;
              const over = rcw > 1.2;
              return (
                <tr
                  key={a.symbol}
                  className={`border-b border-[#1E2D42] last:border-0 transition-colors ${
                    over ? 'bg-amber-500/5 hover:bg-amber-500/10' : 'hover:bg-[#141C2C]'
                  }`}
                >
                  <td className="pl-4 pr-3 py-3">
                    <div className="flex items-center gap-2">
                      <span className="font-mono font-bold text-[#4F8EF7]">{a.symbol}</span>
                      {over && (
                        <span className="text-[9px] px-1 py-px rounded bg-amber-500/15 text-amber-400 border border-amber-500/30 font-medium">
                          超配
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="px-3 py-3 font-mono text-[#8B9CC0] text-sm">{pct(a.weight)}</td>
                  <td className="px-3 py-3 font-mono font-semibold text-[#E8EDFB] text-sm">{pct(a.risk_contribution)}</td>
                  <td className={`px-3 py-3 font-mono font-semibold text-sm ${over ? 'text-amber-400' : 'text-[#6B7E9C]'}`}>
                    {rcw.toFixed(1)}x
                  </td>
                  <td className={`px-3 py-3 font-mono text-sm ${
                    (a.vol ?? 0) > 0.4 ? 'text-rose-400' : (a.vol ?? 0) > 0.2 ? 'text-amber-400' : 'text-[#8B9CC0]'
                  }`}>
                    {pct(a.vol)}
                  </td>
                  <td className={`px-3 py-3 font-mono text-sm ${
                    Math.abs(a.max_dd ?? 0) > 0.4 ? 'text-rose-400' : 'text-[#8B9CC0]'
                  }`}>
                    {pct(a.max_dd)}
                  </td>
                  <td className={`pr-4 px-3 py-3 text-xs font-semibold ${
                    a.risk_tier === '高' ? 'text-rose-400' : a.risk_tier === '中' ? 'text-amber-400' : 'text-emerald-400'
                  }`}>
                    {a.risk_tier}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── Correlation heatmap ────────────────────────────────────────────────────────

function CorrelationHeatmap({ corr }: { corr: Record<string, Record<string, number>> }) {
  const syms = Object.keys(corr);
  const CELL = 44;
  const LABEL_W = 52;
  const GAP = 2;

  // Build flat cell array for CSS grid (avoids Fragment key issue)
  const cells: React.ReactNode[] = [];

  // Corner + column headers
  cells.push(<div key="corner" />);
  syms.forEach(s =>
    cells.push(
      <div key={`ch-${s}`} className="flex items-end justify-center pb-1" style={{ height: 56 }}>
        <span
          className="text-[9px] font-mono text-[#6B7E9C]"
          style={{ writingMode: 'vertical-rl', transform: 'rotate(180deg)' }}
        >
          {s}
        </span>
      </div>,
    ),
  );

  // Data rows
  syms.forEach(row =>
    [
      // Row label
      <div key={`rl-${row}`} className="flex items-center justify-end pr-2">
        <span className="text-[9px] font-mono text-[#6B7E9C]">{row}</span>
      </div>,
      // Cells
      ...syms.map(col => {
        const rho = corr[row]?.[col] ?? 0;
        const isDiag = row === col;
        return (
          <div
            key={`${row}-${col}`}
            title={isDiag ? row : `${row}–${col}: ${rho.toFixed(3)}`}
            style={{
              width: CELL,
              height: CELL,
              backgroundColor: isDiag ? '#1A2640' : corrColor(rho),
              borderRadius: 4,
            }}
            className="flex items-center justify-center"
          >
            <span className="text-[9px] font-mono text-white/75 select-none">
              {isDiag ? '—' : rho.toFixed(2)}
            </span>
          </div>
        );
      }),
    ].forEach(el => cells.push(el)),
  );

  return (
    <div className="bg-[#0F1520] border border-[#1E2D42] rounded-2xl overflow-hidden">
      <div className="px-4 py-3 border-b border-[#1E2D42]">
        <p className="text-[10px] font-medium text-[#6B7E9C] uppercase tracking-wider">
          相关系数矩阵
        </p>
        <p className="text-[10px] text-[#3A4E6A] mt-0.5">
          蓝色越深 = 相关性越高（同涨同跌） · 橙色 = 负相关（对冲效果）
        </p>
      </div>
      <div className="overflow-x-auto p-4">
        <div
          style={{
            display: 'inline-grid',
            gridTemplateColumns: `${LABEL_W}px repeat(${syms.length}, ${CELL}px)`,
            gap: GAP,
          }}
        >
          {cells}
        </div>
      </div>
      {/* Legend */}
      <div className="px-4 pb-4 flex items-center gap-2">
        <span className="text-[10px] text-[#3A4E6A]">ρ = 0</span>
        <div className="flex gap-px rounded overflow-hidden">
          {[0, 0.25, 0.5, 0.75, 1.0].map(v => (
            <div
              key={v}
              style={{ width: 24, height: 10, backgroundColor: corrColor(v) }}
            />
          ))}
        </div>
        <span className="text-[10px] text-[#3A4E6A]">ρ = 1</span>
        <span className="ml-3 text-[10px] text-[#3A4E6A]">·</span>
        <div
          style={{ width: 24, height: 10, backgroundColor: corrColor(-0.3), borderRadius: 2 }}
        />
        <span className="text-[10px] text-[#3A4E6A]">负相关（橙）</span>
      </div>
    </div>
  );
}

// ── Cluster card ───────────────────────────────────────────────────────────────

function ClusterCard({ name, c }: { name: string; c: ClusterData }) {
  if (c.error) {
    return (
      <div className="bg-[#0F1520] border border-[#1E2D42] rounded-2xl p-4">
        <p className="text-xs text-[#3A4E6A]">{c.error}</p>
      </div>
    );
  }

  const isHigh = c.avg_correlation >= 0.5;
  const isMed  = c.avg_correlation >= 0.35;
  const rcAboveW = (c.rc_over_weight ?? 0) > 1.2;

  return (
    <div className={`bg-[#0F1520] rounded-2xl overflow-hidden border ${
      isHigh || rcAboveW ? 'border-amber-500/40' : 'border-[#1E2D42]'
    }`}>
      {/* Header */}
      <div className={`px-4 py-3 border-b ${
        isHigh || rcAboveW ? 'border-amber-500/20 bg-amber-500/5' : 'border-[#1E2D42]'
      }`}>
        <div className="flex items-center gap-2">
          {(isHigh || rcAboveW) && <AlertTriangle size={11} className="text-amber-400 shrink-0" />}
          <p className="text-xs font-semibold text-[#E8EDFB]">{name}</p>
        </div>
        <p className="text-[10px] text-[#3A4E6A] mt-0.5">{c.members.join(' · ')}</p>
      </div>

      {/* Stats row */}
      <div className="px-4 py-3 grid grid-cols-2 sm:grid-cols-4 gap-4 border-b border-[#1E2D42]">
        <div>
          <p className="text-[10px] text-[#3A4E6A] mb-1">合计市值权重</p>
          <p className="font-mono font-semibold text-[#E8EDFB] text-sm">{pct(c.total_weight)}</p>
        </div>
        <div>
          <p className="text-[10px] text-[#3A4E6A] mb-1">合计风险贡献</p>
          <p className={`font-mono font-semibold text-sm ${
            c.total_risk_contribution > c.total_weight + 0.05 ? 'text-amber-400' : 'text-[#E8EDFB]'
          }`}>{pct(c.total_risk_contribution)}</p>
        </div>
        <div>
          <p className="text-[10px] text-[#3A4E6A] mb-1">RC / 权重</p>
          <p className={`font-mono font-semibold text-sm ${rcAboveW ? 'text-amber-400' : 'text-[#E8EDFB]'}`}>
            {c.rc_over_weight?.toFixed(2) ?? '—'}x
          </p>
        </div>
        <div>
          <p className="text-[10px] text-[#3A4E6A] mb-1">集群内平均 ρ</p>
          <p className={`font-mono font-semibold text-sm ${
            isHigh ? 'text-rose-400' : isMed ? 'text-amber-400' : 'text-[#E8EDFB]'
          }`}>{c.avg_correlation.toFixed(3)}</p>
        </div>
      </div>

      {/* Pairwise correlation pills */}
      <div className="px-4 py-3">
        <p className="text-[10px] text-[#3A4E6A] mb-2">两两相关系数</p>
        <div className="flex flex-wrap gap-1.5">
          {c.pairwise.map(pair => (
            <span
              key={`${pair.s1}-${pair.s2}`}
              className={`text-[10px] font-mono px-2 py-px rounded border ${
                pair.rho >= 0.5
                  ? 'bg-[#4F8EF7]/15 text-[#4F8EF7] border-[#4F8EF7]/30'
                  : 'bg-[#141C2C] text-[#6B7E9C] border-[#1E2D42]'
              }`}
            >
              {pair.s1}–{pair.s2}: {pair.rho.toFixed(2)}
            </span>
          ))}
        </div>
        <p className="text-[10px] text-[#3A4E6A] mt-3 leading-relaxed">
          {isHigh
            ? `平均 ρ = ${c.avg_correlation.toFixed(2)}，中等偏高相关 — 遇系统性风险，这 ${c.members.length} 只大体会同步下跌，构成隐性集中押注。`
            : isMed
            ? `平均 ρ = ${c.avg_correlation.toFixed(2)}，中等相关 — 存在共同风险因子，不完全独立。`
            : `平均 ρ = ${c.avg_correlation.toFixed(2)}，相关性较低，集群内隐性集中度有限。`}
          {rcAboveW &&
            ` 风险贡献（${pct(c.total_risk_contribution)}）显著高于市值权重（${pct(c.total_weight)}），集中度被进一步放大。`}
        </p>
      </div>
    </div>
  );
}

// ── Main page ──────────────────────────────────────────────────────────────────

export default function RiskPage() {
  const router = useRouter();
  const [data, setData]             = useState<RiskData | null>(null);
  const [loading, setLoading]       = useState(true);
  const [err, setErr]               = useState<Record<string, unknown> | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const res  = await fetch('/api/risk');
      const json = await res.json() as Record<string, unknown>;
      if (!res.ok) { setErr(json); return; }
      setData(json as unknown as RiskData);
      setLastUpdated(new Date());
    } catch {
      setErr({
        error:   'quant_unavailable',
        message: 'quant 服务未启动或无法连接。请在服务器上执行：cd quant && python -m uvicorn main:app --host 127.0.0.1 --port 8000',
      });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  return (
    <div className="min-h-screen bg-[#080B14]">
      {/* Header */}
      <header className="sticky top-0 z-30 bg-[#080B14]/90 backdrop-blur border-b border-[#1E2D42]">
        <div className="max-w-5xl mx-auto px-4 h-14 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <button
              onClick={() => router.push('/')}
              className="p-1.5 rounded-lg hover:bg-[#172033] text-[#6B7E9C] hover:text-[#E8EDFB] transition-colors"
            >
              <ArrowLeft size={15} />
            </button>
            <ShieldAlert size={15} className="text-[#4F8EF7]" />
            <span className="font-semibold text-sm tracking-tight">风险分析</span>
            {data && <SourceBadge source={data.source} detail={data.source_detail} />}
          </div>
          <div className="flex items-center gap-2">
            {lastUpdated && (
              <span className="text-[10px] text-[#3A4E6A] hidden sm:block">
                {lastUpdated.toLocaleTimeString('zh-CN', {
                  hour: '2-digit', minute: '2-digit', second: '2-digit',
                })}
              </span>
            )}
            <button
              onClick={load}
              disabled={loading}
              className="p-2 rounded-lg hover:bg-[#172033] text-[#6B7E9C] hover:text-[#E8EDFB] transition-colors disabled:opacity-40"
            >
              <RefreshCw size={15} className={loading ? 'animate-spin' : ''} />
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-4 pb-24 pt-6 space-y-4">
        {loading && !data ? (
          <Skeleton />
        ) : err ? (
          <ErrorPanel err={err} />
        ) : data ? (
          <>
            {/* Data range */}
            <p className="text-[11px] text-[#3A4E6A]">
              数据区间：{data.start_date} → {data.end_date} · {data.n_assets} 只持仓
            </p>

            <OverviewCards p={data.portfolio} />
            <DiversificationStrip p={data.portfolio} />
            <RiskTable assets={data.assets} />
            <CorrelationHeatmap corr={data.correlation} />

            {Object.keys(data.clusters).length > 0 && (
              <section>
                <p className="text-[10px] font-medium text-[#6B7E9C] uppercase tracking-wider mb-3">
                  集群分析
                </p>
                <div className="space-y-3">
                  {Object.entries(data.clusters).map(([name, cluster]) => (
                    <ClusterCard key={name} name={name} c={cluster} />
                  ))}
                </div>
              </section>
            )}

            <p className="text-[10px] text-[#3A4E6A] text-center pt-2">
              {data.source_detail} · 生成于{' '}
              {new Date(data.generated_at).toLocaleString('zh-CN')}
            </p>
          </>
        ) : null}
      </main>
    </div>
  );
}
