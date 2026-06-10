'use client';
import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { Plus, RefreshCw, TrendingUp, TrendingDown, BarChart3, Search, ArrowUpDown, X, AlertTriangle, Zap, Star, Trash2, LogOut, KeyRound, Eye, EyeOff, ChevronDown, ChevronUp, ShieldAlert } from 'lucide-react';
import HoldingsTable from '@/components/HoldingsTable';
import TransactionList from '@/components/TransactionList';
import TransactionModal from '@/components/TransactionModal';
import FontSizeToggle from '@/components/FontSizeToggle';
import type { DailyInsight } from '@/lib/daily-focus';

interface Summary { totalValue: number; totalCost: number; totalPnl: number; totalPnlPct: number; ytdPnl: number; ytdPnlPct: number; currentCash: number; ytdNetPnl: number; ytdDividends: number; annualReturn: number | null }
interface Holding { ticker: string; name: string; shares: number; avgCost: number; currentPrice: number; currentValue: number; pnl: number; pnlPct: number; dayChange: number; dayChangePct: number; portfolioPct: number }
interface WatchItem { ticker: string; name: string; price: number; change: number; changePct: number }
interface PnlRecord { ticker: string; name: string; status: 'open' | 'closed'; realizedPnl: number; unrealizedPnl: number; totalPnl: number; currentShares: number; currentPrice: number; avgCost: number; firstBuyDate: string; lastActivityDate: string; holdingDays: number }
interface CashFlow { id: number; type: 'deposit' | 'withdrawal'; amount: number; date: string; notes: string }
interface RiskSnippet {
  source: 'db' | 'json';
  portfolio: { portfolio_vol: number; beta: number | null; sharpe: number | null; max_dd: number };
  assets: { symbol: string; risk_contribution: number; risk_tier: string }[];
}

type SortKey = 'value' | 'alloc' | 'pnlPct' | 'pnl' | 'name';
type Tab = 'holdings' | 'pnl' | 'transactions' | 'capital' | 'watchlist';
type ChartRange = '1mo' | '3mo' | '1y' | 'max';

function fmt(n: number) {
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

const SORT_OPTIONS: { key: SortKey; label: string }[] = [
  { key: 'value', label: '市值' },
  { key: 'alloc', label: '占比 %' },
  { key: 'pnlPct', label: '盈亏 %' },
  { key: 'pnl',    label: '盈亏 $' },
  { key: 'name',   label: '名称' },
];
const CHART_RANGES: { key: ChartRange; label: string }[] = [
  { key: '1mo', label: '1月' }, { key: '3mo', label: '3月' },
  { key: '1y',  label: '1年' }, { key: 'max', label: '全部' },
];

function fmtDuration(days: number): string {
  if (days < 30) return `${days}天`;
  if (days < 365) return `${Math.floor(days / 30)}个月`;
  const y = Math.floor(days / 365), m = Math.floor((days % 365) / 30);
  return m > 0 ? `${y}年${m}个月` : `${y}年`;
}

export default function Dashboard() {
  const router = useRouter();
  const [portfolio, setPortfolio] = useState<{ holdings: Holding[]; summary: Summary } | null>(null);
  const [transactions, setTransactions] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [modal, setModal] = useState(false);
  const [tab, setTab] = useState<Tab>('holdings');
  const [insight, setInsight] = useState<DailyInsight | null>(null);
  const [changePwModal, setChangePwModal] = useState(false);

  // Capital / cash flow state
  const [cashFlows, setCashFlows] = useState<CashFlow[]>([]);
  const [cfModal, setCfModal] = useState(false);

  // Watchlist state
  const [watchlist, setWatchlist] = useState<WatchItem[]>([]);
  const [wlSearch, setWlSearch] = useState('');
  const [wlResults, setWlResults] = useState<any[]>([]);
  const [wlSearching, setWlSearching] = useState(false);
  const wlSearchRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Holdings filter state
  const [search, setSearch] = useState('');
  const [sortBy, setSortBy] = useState<SortKey>('value');
  const [sortDir, setSortDir] = useState<'desc' | 'asc'>('desc');

  // Portfolio chart state
  const [chartOpen, setChartOpen]     = useState(false);
  const [chartRange, setChartRange]   = useState<ChartRange>('1y');
  const [chartPoints, setChartPoints] = useState<{t:number;p:number}[]>([]);
  const [chartLoading, setChartLoading] = useState(false);
  const [chartHover, setChartHover]   = useState<number | null>(null);

  // PnL tab state
  const [pnlData, setPnlData]       = useState<PnlRecord[] | null>(null);
  const [pnlLoading, setPnlLoading] = useState(false);

  // Risk snippet state
  const [riskData, setRiskData]       = useState<RiskSnippet | null>(null);
  const [riskLoading, setRiskLoading] = useState(true);

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const [pRes, tRes] = await Promise.all([fetch('/api/portfolio'), fetch('/api/transactions')]);
      setPortfolio(await pRes.json());
      setTransactions(await tRes.json());
      setLastUpdated(new Date());
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  const loadWatchlist = useCallback(async () => {
    const res = await fetch('/api/watchlist');
    setWatchlist(await res.json());
  }, []);

  const loadCashFlows = useCallback(async () => {
    fetch('/api/cash-flows').then(r => r.json()).then(setCashFlows).catch(() => {});
  }, []);

  useEffect(() => {
    load(false);
    loadWatchlist();
    loadCashFlows();
    fetch('/api/daily-focus').then(r => r.json()).then(setInsight).catch(() => {});
    fetch('/api/risk').then(r => r.json()).then(d => {
      if (d?.portfolio && Array.isArray(d?.assets)) setRiskData(d);
    }).catch(() => {}).finally(() => setRiskLoading(false));
  }, [load, loadWatchlist, loadCashFlows]);

  // Silent auto-refresh every 30s — data updates in-place, no loading spinner
  useEffect(() => {
    const tick = () => {
      if (document.hidden) return;
      load(true);
      setPnlData(null);
    };
    const id = setInterval(tick, 30_000);
    return () => clearInterval(id);
  }, [load]);

  // Load portfolio chart when opened or range changes
  useEffect(() => {
    if (!chartOpen) return;
    setChartLoading(true);
    fetch(`/api/portfolio/chart?range=${chartRange}`)
      .then(r => r.json()).then(setChartPoints).catch(() => {}).finally(() => setChartLoading(false));
  }, [chartOpen, chartRange]);

  // Load PnL when tab selected
  useEffect(() => {
    if (tab !== 'pnl' || pnlData) return;
    setPnlLoading(true);
    fetch('/api/pnl').then(r => r.json()).then(setPnlData).catch(() => {}).finally(() => setPnlLoading(false));
  }, [tab, pnlData]);

  // Debounced watchlist search
  useEffect(() => {
    if (!wlSearch.trim()) { setWlResults([]); return; }
    if (wlSearchRef.current) clearTimeout(wlSearchRef.current);
    wlSearchRef.current = setTimeout(async () => {
      setWlSearching(true);
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(wlSearch)}`);
        setWlResults(await res.json());
      } finally {
        setWlSearching(false);
      }
    }, 350);
  }, [wlSearch]);

  async function addToWatchlist(ticker: string, name: string) {
    await fetch('/api/watchlist', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ticker, name }),
    });
    setWlSearch('');
    setWlResults([]);
    loadWatchlist();
  }

  async function removeFromWatchlist(ticker: string) {
    await fetch(`/api/watchlist/${ticker}`, { method: 'DELETE' });
    setWatchlist(w => w.filter(x => x.ticker !== ticker));
  }

  const filteredHoldings = useMemo(() => {
    let result = portfolio?.holdings ?? [];
    if (search.trim()) {
      const q = search.toLowerCase();
      result = result.filter(h => h.ticker.toLowerCase().includes(q) || h.name.toLowerCase().includes(q));
    }
    return [...result].sort((a, b) => {
      let va: number | string, vb: number | string;
      if (sortBy === 'value')        { va = a.currentValue; vb = b.currentValue; }
      else if (sortBy === 'alloc')   { va = a.portfolioPct; vb = b.portfolioPct; }
      else if (sortBy === 'pnlPct')  { va = a.pnlPct;       vb = b.pnlPct; }
      else if (sortBy === 'pnl')     { va = a.pnl;           vb = b.pnl; }
      else                           { va = a.ticker;        vb = b.ticker; }
      if (typeof va === 'string') return sortDir === 'asc' ? va.localeCompare(vb as string) : (vb as string).localeCompare(va);
      return sortDir === 'asc' ? va - (vb as number) : (vb as number) - va;
    });
  }, [portfolio, search, sortBy, sortDir]);

  const hasFilter = !!search;
  const s = portfolio?.summary;
  const pos = (s?.totalPnl ?? 0) >= 0;
  const watchlistTickers = new Set(watchlist.map(w => w.ticker));

  return (
    <div className="min-h-screen bg-[#080B14]">
      <header className="sticky top-0 z-30 bg-[#080B14]/90 backdrop-blur border-b border-[#1E2D42]">
        <div className="max-w-5xl mx-auto px-4 h-14 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <BarChart3 size={18} className="text-[#4F8EF7]" />
            <span className="font-semibold text-sm tracking-tight">Trade Tracker</span>
          </div>
          <div className="flex items-center gap-1.5">
            <FontSizeToggle />
            <button onClick={() => load(false)} className="p-2 rounded-lg hover:bg-[#172033] text-[#6B7E9C] hover:text-[#E8EDFB] transition-colors">
              <RefreshCw size={15} className={loading ? 'animate-spin' : ''} />
            </button>
            <button onClick={() => router.push('/risk')} title="风险分析"
              className="p-2 rounded-lg hover:bg-[#172033] text-[#6B7E9C] hover:text-[#E8EDFB] transition-colors">
              <ShieldAlert size={15} />
            </button>
            <button onClick={() => setChangePwModal(true)} title="修改账户"
              className="p-2 rounded-lg hover:bg-[#172033] text-[#6B7E9C] hover:text-[#E8EDFB] transition-colors">
              <KeyRound size={15} />
            </button>
            <button onClick={async () => {
              await fetch('/api/auth/logout', { method: 'POST' });
              router.push('/login');
            }} title="退出登录"
              className="p-2 rounded-lg hover:bg-[#172033] text-[#6B7E9C] hover:text-rose-400 transition-colors">
              <LogOut size={15} />
            </button>
            <button onClick={() => setModal(true)}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-[#4F8EF7] hover:bg-[#6EA3FF] text-white text-sm font-medium rounded-lg transition-colors">
              <Plus size={15} />
              <span className="hidden sm:inline">记录交易</span>
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-4 pb-24 pt-6">
        {/* Risk alerts */}
        {(insight?.alerts.length ?? 0) > 0 && (
          <section className="mb-4">
            <div className="rounded-2xl bg-rose-950/40 border border-rose-500/40 p-4">
              <div className="flex items-center gap-2 mb-3">
                <AlertTriangle size={15} className="text-rose-400 shrink-0" />
                <p className="text-sm font-semibold text-rose-300">持仓风险预警</p>
              </div>
              <div className="space-y-3">
                {insight!.alerts.map(a => (
                  <button key={a.ticker} onClick={() => router.push(`/stock/${a.ticker}`)} className="w-full text-left group">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="font-mono font-bold text-sm text-rose-300">{a.ticker}</span>
                      <span className="text-xs text-rose-400/70">{a.name}</span>
                      <span className="ml-auto font-mono text-xs text-rose-400">
                        {a.changePct >= 0 ? '+' : ''}{a.changePct.toFixed(2)}%
                      </span>
                    </div>
                    <p className="text-xs text-rose-200/70 leading-relaxed group-hover:text-rose-200 transition-colors">{a.warning}</p>
                  </button>
                ))}
              </div>
            </div>
          </section>
        )}

        {/* Portfolio summary */}
        <section className="mb-5">
          {loading && !portfolio ? (
            <div className="h-28 rounded-2xl bg-[#0F1520] animate-pulse" />
          ) : s ? (
            <div className="rounded-2xl bg-[#0F1520] border border-[#1E2D42] overflow-hidden">
              <div className="p-5 sm:p-6">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <div className="flex items-center gap-2 mb-1">
                      <p className="text-xs text-[#6B7E9C] uppercase tracking-wider">总资产</p>
                      {lastUpdated && <p className="text-[10px] text-[#3A4E6A]">更新 {lastUpdated.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</p>}
                    </div>
                    <p className="text-3xl sm:text-4xl font-bold font-mono tracking-tight">${fmt(s.totalValue)}</p>
                    <div className={`flex items-center gap-2 mt-2 ${pos ? 'text-emerald-400' : 'text-rose-400'}`}>
                      {pos ? <TrendingUp size={14} /> : <TrendingDown size={14} />}
                      <span className="font-mono text-base font-semibold">{pos ? '+' : ''}${fmt(s.totalPnl)}</span>
                      <span className="font-mono text-sm opacity-80">({pos ? '+' : ''}{fmt(s.totalPnlPct)}%)</span>
                    </div>
                    <div className="flex items-center gap-2 mt-1">
                      <span className="text-xs text-[#3A4E6A]">YTD</span>
                      <span className={`font-mono text-sm font-semibold ${s.ytdPnl >= 0 ? 'text-emerald-400/75' : 'text-rose-400/75'}`}>
                        {s.ytdPnl >= 0 ? '+' : ''}${fmt(s.ytdPnl)}
                      </span>
                      <span className={`font-mono text-xs opacity-70 ${s.ytdPnl >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                        ({s.ytdPnl >= 0 ? '+' : ''}{fmt(s.ytdPnlPct)}%)
                      </span>
                    </div>
                    <div className="flex items-center gap-2 mt-1 flex-wrap">
                      <span className="text-xs text-[#3A4E6A]">今年净赚</span>
                      <span className={`font-mono text-sm font-semibold ${s.ytdNetPnl >= 0 ? 'text-emerald-400/75' : 'text-rose-400/75'}`}>
                        {s.ytdNetPnl >= 0 ? '+' : ''}${fmt(s.ytdNetPnl)}
                      </span>
                      {s.annualReturn !== null && (
                        <>
                          <span className="text-[#1E2D42]">·</span>
                          <span className="text-xs text-[#6B7E9C]">年化</span>
                          <span className={`font-mono text-sm font-bold ${s.annualReturn >= 0 ? 'text-[#4F8EF7]' : 'text-rose-400'}`}>
                            {s.annualReturn >= 0 ? '+' : ''}{fmt(s.annualReturn)}%
                          </span>
                        </>
                      )}
                    </div>
                    {s.currentCash > 0 && (
                      <div className="flex items-center gap-2 mt-1">
                        <span className="text-xs text-[#3A4E6A]">账户余额</span>
                        <span className="font-mono text-sm text-[#8B9CC0]">${fmt(s.currentCash)}</span>
                      </div>
                    )}
                  </div>
                  <button onClick={() => setChartOpen(o => !o)}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#141C2C] border border-[#1E2D42] text-xs text-[#6B7E9C] hover:text-[#E8EDFB] hover:border-[#4F8EF7]/40 transition-colors mt-1 shrink-0">
                    {chartOpen ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                    走势图
                  </button>
                </div>
                {portfolio!.holdings.length > 0 && (
                  <div className="mt-5 pt-4 border-t border-[#1E2D42]">
                    <div className="flex gap-1 h-2 rounded-full overflow-hidden">
                      {portfolio!.holdings.map(h => (
                        <div key={h.ticker} title={`${h.ticker}: ${h.portfolioPct.toFixed(1)}%`}
                          className="h-full first:rounded-l-full last:rounded-r-full opacity-80 hover:opacity-100 transition-opacity"
                          style={{ width: `${h.portfolioPct}%`, backgroundColor: stringToColor(h.ticker) }} />
                      ))}
                    </div>
                    <div className="flex flex-wrap gap-x-4 gap-y-1 mt-3">
                      {portfolio!.holdings.slice(0, 6).map(h => (
                        <div key={h.ticker} className="flex items-center gap-1.5 text-xs text-[#6B7E9C]">
                          <div className="w-2 h-2 rounded-full" style={{ backgroundColor: stringToColor(h.ticker) }} />
                          <span className="font-mono">{h.ticker}</span>
                          <span>{h.portfolioPct.toFixed(1)}%</span>
                        </div>
                      ))}
                      {portfolio!.holdings.length > 6 && (
                        <span className="text-xs text-[#3A4E6A]">+{portfolio!.holdings.length - 6} more</span>
                      )}
                    </div>
                  </div>
                )}
              </div>

              {/* Collapsible chart */}
              {chartOpen && (
                <div className="border-t border-[#1E2D42] px-4 pb-4 pt-3">
                  {/* Range tabs + hover value */}
                  <div className="flex items-center justify-between mb-3">
                    <div className="flex gap-1">
                      {CHART_RANGES.map(r => (
                        <button key={r.key} onClick={() => setChartRange(r.key)}
                          className={`px-2.5 py-1 rounded-lg text-xs transition-all ${chartRange === r.key ? 'bg-[#4F8EF7]/20 text-[#4F8EF7] border border-[#4F8EF7]/40' : 'text-[#6B7E9C] hover:text-[#E8EDFB] hover:bg-[#172033]'}`}>
                          {r.label}
                        </button>
                      ))}
                    </div>
                    <div className="text-right">
                      {chartHover != null && chartPoints[chartHover] ? (
                        <span className="font-mono text-sm font-semibold text-[#E8EDFB]">
                          ${fmt(chartPoints[chartHover].p)}
                        </span>
                      ) : (
                        <span className="font-mono text-sm text-[#6B7E9C]">${fmt(s.totalValue)}</span>
                      )}
                    </div>
                  </div>
                  {chartLoading ? (
                    <div className="h-28 rounded-xl bg-[#141C2C] animate-pulse" />
                  ) : chartPoints.length < 2 ? (
                    <div className="h-28 flex items-center justify-center text-xs text-[#3A4E6A]">暂无足够数据</div>
                  ) : (
                    <PortfolioChart points={chartPoints} height={112} hoverIdx={chartHover} onHover={setChartHover} />
                  )}
                </div>
              )}
            </div>
          ) : null}
        </section>

        {/* Today's focus — compact list */}
        <section className="mb-5">
          <div className="flex items-center gap-2 mb-2">
            <Zap size={13} className="text-[#4F8EF7]" />
            <p className="text-xs font-medium text-[#6B7E9C] uppercase tracking-wider">今日看涨</p>
          </div>
          {!insight ? (
            <div className="rounded-2xl bg-[#0F1520] border border-[#1E2D42] divide-y divide-[#1E2D42]">
              {[...Array(4)].map((_, i) => (
                <div key={i} className="px-4 py-3 flex items-center gap-3">
                  <div className="w-14 h-3.5 rounded bg-[#172033] animate-pulse" />
                  <div className="flex-1 h-3 rounded bg-[#172033] animate-pulse" />
                  <div className="w-12 h-3.5 rounded bg-[#172033] animate-pulse" />
                </div>
              ))}
            </div>
          ) : insight.focus.length === 0 ? (
            <p className="text-xs text-[#3A4E6A]">暂无数据，稍后刷新</p>
          ) : (
            <div className="rounded-2xl bg-[#0F1520] border border-[#1E2D42] overflow-hidden">
              {insight.focus.map((stock, i) => {
                const isPos = stock.changePct >= 0;
                // Take only the first sentence of the reason
                const oneLiner = stock.reason.split(/[。！？\n]/)[0] + '。';
                return (
                  <button key={stock.ticker} onClick={() => router.push(`/stock/${stock.ticker}`)}
                    className={`w-full text-left px-4 py-3 hover:bg-[#172033] active:bg-[#1E2D42] transition-colors flex items-start gap-3 ${i > 0 ? 'border-t border-[#1E2D42]' : ''}`}>
                    <div className="flex items-center gap-2 shrink-0 w-28">
                      <span className="font-mono font-bold text-sm text-[#4F8EF7]">{stock.ticker}</span>
                      <span className={`text-xs font-mono font-semibold ${isPos ? 'text-emerald-400' : 'text-rose-400'}`}>
                        {isPos ? '+' : ''}{stock.changePct.toFixed(2)}%
                      </span>
                    </div>
                    <p className="text-xs text-[#8B9CC0] leading-relaxed flex-1 text-left">{oneLiner}</p>
                  </button>
                );
              })}
            </div>
          )}
        </section>

        {/* Risk snippet card */}
        <section className="mb-5">
          {riskLoading ? (
            <div className="h-[72px] rounded-2xl bg-[#0F1520] animate-pulse" />
          ) : (
            <button onClick={() => router.push('/risk')}
              className="w-full text-left rounded-2xl bg-[#0F1520] border border-[#1E2D42] p-4 hover:border-[#4F8EF7]/40 transition-colors group">
              <div className="flex items-center justify-between mb-2.5">
                <div className="flex items-center gap-2">
                  <ShieldAlert size={13} className="text-[#4F8EF7]" />
                  <p className="text-xs font-medium text-[#6B7E9C] uppercase tracking-wider">组合风险</p>
                  {riskData && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-[#141C2C] text-[#3A4E6A]">
                      {riskData.source === 'db' ? '账本' : 'JSON'}
                    </span>
                  )}
                </div>
                <span className="text-xs text-[#4F8EF7] opacity-70 group-hover:opacity-100 transition-opacity">完整分析 →</span>
              </div>
              {!riskData ? (
                <p className="text-xs text-[#3A4E6A]">风险服务未启动 — 运行 <span className="font-mono">python -m uvicorn main:app</span></p>
              ) : (
                <div className="grid grid-cols-3 gap-3">
                  <div>
                    <p className="text-[10px] text-[#6B7E9C] mb-0.5">年化波动</p>
                    <p className={`font-mono text-base font-bold leading-none ${
                      riskData.portfolio.portfolio_vol > 0.35 ? 'text-rose-400'
                      : riskData.portfolio.portfolio_vol > 0.25 ? 'text-amber-400'
                      : 'text-emerald-400'}`}>
                      {(riskData.portfolio.portfolio_vol * 100).toFixed(1)}%
                    </p>
                  </div>
                  <div>
                    <p className="text-[10px] text-[#6B7E9C] mb-0.5">Beta</p>
                    <p className={`font-mono text-base font-bold leading-none ${
                      (riskData.portfolio.beta ?? 0) > 1.3 ? 'text-rose-400'
                      : (riskData.portfolio.beta ?? 0) > 1.0 ? 'text-amber-400'
                      : 'text-emerald-400'}`}>
                      {riskData.portfolio.beta != null ? riskData.portfolio.beta.toFixed(2) : '—'}
                    </p>
                  </div>
                  <div>
                    <p className="text-[10px] text-[#6B7E9C] mb-0.5">最高风险持仓</p>
                    <div className="flex items-baseline gap-1.5">
                      <span className="font-mono text-sm font-bold text-rose-400 leading-none">
                        {riskData.assets[0]?.symbol ?? '—'}
                      </span>
                      <span className="text-xs text-[#6B7E9C]">
                        {((riskData.assets[0]?.risk_contribution ?? 0) * 100).toFixed(1)}%
                      </span>
                    </div>
                  </div>
                </div>
              )}
            </button>
          )}
        </section>

        {/* Tab switcher */}
        <div className="flex gap-1 mb-4 p-1 bg-[#0F1520] border border-[#1E2D42] rounded-xl w-fit flex-wrap">
          {(['holdings', 'pnl', 'transactions', 'capital', 'watchlist'] as Tab[]).map(t => (
            <button key={t} onClick={() => setTab(t)}
              className={`px-3 py-1.5 text-sm rounded-lg transition-all flex items-center gap-1.5 ${
                tab === t ? 'bg-[#172033] text-[#E8EDFB] font-medium' : 'text-[#6B7E9C] hover:text-[#E8EDFB]'
              }`}>
              {t === 'watchlist' && <Star size={11} />}
              {t === 'holdings' ? '持仓' : t === 'pnl' ? '盈亏记录' : t === 'transactions' ? '交易记录' : t === 'capital' ? '资金' : '自选股'}
              {t === 'holdings' && <span className="ml-0.5 text-xs text-[#3A4E6A]">({portfolio?.holdings.length ?? 0})</span>}
              {t === 'transactions' && <span className="ml-0.5 text-xs text-[#3A4E6A]">({transactions.length})</span>}
            </button>
          ))}
        </div>

        {/* Filter bar — holdings only */}
        {tab === 'holdings' && (portfolio?.holdings.length ?? 0) > 0 && (
          <div className="mb-3 bg-[#0F1520] border border-[#1E2D42] rounded-2xl p-3 sm:p-4 space-y-3">
            <div className="flex gap-2">
              <div className="relative flex-1">
                <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#6B7E9C]" />
                <input value={search} onChange={e => setSearch(e.target.value)} placeholder="搜索股票名或代码…"
                  className="w-full pl-8 pr-8 py-2 rounded-lg bg-[#141C2C] border border-[#1E2D42] text-sm focus:outline-none focus:border-[#4F8EF7] placeholder:text-[#3A4E6A]" />
                {search && (
                  <button onClick={() => setSearch('')} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[#6B7E9C] hover:text-[#E8EDFB]">
                    <X size={13} />
                  </button>
                )}
              </div>
              <button onClick={() => setSortDir(d => d === 'desc' ? 'asc' : 'desc')}
                className="px-3 py-2 rounded-lg bg-[#141C2C] border border-[#1E2D42] text-[#6B7E9C] hover:text-[#E8EDFB] hover:border-[#4F8EF7] transition-colors text-xs flex items-center gap-1.5">
                <ArrowUpDown size={13} />
                <span className="hidden sm:inline">{sortDir === 'desc' ? '降序' : '升序'}</span>
              </button>
            </div>
            <div className="flex flex-wrap gap-1 items-center">
              <span className="text-xs text-[#6B7E9C] mr-0.5">排序:</span>
              {SORT_OPTIONS.map(opt => (
                <button key={opt.key} onClick={() => setSortBy(opt.key)}
                  className={`px-2.5 py-1 rounded-lg text-xs transition-all ${sortBy === opt.key ? 'bg-[#4F8EF7]/20 text-[#4F8EF7] border border-[#4F8EF7]/40' : 'text-[#6B7E9C] hover:text-[#E8EDFB] hover:bg-[#172033]'}`}>
                  {opt.label}
                </button>
              ))}
            </div>
            {hasFilter && (
              <div className="flex items-center justify-between pt-1 border-t border-[#1E2D42]/60">
                <span className="text-xs text-[#6B7E9C]">
                  显示 <span className="text-[#E8EDFB] font-medium">{filteredHoldings.length}</span> / {portfolio?.holdings.length} 只股票
                </span>
                <button onClick={() => setSearch('')} className="text-xs text-rose-400 hover:text-rose-300 transition-colors">
                  清除筛选
                </button>
              </div>
            )}
          </div>
        )}

        {/* Content */}
        {tab === 'watchlist' ? (
          <WatchlistTab
            items={watchlist}
            search={wlSearch}
            setSearch={setWlSearch}
            results={wlResults}
            searching={wlSearching}
            watchlistTickers={watchlistTickers}
            onAdd={addToWatchlist}
            onRemove={removeFromWatchlist}
            onNavigate={t => router.push(`/stock/${t}`)}
          />
        ) : tab === 'capital' ? (
          <CapitalTab
            flows={cashFlows}
            summary={portfolio?.summary ?? null}
            onAdd={() => setCfModal(true)}
            onDelete={async (id) => {
              await fetch(`/api/cash-flows/${id}`, { method: 'DELETE' });
              loadCashFlows();
              load(true);
            }}
          />
        ) : tab === 'pnl' ? (
          <PnlTab data={pnlData} loading={pnlLoading} onNavigate={t => router.push(`/stock/${t}`)} />
        ) : (
          <div className="bg-[#0F1520] border border-[#1E2D42] rounded-2xl p-4 sm:p-5">
            {tab === 'holdings' ? (
              loading && !portfolio ? (
                <div className="space-y-3">
                  {[...Array(3)].map((_, i) => <div key={i} className="h-16 rounded-xl bg-[#172033] animate-pulse" />)}
                </div>
              ) : (
                <HoldingsTable holdings={filteredHoldings} />
              )
            ) : (
              <TransactionList transactions={transactions} onDeleted={load} />
            )}
          </div>
        )}
      </main>

      <button onClick={() => setModal(true)}
        className="fixed bottom-6 right-6 sm:hidden w-14 h-14 bg-[#4F8EF7] hover:bg-[#6EA3FF] rounded-full shadow-lg shadow-[#4F8EF7]/30 flex items-center justify-center text-white transition-all active:scale-95 z-30">
        <Plus size={22} />
      </button>

      {modal && <TransactionModal onClose={() => setModal(false)} onSaved={load} />}
      {changePwModal && <ChangePasswordModal onClose={() => setChangePwModal(false)} />}
      {cfModal && (
        <CashFlowModal
          onClose={() => setCfModal(false)}
          onSaved={async () => { loadCashFlows(); load(true); setCfModal(false); }}
        />
      )}
    </div>
  );
}

// ── Portfolio chart sparkline ─────────────────────────────────────────────────
function PortfolioChart({ points, height, hoverIdx, onHover }: {
  points: { t: number; p: number }[]; height: number;
  hoverIdx: number | null; onHover: (i: number | null) => void;
}) {
  if (points.length < 2) return null;
  const prices = points.map(p => p.p);
  const min = Math.min(...prices), max = Math.max(...prices);
  const span = max - min || min * 0.001 || 1;
  const W = 1000, H = height, px = 2, py = 10;
  const toX = (i: number) => px + (i / (points.length - 1)) * (W - 2 * px);
  const toY = (p: number) => py + (1 - (p - min) / span) * (H - 2 * py);
  const isPos = prices[prices.length - 1] >= prices[0];
  const color = isPos ? '#22C55E' : '#F43F5E';
  const line = points.map((pt, i) => `${i ? 'L' : 'M'}${toX(i).toFixed(1)},${toY(pt.p).toFixed(1)}`).join(' ');
  const fill = `${line} L${toX(points.length - 1).toFixed(1)},${H} L${toX(0).toFixed(1)},${H} Z`;
  function getIdx(cx: number, rect: DOMRect) {
    return Math.max(0, Math.min(points.length - 1, Math.round(((cx - rect.left) / rect.width) * (points.length - 1))));
  }
  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none"
      className="w-full cursor-crosshair select-none" style={{ height, touchAction: 'none' }}
      onMouseMove={e => onHover(getIdx(e.clientX, e.currentTarget.getBoundingClientRect()))}
      onMouseLeave={() => onHover(null)}
      onTouchStart={e => { e.preventDefault(); onHover(getIdx(e.touches[0].clientX, e.currentTarget.getBoundingClientRect())); }}
      onTouchMove={e => { e.preventDefault(); onHover(getIdx(e.touches[0].clientX, e.currentTarget.getBoundingClientRect())); }}
      onTouchEnd={() => onHover(null)}>
      <defs>
        <linearGradient id="pf-fill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.22" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={fill} fill="url(#pf-fill)" />
      <path d={line} fill="none" stroke={color} strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" />
      {hoverIdx != null && (
        <>
          <line x1={toX(hoverIdx)} y1={py - 6} x2={toX(hoverIdx)} y2={H} stroke="#4F8EF7" strokeWidth="1" opacity="0.5" />
          <circle cx={toX(hoverIdx)} cy={toY(points[hoverIdx].p)} r="5" fill="#4F8EF7" stroke="#080B14" strokeWidth="2.5" />
        </>
      )}
    </svg>
  );
}

// ── PnL tab ───────────────────────────────────────────────────────────────────
type PnlSort = 'open-first' | 'by-pnl';

function PnlTab({ data, loading, onNavigate }: {
  data: PnlRecord[] | null; loading: boolean; onNavigate: (t: string) => void;
}) {
  const [sort, setSort] = useState<PnlSort>('open-first');

  if (loading || !data) {
    return (
      <div className="bg-[#0F1520] border border-[#1E2D42] rounded-2xl divide-y divide-[#1E2D42] overflow-hidden">
        {[...Array(4)].map((_, i) => <div key={i} className="p-4 h-20 animate-pulse bg-[#172033]/30" />)}
      </div>
    );
  }
  if (!data.length) {
    return (
      <div className="bg-[#0F1520] border border-[#1E2D42] rounded-2xl p-10 text-center">
        <p className="text-sm text-[#6B7E9C]">暂无交易记录</p>
      </div>
    );
  }

  const sorted = sort === 'by-pnl'
    ? [...data].sort((a, b) => b.totalPnl - a.totalPnl)
    : [
        ...data.filter(r => r.status === 'open').sort((a, b) => b.totalPnl - a.totalPnl),
        ...data.filter(r => r.status === 'closed').sort((a, b) => b.totalPnl - a.totalPnl),
      ];

  const totalRealized   = data.reduce((s, r) => s + r.realizedPnl, 0);
  const totalUnrealized = data.reduce((s, r) => s + r.unrealizedPnl, 0);
  const totalPnl        = totalRealized + totalUnrealized;
  const totalPos        = totalPnl >= 0;

  function fmtPnl(n: number) {
    return `${n >= 0 ? '+' : ''}$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }

  return (
    <div className="space-y-3">
      {/* Summary row */}
      <div className="bg-[#0F1520] border border-[#1E2D42] rounded-2xl p-4 flex flex-wrap gap-4">
        <div>
          <p className="text-xs text-[#6B7E9C] mb-0.5">总盈亏</p>
          <p className={`font-mono font-bold text-lg ${totalPos ? 'text-emerald-400' : 'text-rose-400'}`}>{fmtPnl(totalPnl)}</p>
        </div>
        <div className="h-10 w-px bg-[#1E2D42]" />
        <div>
          <p className="text-xs text-[#6B7E9C] mb-0.5">已实现</p>
          <p className={`font-mono font-semibold text-sm ${totalRealized >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>{fmtPnl(totalRealized)}</p>
        </div>
        <div>
          <p className="text-xs text-[#6B7E9C] mb-0.5">未实现</p>
          <p className={`font-mono font-semibold text-sm ${totalUnrealized >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>{fmtPnl(totalUnrealized)}</p>
        </div>
      </div>

      {/* Sort toggle */}
      <div className="flex gap-1 items-center">
        <span className="text-xs text-[#6B7E9C] mr-0.5">排序:</span>
        {([['open-first', '持仓优先'], ['by-pnl', '按盈利']] as [PnlSort, string][]).map(([key, label]) => (
          <button key={key} onClick={() => setSort(key)}
            className={`px-2.5 py-1 rounded-lg text-xs transition-all ${
              sort === key
                ? 'bg-[#4F8EF7]/20 text-[#4F8EF7] border border-[#4F8EF7]/40'
                : 'text-[#6B7E9C] hover:text-[#E8EDFB] hover:bg-[#172033]'
            }`}>
            {label}
          </button>
        ))}
      </div>

      {/* Per-ticker list */}
      <div className="bg-[#0F1520] border border-[#1E2D42] rounded-2xl overflow-hidden">
        {sorted.map((r, i) => {
          const isPos = r.totalPnl >= 0;
          return (
            <button key={r.ticker} onClick={() => onNavigate(r.ticker)}
              className={`w-full text-left px-4 py-3.5 hover:bg-[#172033] transition-colors ${i > 0 ? 'border-t border-[#1E2D42]' : ''}`}>
              <div className="flex items-start justify-between gap-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="font-mono font-bold text-sm text-[#4F8EF7]">{r.ticker}</span>
                    <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${r.status === 'open' ? 'bg-emerald-400/10 text-emerald-400' : 'bg-[#172033] text-[#6B7E9C]'}`}>
                      {r.status === 'open' ? '持有中' : '已清仓'}
                    </span>
                    <span className="text-xs text-[#3A4E6A]">持有 {fmtDuration(r.holdingDays)}</span>
                  </div>
                  <p className="text-xs text-[#6B7E9C] truncate">{r.name}</p>
                  {r.status === 'open' && (
                    <p className="text-xs text-[#3A4E6A] mt-0.5">
                      {r.currentShares.toFixed(r.currentShares % 1 === 0 ? 0 : 4)} 股 · 均价 ${r.avgCost.toFixed(2)} · 现价 ${r.currentPrice.toFixed(2)}
                    </p>
                  )}
                </div>
                <div className="text-right shrink-0">
                  <p className={`font-mono font-bold text-base ${isPos ? 'text-emerald-400' : 'text-rose-400'}`}>
                    {fmtPnl(r.totalPnl)}
                  </p>
                  {(r.realizedPnl !== 0 || r.unrealizedPnl !== 0) && (
                    <div className="flex gap-2 justify-end mt-0.5">
                      {r.realizedPnl !== 0 && (
                        <span className={`text-xs ${r.realizedPnl >= 0 ? 'text-emerald-400/60' : 'text-rose-400/60'}`}>
                          实 {fmtPnl(r.realizedPnl)}
                        </span>
                      )}
                      {r.unrealizedPnl !== 0 && (
                        <span className={`text-xs ${r.unrealizedPnl >= 0 ? 'text-emerald-400/60' : 'text-rose-400/60'}`}>
                          浮 {fmtPnl(r.unrealizedPnl)}
                        </span>
                      )}
                    </div>
                  )}
                  <p className="text-xs text-[#3A4E6A] mt-0.5">
                    {r.firstBuyDate.slice(0, 7)} → {r.status === 'open' ? '至今' : r.lastActivityDate.slice(0, 7)}
                  </p>
                </div>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ── Watchlist Tab ──────────────────────────────────────────────────────────────
function WatchlistTab({
  items, search, setSearch, results, searching, watchlistTickers, onAdd, onRemove, onNavigate,
}: {
  items: WatchItem[];
  search: string;
  setSearch: (s: string) => void;
  results: any[];
  searching: boolean;
  watchlistTickers: Set<string>;
  onAdd: (ticker: string, name: string) => void;
  onRemove: (ticker: string) => void;
  onNavigate: (ticker: string) => void;
}) {
  return (
    <div className="space-y-3">
      {/* Search to add */}
      <div className="bg-[#0F1520] border border-[#1E2D42] rounded-2xl p-4">
        <p className="text-xs text-[#6B7E9C] mb-3 font-medium uppercase tracking-wider">添加自选股</p>
        <div className="relative">
          <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#6B7E9C]" />
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="搜索股票名称或代码…"
            className="w-full pl-8 pr-8 py-2.5 rounded-xl bg-[#141C2C] border border-[#1E2D42] text-sm focus:outline-none focus:border-[#4F8EF7] placeholder:text-[#3A4E6A]" />
          {search && (
            <button onClick={() => setSearch('')} className="absolute right-3 top-1/2 -translate-y-1/2 text-[#6B7E9C] hover:text-[#E8EDFB]">
              <X size={13} />
            </button>
          )}
        </div>
        {(results.length > 0 || searching) && (
          <div className="mt-2 rounded-xl bg-[#141C2C] border border-[#1E2D42] overflow-hidden">
            {searching && <div className="px-4 py-3 text-xs text-[#3A4E6A]">搜索中…</div>}
            {results.map((r: any) => {
              const already = watchlistTickers.has(r.symbol);
              return (
                <button key={r.symbol} onClick={() => !already && onAdd(r.symbol, r.name)}
                  disabled={already}
                  className={`w-full flex items-center justify-between px-4 py-3 border-t border-[#1E2D42] first:border-0 text-left transition-colors ${already ? 'opacity-40 cursor-default' : 'hover:bg-[#172033]'}`}>
                  <div>
                    <span className="font-mono font-semibold text-sm text-[#4F8EF7]">{r.symbol}</span>
                    <span className="ml-2 text-xs text-[#6B7E9C]">{r.name}</span>
                  </div>
                  <span className="text-[10px] text-[#3A4E6A]">{already ? '已添加' : r.exchange}</span>
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* Watchlist items */}
      {items.length === 0 ? (
        <div className="bg-[#0F1520] border border-[#1E2D42] rounded-2xl p-8 text-center">
          <Star size={24} className="text-[#2A3A54] mx-auto mb-3" />
          <p className="text-sm text-[#6B7E9C]">还没有自选股</p>
          <p className="text-xs text-[#3A4E6A] mt-1">在上方搜索并添加感兴趣的股票</p>
        </div>
      ) : (
        <div className="bg-[#0F1520] border border-[#1E2D42] rounded-2xl overflow-hidden">
          {items.map((item, i) => {
            const isPos = item.changePct >= 0;
            return (
              <div key={item.ticker}
                className={`flex items-center px-4 py-3.5 ${i > 0 ? 'border-t border-[#1E2D42]' : ''}`}>
                <button onClick={() => onNavigate(item.ticker)} className="flex-1 flex items-center gap-3 text-left group">
                  <div>
                    <p className="font-mono font-bold text-sm text-[#E8EDFB] group-hover:text-[#4F8EF7] transition-colors">{item.ticker}</p>
                    <p className="text-xs text-[#6B7E9C] truncate max-w-[160px] sm:max-w-xs">{item.name}</p>
                  </div>
                  <div className="ml-auto text-right pr-3">
                    <p className="font-mono text-sm font-medium">${item.price.toFixed(2)}</p>
                    <p className={`font-mono text-xs font-semibold ${isPos ? 'text-emerald-400' : 'text-rose-400'}`}>
                      {isPos ? '+' : ''}{item.changePct.toFixed(2)}%
                    </p>
                  </div>
                </button>
                <button onClick={() => onRemove(item.ticker)}
                  className="p-2 rounded-lg text-[#3A4E6A] hover:text-rose-400 hover:bg-rose-400/10 transition-colors ml-1">
                  <Trash2 size={13} />
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── 修改密码弹窗 ───────────────────────────────────────────────────────────────
function ChangePasswordModal({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const [currentPw, setCurrentPw]   = useState('');
  const [newUser, setNewUser]       = useState('');
  const [newPw, setNewPw]           = useState('');
  const [confirmPw, setConfirmPw]   = useState('');
  const [showPw, setShowPw]         = useState(false);
  const [error, setError]           = useState('');
  const [loading, setLoading]       = useState(false);
  const [done, setDone]             = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    if (newPw !== confirmPw) { setError('两次输入的新密码不一致'); return; }
    if (newPw.length < 6) { setError('密码至少6位'); return; }
    setLoading(true);
    try {
      const res = await fetch('/api/auth/change-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentPassword: currentPw, newUsername: newUser, newPassword: newPw }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error || '修改失败'); return; }
      setDone(true);
      setTimeout(async () => {
        await fetch('/api/auth/logout', { method: 'POST' });
        router.push('/login');
      }, 1500);
    } catch {
      setError('网络错误');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 px-4" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="w-full max-w-sm bg-[#0F1520] border border-[#1E2D42] rounded-2xl p-6">
        <div className="flex items-center gap-2 mb-5">
          <KeyRound size={13} className="text-[#6B7E9C]" />
          <p className="text-xs font-medium text-[#6B7E9C] uppercase tracking-wider">修改账户信息</p>
        </div>

        {done ? (
          <p className="text-sm text-emerald-400 text-center py-4">修改成功！即将跳转登录页…</p>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-3">
            <div>
              <label className="block text-xs text-[#6B7E9C] mb-1.5">当前密码</label>
              <div className="relative">
                <input type={showPw ? 'text' : 'password'} value={currentPw} onChange={e => setCurrentPw(e.target.value)} required
                  className="w-full px-3.5 py-2.5 pr-10 rounded-xl bg-[#141C2C] border border-[#1E2D42] text-sm focus:outline-none focus:border-[#4F8EF7]" />
                <button type="button" onClick={() => setShowPw(s => !s)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-[#6B7E9C] hover:text-[#E8EDFB]">
                  {showPw ? <EyeOff size={13} /> : <Eye size={13} />}
                </button>
              </div>
            </div>
            <div>
              <label className="block text-xs text-[#6B7E9C] mb-1.5">新用户名</label>
              <input type="text" value={newUser} onChange={e => setNewUser(e.target.value)} required
                className="w-full px-3.5 py-2.5 rounded-xl bg-[#141C2C] border border-[#1E2D42] text-sm focus:outline-none focus:border-[#4F8EF7]" />
            </div>
            <div>
              <label className="block text-xs text-[#6B7E9C] mb-1.5">新密码</label>
              <input type={showPw ? 'text' : 'password'} value={newPw} onChange={e => setNewPw(e.target.value)} required
                className="w-full px-3.5 py-2.5 rounded-xl bg-[#141C2C] border border-[#1E2D42] text-sm focus:outline-none focus:border-[#4F8EF7]" />
            </div>
            <div>
              <label className="block text-xs text-[#6B7E9C] mb-1.5">确认新密码</label>
              <input type={showPw ? 'text' : 'password'} value={confirmPw} onChange={e => setConfirmPw(e.target.value)} required
                className="w-full px-3.5 py-2.5 rounded-xl bg-[#141C2C] border border-[#1E2D42] text-sm focus:outline-none focus:border-[#4F8EF7]" />
            </div>

            {error && (
              <p className="text-xs text-rose-400 bg-rose-400/10 border border-rose-400/20 rounded-xl px-3 py-2">{error}</p>
            )}

            <div className="flex gap-2 pt-1">
              <button type="button" onClick={onClose}
                className="flex-1 py-2.5 rounded-xl border border-[#1E2D42] text-sm text-[#6B7E9C] hover:text-[#E8EDFB] hover:border-[#2A3F60] transition-colors">
                取消
              </button>
              <button type="submit" disabled={loading}
                className="flex-1 py-2.5 rounded-xl bg-[#4F8EF7] hover:bg-[#6EA3FF] disabled:opacity-50 text-white font-medium text-sm transition-colors">
                {loading ? '保存中…' : '保存'}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

// ── Capital tab ───────────────────────────────────────────────────────────────
function CapitalTab({
  flows, summary, onAdd, onDelete,
}: {
  flows: CashFlow[];
  summary: Summary | null;
  onAdd: () => void;
  onDelete: (id: number) => void;
}) {
  const [deleting, setDeleting] = useState<number | null>(null);

  async function del(id: number) {
    if (!confirm('确定删除这条记录？')) return;
    setDeleting(id);
    await onDelete(id);
    setDeleting(null);
  }

  const hasCashFlows = flows.length > 0;

  return (
    <div className="space-y-4">
      {/* Stats */}
      <div className="bg-[#0F1520] border border-[#1E2D42] rounded-2xl p-4">
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
          <div>
            <p className="text-xs text-[#6B7E9C] mb-1">账户余额</p>
            {summary ? (
              <>
                <p className={`font-mono font-bold text-lg ${summary.currentCash >= 0 ? 'text-[#E8EDFB]' : 'text-[#3A4E6A]'}`}>
                  {summary.currentCash >= 0 ? '$' : '-$'}{fmt(Math.abs(summary.currentCash))}
                </p>
                {summary.currentCash < 0 && (
                  <p className="text-xs text-[#3A4E6A] mt-0.5">未配置转账记录</p>
                )}
              </>
            ) : <div className="h-6 w-20 bg-[#172033] rounded animate-pulse" />}
          </div>
          <div>
            <p className="text-xs text-[#6B7E9C] mb-1">今年净赚（假设清仓）</p>
            {summary ? (
              <>
                <p className={`font-mono font-bold text-lg ${summary.ytdNetPnl >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                  {summary.ytdNetPnl >= 0 ? '+' : ''}${fmt(summary.ytdNetPnl)}
                </p>
                {summary.ytdDividends > 0.01 && (
                  <p className="text-xs text-[#6B7E9C] mt-0.5">含分红 +${fmt(summary.ytdDividends)}</p>
                )}
              </>
            ) : <div className="h-6 w-20 bg-[#172033] rounded animate-pulse" />}
          </div>
          <div>
            <p className="text-xs text-[#6B7E9C] mb-1">年化收益率</p>
            {summary ? (
              hasCashFlows && summary.annualReturn !== null ? (
                <p className={`font-mono font-bold text-lg ${summary.annualReturn >= 0 ? 'text-[#4F8EF7]' : 'text-rose-400'}`}>
                  {summary.annualReturn >= 0 ? '+' : ''}{fmt(summary.annualReturn)}%
                </p>
              ) : (
                <p className="font-mono text-lg text-[#3A4E6A]">—</p>
              )
            ) : <div className="h-6 w-16 bg-[#172033] rounded animate-pulse" />}
            {summary && !hasCashFlows && (
              <p className="text-xs text-[#3A4E6A] mt-0.5">需先添加转账记录</p>
            )}
          </div>
        </div>
        {summary && hasCashFlows && summary.annualReturn !== null && (
          <p className="text-[11px] text-[#3A4E6A] mt-3 leading-relaxed border-t border-[#1E2D42] pt-3">
            年化 = 今年净赚 ÷ Σ每日累计投入 × 365，以今年1月1日为起点计算
          </p>
        )}
      </div>

      {/* Add button + list */}
      <div className="flex items-center justify-between">
        <p className="text-xs font-medium text-[#6B7E9C] uppercase tracking-wider">转账记录</p>
        <button onClick={onAdd}
          className="flex items-center gap-1.5 px-3 py-1.5 bg-[#4F8EF7] hover:bg-[#6EA3FF] text-white text-xs font-medium rounded-lg transition-colors">
          <Plus size={12} />
          记录转账
        </button>
      </div>

      {flows.length === 0 ? (
        <div className="bg-[#0F1520] border border-[#1E2D42] rounded-2xl p-10 text-center">
          <p className="text-sm text-[#6B7E9C]">暂无转账记录</p>
          <p className="text-xs text-[#3A4E6A] mt-1">记录每次向券商账户转入或转出的金额</p>
        </div>
      ) : (
        <div className="bg-[#0F1520] border border-[#1E2D42] rounded-2xl overflow-hidden">
          {flows.map((cf, i) => {
            const isDeposit = cf.type === 'deposit';
            return (
              <div key={cf.id}
                className={`flex items-center gap-3 px-4 py-3.5 ${i > 0 ? 'border-t border-[#1E2D42]' : ''}`}>
                <div className={`w-7 h-7 rounded-lg flex items-center justify-center shrink-0 text-sm font-bold ${
                  isDeposit ? 'bg-emerald-500/15 text-emerald-400' : 'bg-rose-500/15 text-rose-400'
                }`}>
                  {isDeposit ? '↑' : '↓'}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-baseline gap-2">
                    <span className={`text-sm font-semibold ${isDeposit ? 'text-emerald-400' : 'text-rose-400'}`}>
                      {isDeposit ? '转入' : '转出'}
                    </span>
                    <span className="font-mono text-sm font-bold">${fmt(cf.amount)}</span>
                  </div>
                  <div className="flex items-center gap-2 mt-0.5">
                    <span className="text-xs text-[#3A4E6A]">{cf.date}</span>
                    {cf.notes && <span className="text-xs text-[#3A4E6A] italic truncate max-w-[140px]">· {cf.notes}</span>}
                  </div>
                </div>
                <button onClick={() => del(cf.id)} disabled={deleting === cf.id}
                  className="opacity-30 hover:opacity-100 p-1.5 rounded-lg hover:bg-rose-500/15 text-rose-400 transition-all shrink-0">
                  <Trash2 size={13} />
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── Cash flow modal ───────────────────────────────────────────────────────────
function CashFlowModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [type, setType] = useState<'deposit' | 'withdrawal'>('deposit');
  const [amount, setAmount] = useState('');
  const [date, setDate] = useState(new Date().toISOString().split('T')[0]);
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!amount || Number(amount) <= 0) { setError('请输入有效金额'); return; }
    setSaving(true);
    setError('');
    try {
      const res = await fetch('/api/cash-flows', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type, amount: Number(amount), date, notes }),
      });
      if (!res.ok) { setError('保存失败'); return; }
      onSaved();
    } catch { setError('网络错误'); }
    finally { setSaving(false); }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 px-4"
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="w-full max-w-sm bg-[#0F1520] border border-[#1E2D42] rounded-2xl p-6">
        <p className="text-xs font-medium text-[#6B7E9C] uppercase tracking-wider mb-5">记录转账</p>
        <form onSubmit={submit} className="space-y-3">
          <div className="flex gap-2">
            {(['deposit', 'withdrawal'] as const).map(t => (
              <button key={t} type="button" onClick={() => setType(t)}
                className={`flex-1 py-2 rounded-xl text-sm font-medium transition-colors ${
                  type === t
                    ? t === 'deposit' ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/40' : 'bg-rose-500/20 text-rose-400 border border-rose-500/40'
                    : 'bg-[#141C2C] border border-[#1E2D42] text-[#6B7E9C] hover:text-[#E8EDFB]'
                }`}>
                {t === 'deposit' ? '↑ 转入' : '↓ 转出'}
              </button>
            ))}
          </div>
          <div>
            <label className="block text-xs text-[#6B7E9C] mb-1.5">金额 (USD)</label>
            <input type="number" min="0.01" step="0.01" value={amount} onChange={e => setAmount(e.target.value)} required
              placeholder="0.00"
              className="w-full px-3.5 py-2.5 rounded-xl bg-[#141C2C] border border-[#1E2D42] text-sm focus:outline-none focus:border-[#4F8EF7] placeholder:text-[#3A4E6A]" />
          </div>
          <div>
            <label className="block text-xs text-[#6B7E9C] mb-1.5">日期</label>
            <input type="date" value={date} onChange={e => setDate(e.target.value)} required
              className="w-full px-3.5 py-2.5 rounded-xl bg-[#141C2C] border border-[#1E2D42] text-sm focus:outline-none focus:border-[#4F8EF7]" />
          </div>
          <div>
            <label className="block text-xs text-[#6B7E9C] mb-1.5">备注（可选）</label>
            <input type="text" value={notes} onChange={e => setNotes(e.target.value)}
              className="w-full px-3.5 py-2.5 rounded-xl bg-[#141C2C] border border-[#1E2D42] text-sm focus:outline-none focus:border-[#4F8EF7]" />
          </div>
          {error && <p className="text-xs text-rose-400 bg-rose-400/10 border border-rose-400/20 rounded-xl px-3 py-2">{error}</p>}
          <div className="flex gap-2 pt-1">
            <button type="button" onClick={onClose}
              className="flex-1 py-2.5 rounded-xl border border-[#1E2D42] text-sm text-[#6B7E9C] hover:text-[#E8EDFB] transition-colors">
              取消
            </button>
            <button type="submit" disabled={saving}
              className="flex-1 py-2.5 rounded-xl bg-[#4F8EF7] hover:bg-[#6EA3FF] disabled:opacity-50 text-white font-medium text-sm transition-colors">
              {saving ? '保存中…' : '保存'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function stringToColor(str: string): string {
  const colors = ['#4F8EF7', '#22C55E', '#F59E0B', '#A855F7', '#EC4899', '#14B8A6', '#F97316', '#06B6D4'];
  let hash = 0;
  for (let i = 0; i < str.length; i++) hash = str.charCodeAt(i) + ((hash << 5) - hash);
  return colors[Math.abs(hash) % colors.length];
}
