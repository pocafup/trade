'use client';
import { useState, useEffect, useCallback } from 'react';
import { Plus, RefreshCw, TrendingUp, TrendingDown, BarChart3 } from 'lucide-react';
import HoldingsTable from '@/components/HoldingsTable';
import TransactionList from '@/components/TransactionList';
import TransactionModal from '@/components/TransactionModal';

interface Summary { totalValue: number; totalCost: number; totalPnl: number; totalPnlPct: number }
interface Holding { ticker: string; name: string; shares: number; avgCost: number; currentPrice: number; currentValue: number; pnl: number; pnlPct: number; dayChange: number; dayChangePct: number; portfolioPct: number }

function fmt(n: number) {
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export default function Dashboard() {
  const [portfolio, setPortfolio] = useState<{ holdings: Holding[]; summary: Summary } | null>(null);
  const [transactions, setTransactions] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState(false);
  const [tab, setTab] = useState<'holdings' | 'transactions'>('holdings');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [pRes, tRes] = await Promise.all([
        fetch('/api/portfolio'),
        fetch('/api/transactions'),
      ]);
      setPortfolio(await pRes.json());
      setTransactions(await tRes.json());
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const s = portfolio?.summary;
  const pos = (s?.totalPnl ?? 0) >= 0;

  return (
    <div className="min-h-screen bg-[#080B14]">
      {/* Top bar */}
      <header className="sticky top-0 z-30 bg-[#080B14]/90 backdrop-blur border-b border-[#1E2D42]">
        <div className="max-w-5xl mx-auto px-4 h-14 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <BarChart3 size={18} className="text-[#4F8EF7]" />
            <span className="font-semibold text-sm tracking-tight">Trade Tracker</span>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={load} className="p-2 rounded-lg hover:bg-[#172033] text-[#6B7E9C] hover:text-[#E8EDFB] transition-colors">
              <RefreshCw size={15} className={loading ? 'animate-spin' : ''} />
            </button>
            <button
              onClick={() => setModal(true)}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-[#4F8EF7] hover:bg-[#6EA3FF] text-white text-sm font-medium rounded-lg transition-colors"
            >
              <Plus size={15} />
              <span className="hidden sm:inline">Add Trade</span>
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
                  <p className="text-xs text-[#6B7E9C] mb-1 uppercase tracking-wider">Portfolio Value</p>
                  <p className="text-3xl sm:text-4xl font-bold font-mono tracking-tight">
                    ${fmt(s.totalValue)}
                  </p>
                </div>
                <div className={`flex items-center gap-2 pb-1 ${pos ? 'text-emerald-400' : 'text-rose-400'}`}>
                  {pos ? <TrendingUp size={16} /> : <TrendingDown size={16} />}
                  <span className="font-mono text-lg font-semibold">
                    {pos ? '+' : ''}${fmt(s.totalPnl)}
                  </span>
                  <span className="font-mono text-sm opacity-80">
                    ({pos ? '+' : ''}{fmt(s.totalPnlPct)}%)
                  </span>
                </div>
              </div>

              {portfolio.holdings.length > 0 && (
                <div className="mt-5 pt-4 border-t border-[#1E2D42]">
                  <div className="flex gap-1 h-2 rounded-full overflow-hidden">
                    {portfolio.holdings.map((h) => (
                      <div
                        key={h.ticker}
                        title={`${h.ticker}: ${h.portfolioPct.toFixed(1)}%`}
                        className="h-full first:rounded-l-full last:rounded-r-full opacity-80 hover:opacity-100 transition-opacity"
                        style={{ width: `${h.portfolioPct}%`, backgroundColor: stringToColor(h.ticker) }}
                      />
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
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`px-4 py-1.5 text-sm rounded-lg capitalize transition-all ${
                tab === t ? 'bg-[#172033] text-[#E8EDFB] font-medium' : 'text-[#6B7E9C] hover:text-[#E8EDFB]'
              }`}
            >
              {t}
              {t === 'holdings' && portfolio && (
                <span className="ml-1.5 text-xs text-[#3A4E6A]">({portfolio.holdings.length})</span>
              )}
              {t === 'transactions' && (
                <span className="ml-1.5 text-xs text-[#3A4E6A]">({transactions.length})</span>
              )}
            </button>
          ))}
        </div>

        {/* Content */}
        <div className="bg-[#0F1520] border border-[#1E2D42] rounded-2xl p-4 sm:p-5">
          {tab === 'holdings' ? (
            loading && !portfolio ? (
              <div className="space-y-3">
                {[...Array(3)].map((_, i) => (
                  <div key={i} className="h-16 rounded-xl bg-[#172033] animate-pulse" />
                ))}
              </div>
            ) : (
              <HoldingsTable holdings={portfolio?.holdings ?? []} />
            )
          ) : (
            <TransactionList transactions={transactions} onDeleted={load} />
          )}
        </div>
      </main>

      {/* Mobile FAB */}
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
