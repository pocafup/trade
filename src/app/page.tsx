'use client';
import { useState, useEffect, useCallback, useMemo } from 'react';
import { Plus, RefreshCw, TrendingUp, TrendingDown, BarChart3, Search, ArrowUpDown, X } from 'lucide-react';
import HoldingsTable from '@/components/HoldingsTable';
import TransactionList from '@/components/TransactionList';
import TransactionModal from '@/components/TransactionModal';
import FontSizeToggle from '@/components/FontSizeToggle';

interface Summary { totalValue: number; totalCost: number; totalPnl: number; totalPnlPct: number }
interface Holding { ticker: string; name: string; shares: number; avgCost: number; currentPrice: number; currentValue: number; pnl: number; pnlPct: number; dayChange: number; dayChangePct: number; portfolioPct: number }

type SortKey = 'value' | 'alloc' | 'pnlPct' | 'pnl' | 'name';

function fmt(n: number) {
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

const TAB_LABELS = { holdings: '持仓', transactions: '交易记录' } as const;

const SORT_OPTIONS: { key: SortKey; label: string }[] = [
  { key: 'value', label: '市值' },
  { key: 'alloc', label: '占比 %' },
  { key: 'pnlPct', label: '盈亏 %' },
  { key: 'pnl',    label: '盈亏 $' },
  { key: 'name',   label: '名称' },
];

const MIN_VALUE_OPTIONS = [
  { label: '不限', value: 0 },
  { label: '>$1K', value: 1000 },
  { label: '>$5K', value: 5000 },
  { label: '>$10K', value: 10000 },
];

const MIN_ALLOC_OPTIONS = [
  { label: '不限', value: 0 },
  { label: '>1%', value: 1 },
  { label: '>5%', value: 5 },
  { label: '>10%', value: 10 },
];

export default function Dashboard() {
  const [portfolio, setPortfolio] = useState<{ holdings: Holding[]; summary: Summary } | null>(null);
  const [transactions, setTransactions] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState(false);
  const [tab, setTab] = useState<'holdings' | 'transactions'>('holdings');

  // Filter state
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

  useEffect(() => { load(); }, [load]);

  const filteredHoldings = useMemo(() => {
    let result = portfolio?.holdings ?? [];

    if (search.trim()) {
      const q = search.toLowerCase();
      result = result.filter(h =>
        h.ticker.toLowerCase().includes(q) || h.name.toLowerCase().includes(q)
      );
    }
    if (minValue > 0) result = result.filter(h => h.currentValue >= minValue);
    if (minAlloc > 0) result = result.filter(h => h.portfolioPct >= minAlloc);

    return [...result].sort((a, b) => {
      let va: number | string, vb: number | string;
      if (sortBy === 'value')   { va = a.currentValue;  vb = b.currentValue; }
      else if (sortBy === 'alloc')   { va = a.portfolioPct;  vb = b.portfolioPct; }
      else if (sortBy === 'pnlPct')  { va = a.pnlPct;       vb = b.pnlPct; }
      else if (sortBy === 'pnl')     { va = a.pnl;          vb = b.pnl; }
      else                           { va = a.ticker;        vb = b.ticker; }
      if (typeof va === 'string') return sortDir === 'asc' ? va.localeCompare(vb as string) : (vb as string).localeCompare(va);
      return sortDir === 'asc' ? va - (vb as number) : (vb as number) - va;
    });
  }, [portfolio, search, sortBy, sortDir, minValue, minAlloc]);

  const hasFilter = search || minValue > 0 || minAlloc > 0;

  const s = portfolio?.summary;
  const pos = (s?.totalPnl ?? 0) >= 0;

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
            <button
              onClick={() => setModal(true)}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-[#4F8EF7] hover:bg-[#6EA3FF] text-white text-sm font-medium rounded-lg transition-colors"
            >
              <Plus size={15} />
              <span className="hidden sm:inline">记录交易</span>
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-4 pb-24 pt-6">
        {/* Portfolio summary */}
        <section className="mb-6">
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
              {portfolio.holdings.length > 0 && (
                <div className="mt-5 pt-4 border-t border-[#1E2D42]">
                  <div className="flex gap-1 h-2 rounded-full overflow-hidden">
                    {portfolio.holdings.map((h) => (
                      <div key={h.ticker} title={`${h.ticker}: ${h.portfolioPct.toFixed(1)}%`}
                        className="h-full first:rounded-l-full last:rounded-r-full opacity-80 hover:opacity-100 transition-opacity"
                        style={{ width: `${h.portfolioPct}%`, backgroundColor: stringToColor(h.ticker) }} />
                    ))}
                  </div>
                  <div className="flex flex-wrap gap-x-4 gap-y-1 mt-3">
                    {portfolio.holdings.slice(0, 6).map((h) => (
                      <div key={h.ticker} className="flex items-center gap-1.5 text-xs text-[#6B7E9C]">
                        <div className="w-2 h-2 rounded-full" style={{ backgroundColor: stringToColor(h.ticker) }} />
                        <span className="font-mono">{h.ticker}</span>
                        <span>{h.portfolioPct.toFixed(1)}%</span>
                      </div>
                    ))}
                    {portfolio.holdings.length > 6 && (
                      <span className="text-xs text-[#3A4E6A]">+{portfolio.holdings.length - 6} more</span>
                    )}
                  </div>
                </div>
              )}
            </div>
          ) : null}
        </section>

        {/* Tab switcher */}
        <div className="flex gap-1 mb-4 p-1 bg-[#0F1520] border border-[#1E2D42] rounded-xl w-fit">
          {(['holdings', 'transactions'] as const).map((t) => (
            <button key={t} onClick={() => setTab(t)}
              className={`px-4 py-1.5 text-sm rounded-lg transition-all ${
                tab === t ? 'bg-[#172033] text-[#E8EDFB] font-medium' : 'text-[#6B7E9C] hover:text-[#E8EDFB]'
              }`}
            >
              {TAB_LABELS[t]}
              <span className="ml-1.5 text-xs text-[#3A4E6A]">
                ({t === 'holdings' ? (portfolio?.holdings.length ?? 0) : transactions.length})
              </span>
            </button>
          ))}
        </div>

        {/* Filter bar — only shown on Holdings tab */}
        {tab === 'holdings' && (portfolio?.holdings.length ?? 0) > 0 && (
          <div className="mb-3 bg-[#0F1520] border border-[#1E2D42] rounded-2xl p-3 sm:p-4 space-y-3">
            {/* Row 1: search + sort direction */}
            <div className="flex gap-2">
              <div className="relative flex-1">
                <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#6B7E9C]" />
                <input
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                  placeholder="搜索股票名或代码…"
                  className="w-full pl-8 pr-8 py-2 rounded-lg bg-[#141C2C] border border-[#1E2D42] text-sm focus:outline-none focus:border-[#4F8EF7] placeholder:text-[#3A4E6A]"
                />
                {search && (
                  <button onClick={() => setSearch('')}
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[#6B7E9C] hover:text-[#E8EDFB]">
                    <X size={13} />
                  </button>
                )}
              </div>
              <button
                onClick={() => setSortDir(d => d === 'desc' ? 'asc' : 'desc')}
                title={sortDir === 'desc' ? '从大到小' : '从小到大'}
                className="px-3 py-2 rounded-lg bg-[#141C2C] border border-[#1E2D42] text-[#6B7E9C] hover:text-[#E8EDFB] hover:border-[#4F8EF7] transition-colors text-xs flex items-center gap-1.5"
              >
                <ArrowUpDown size={13} />
                <span className="hidden sm:inline">{sortDir === 'desc' ? '降序' : '升序'}</span>
              </button>
            </div>

            {/* Row 2: sort by + min filters */}
            <div className="flex flex-wrap gap-2 items-center">
              {/* Sort by */}
              <div className="flex items-center gap-1 flex-wrap">
                <span className="text-xs text-[#6B7E9C] mr-0.5">排序:</span>
                {SORT_OPTIONS.map(opt => (
                  <button key={opt.key} onClick={() => setSortBy(opt.key)}
                    className={`px-2.5 py-1 rounded-lg text-xs transition-all ${
                      sortBy === opt.key
                        ? 'bg-[#4F8EF7]/20 text-[#4F8EF7] border border-[#4F8EF7]/40'
                        : 'text-[#6B7E9C] hover:text-[#E8EDFB] hover:bg-[#172033]'
                    }`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>

              <div className="h-4 w-px bg-[#1E2D42] hidden sm:block" />

              {/* Min value */}
              <div className="flex items-center gap-1">
                <span className="text-xs text-[#6B7E9C] mr-0.5">最小市值:</span>
                {MIN_VALUE_OPTIONS.map(opt => (
                  <button key={opt.value} onClick={() => setMinValue(opt.value)}
                    className={`px-2.5 py-1 rounded-lg text-xs transition-all ${
                      minValue === opt.value
                        ? 'bg-[#4F8EF7]/20 text-[#4F8EF7] border border-[#4F8EF7]/40'
                        : 'text-[#6B7E9C] hover:text-[#E8EDFB] hover:bg-[#172033]'
                    }`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>

              <div className="h-4 w-px bg-[#1E2D42] hidden sm:block" />

              {/* Min alloc */}
              <div className="flex items-center gap-1">
                <span className="text-xs text-[#6B7E9C] mr-0.5">最小占比:</span>
                {MIN_ALLOC_OPTIONS.map(opt => (
                  <button key={opt.value} onClick={() => setMinAlloc(opt.value)}
                    className={`px-2.5 py-1 rounded-lg text-xs transition-all ${
                      minAlloc === opt.value
                        ? 'bg-[#4F8EF7]/20 text-[#4F8EF7] border border-[#4F8EF7]/40'
                        : 'text-[#6B7E9C] hover:text-[#E8EDFB] hover:bg-[#172033]'
                    }`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Active filter summary */}
            {hasFilter && (
              <div className="flex items-center justify-between pt-1 border-t border-[#1E2D42]/60">
                <span className="text-xs text-[#6B7E9C]">
                  显示 <span className="text-[#E8EDFB] font-medium">{filteredHoldings.length}</span> /
                  {portfolio?.holdings.length} 只股票
                </span>
                <button
                  onClick={() => { setSearch(''); setMinValue(0); setMinAlloc(0); }}
                  className="text-xs text-rose-400 hover:text-rose-300 transition-colors"
                >
                  清除筛选
                </button>
              </div>
            )}
          </div>
        )}

        {/* Content */}
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
      </main>

      <button
        onClick={() => setModal(true)}
        className="fixed bottom-6 right-6 sm:hidden w-14 h-14 bg-[#4F8EF7] hover:bg-[#6EA3FF] rounded-full shadow-lg shadow-[#4F8EF7]/30 flex items-center justify-center text-white transition-all active:scale-95 z-30"
      >
        <Plus size={22} />
      </button>

      {modal && <TransactionModal onClose={() => setModal(false)} onSaved={load} />}
    </div>
  );
}

function stringToColor(str: string): string {
  const colors = ['#4F8EF7', '#22C55E', '#F59E0B', '#A855F7', '#EC4899', '#14B8A6', '#F97316', '#06B6D4'];
  let hash = 0;
  for (let i = 0; i < str.length; i++) hash = str.charCodeAt(i) + ((hash << 5) - hash);
  return colors[Math.abs(hash) % colors.length];
}
