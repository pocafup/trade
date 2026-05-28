'use client';
import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { Plus, RefreshCw, TrendingUp, TrendingDown, BarChart3, Search, ArrowUpDown, X, AlertTriangle, Zap, Star, Trash2 } from 'lucide-react';
import HoldingsTable from '@/components/HoldingsTable';
import TransactionList from '@/components/TransactionList';
import TransactionModal from '@/components/TransactionModal';
import FontSizeToggle from '@/components/FontSizeToggle';
import type { DailyInsight } from '@/lib/daily-focus';

interface Summary { totalValue: number; totalCost: number; totalPnl: number; totalPnlPct: number }
interface Holding { ticker: string; name: string; shares: number; avgCost: number; currentPrice: number; currentValue: number; pnl: number; pnlPct: number; dayChange: number; dayChangePct: number; portfolioPct: number }
interface WatchItem { ticker: string; name: string; price: number; change: number; changePct: number }

type SortKey = 'value' | 'alloc' | 'pnlPct' | 'pnl' | 'name';
type Tab = 'holdings' | 'transactions' | 'watchlist';

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
const MIN_VALUE_OPTIONS = [
  { label: '不限', value: 0 }, { label: '>$1K', value: 1000 },
  { label: '>$5K', value: 5000 }, { label: '>$10K', value: 10000 },
];
const MIN_ALLOC_OPTIONS = [
  { label: '不限', value: 0 }, { label: '>1%', value: 1 },
  { label: '>5%', value: 5 }, { label: '>10%', value: 10 },
];

export default function Dashboard() {
  const router = useRouter();
  const [portfolio, setPortfolio] = useState<{ holdings: Holding[]; summary: Summary } | null>(null);
  const [transactions, setTransactions] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState(false);
  const [tab, setTab] = useState<Tab>('holdings');
  const [insight, setInsight] = useState<DailyInsight | null>(null);

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
  const [minValue, setMinValue] = useState(0);
  const [minAlloc, setMinAlloc] = useState(0);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [pRes, tRes] = await Promise.all([fetch('/api/portfolio'), fetch('/api/transactions')]);
      setPortfolio(await pRes.json());
      setTransactions(await tRes.json());
    } finally {
      setLoading(false);
    }
  }, []);

  const loadWatchlist = useCallback(async () => {
    const res = await fetch('/api/watchlist');
    setWatchlist(await res.json());
  }, []);

  useEffect(() => {
    load();
    loadWatchlist();
    fetch('/api/daily-focus').then(r => r.json()).then(setInsight).catch(() => {});
  }, [load, loadWatchlist]);

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
    if (minValue > 0) result = result.filter(h => h.currentValue >= minValue);
    if (minAlloc > 0) result = result.filter(h => h.portfolioPct >= minAlloc);
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
  }, [portfolio, search, sortBy, sortDir, minValue, minAlloc]);

  const hasFilter = search || minValue > 0 || minAlloc > 0;
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
          <div className="flex items-center gap-2">
            <FontSizeToggle />
            <button onClick={load} className="p-2 rounded-lg hover:bg-[#172033] text-[#6B7E9C] hover:text-[#E8EDFB] transition-colors">
              <RefreshCw size={15} className={loading ? 'animate-spin' : ''} />
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
            <div className="rounded-2xl bg-[#0F1520] border border-[#1E2D42] p-5 sm:p-6">
              <div className="flex flex-col sm:flex-row sm:items-end gap-4 sm:gap-8">
                <div>
                  <p className="text-xs text-[#6B7E9C] mb-1 uppercase tracking-wider">总资产</p>
                  <p className="text-3xl sm:text-4xl font-bold font-mono tracking-tight">${fmt(s.totalValue)}</p>
                </div>
                <div className={`flex items-center gap-2 pb-1 ${pos ? 'text-emerald-400' : 'text-rose-400'}`}>
                  {pos ? <TrendingUp size={16} /> : <TrendingDown size={16} />}
                  <span className="font-mono text-lg font-semibold">{pos ? '+' : ''}${fmt(s.totalPnl)}</span>
                  <span className="font-mono text-sm opacity-80">({pos ? '+' : ''}{fmt(s.totalPnlPct)}%)</span>
                </div>
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

        {/* Tab switcher */}
        <div className="flex gap-1 mb-4 p-1 bg-[#0F1520] border border-[#1E2D42] rounded-xl w-fit">
          {(['holdings', 'transactions', 'watchlist'] as Tab[]).map(t => (
            <button key={t} onClick={() => setTab(t)}
              className={`px-4 py-1.5 text-sm rounded-lg transition-all flex items-center gap-1.5 ${
                tab === t ? 'bg-[#172033] text-[#E8EDFB] font-medium' : 'text-[#6B7E9C] hover:text-[#E8EDFB]'
              }`}>
              {t === 'watchlist' && <Star size={11} />}
              {t === 'holdings' ? '持仓' : t === 'transactions' ? '交易记录' : '自选股'}
              {t !== 'watchlist' && (
                <span className="ml-0.5 text-xs text-[#3A4E6A]">
                  ({t === 'holdings' ? (portfolio?.holdings.length ?? 0) : transactions.length})
                </span>
              )}
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
            <div className="flex flex-wrap gap-2 items-center">
              <div className="flex items-center gap-1 flex-wrap">
                <span className="text-xs text-[#6B7E9C] mr-0.5">排序:</span>
                {SORT_OPTIONS.map(opt => (
                  <button key={opt.key} onClick={() => setSortBy(opt.key)}
                    className={`px-2.5 py-1 rounded-lg text-xs transition-all ${sortBy === opt.key ? 'bg-[#4F8EF7]/20 text-[#4F8EF7] border border-[#4F8EF7]/40' : 'text-[#6B7E9C] hover:text-[#E8EDFB] hover:bg-[#172033]'}`}>
                    {opt.label}
                  </button>
                ))}
              </div>
              <div className="h-4 w-px bg-[#1E2D42] hidden sm:block" />
              <div className="flex items-center gap-1">
                <span className="text-xs text-[#6B7E9C] mr-0.5">最小市值:</span>
                {MIN_VALUE_OPTIONS.map(opt => (
                  <button key={opt.value} onClick={() => setMinValue(opt.value)}
                    className={`px-2.5 py-1 rounded-lg text-xs transition-all ${minValue === opt.value ? 'bg-[#4F8EF7]/20 text-[#4F8EF7] border border-[#4F8EF7]/40' : 'text-[#6B7E9C] hover:text-[#E8EDFB] hover:bg-[#172033]'}`}>
                    {opt.label}
                  </button>
                ))}
              </div>
              <div className="h-4 w-px bg-[#1E2D42] hidden sm:block" />
              <div className="flex items-center gap-1">
                <span className="text-xs text-[#6B7E9C] mr-0.5">最小占比:</span>
                {MIN_ALLOC_OPTIONS.map(opt => (
                  <button key={opt.value} onClick={() => setMinAlloc(opt.value)}
                    className={`px-2.5 py-1 rounded-lg text-xs transition-all ${minAlloc === opt.value ? 'bg-[#4F8EF7]/20 text-[#4F8EF7] border border-[#4F8EF7]/40' : 'text-[#6B7E9C] hover:text-[#E8EDFB] hover:bg-[#172033]'}`}>
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>
            {hasFilter && (
              <div className="flex items-center justify-between pt-1 border-t border-[#1E2D42]/60">
                <span className="text-xs text-[#6B7E9C]">
                  显示 <span className="text-[#E8EDFB] font-medium">{filteredHoldings.length}</span> / {portfolio?.holdings.length} 只股票
                </span>
                <button onClick={() => { setSearch(''); setMinValue(0); setMinAlloc(0); }}
                  className="text-xs text-rose-400 hover:text-rose-300 transition-colors">
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

function stringToColor(str: string): string {
  const colors = ['#4F8EF7', '#22C55E', '#F59E0B', '#A855F7', '#EC4899', '#14B8A6', '#F97316', '#06B6D4'];
  let hash = 0;
  for (let i = 0; i < str.length; i++) hash = str.charCodeAt(i) + ((hash << 5) - hash);
  return colors[Math.abs(hash) % colors.length];
}
