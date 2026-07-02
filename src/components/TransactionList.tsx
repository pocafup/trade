'use client';
import { useState, useMemo } from 'react';
import { Trash2, TrendingUp, TrendingDown, Search, X } from 'lucide-react';
import { format } from 'date-fns';

interface Txn {
  id: number;
  ticker: string;
  name: string;
  type: 'buy' | 'sell';
  quantity: number;
  price: number;
  date: string;
  notes: string;
}

type DateRange = '1mo' | '3mo' | '1y' | 'all';

const DATE_RANGES: { key: DateRange; label: string }[] = [
  { key: '1mo', label: '1月内' },
  { key: '3mo', label: '3月内' },
  { key: '1y',  label: '1年内' },
  { key: 'all', label: '不限'  },
];

function getCutoff(range: DateRange): string | null {
  const d = new Date();
  if (range === '1mo') d.setMonth(d.getMonth() - 1);
  else if (range === '3mo') d.setMonth(d.getMonth() - 3);
  else if (range === '1y') d.setFullYear(d.getFullYear() - 1);
  else return null;
  return d.toISOString().split('T')[0];
}

function fmt(n: number) {
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export default function TransactionList({ transactions, onDeleted }: { transactions: Txn[]; onDeleted: () => void }) {
  const [deleting, setDeleting] = useState<number | null>(null);
  const [search, setSearch] = useState('');
  const [dateRange, setDateRange] = useState<DateRange>('all');

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const cutoff = getCutoff(dateRange);
    return transactions.filter(t => {
      if (q && !t.ticker.toLowerCase().includes(q) && !t.name.toLowerCase().includes(q)) return false;
      if (cutoff && t.date < cutoff) return false;
      return true;
    });
  }, [transactions, search, dateRange]);

  async function del(id: number) {
    if (!confirm('确定删除这条交易记录？')) return;
    setDeleting(id);
    const res = await fetch(`/api/transactions/${id}`, { method: 'DELETE' });
    setDeleting(null);
    if (!res.ok) {
      // 例如：买入批次已被卖出配对占用（409），需先删除对应卖出
      const d = await res.json().catch(() => ({}));
      alert(d?.error || '删除失败');
      return;
    }
    onDeleted();
  }

  return (
    <div className="space-y-3">
      {/* Search + date filter */}
      <div className="space-y-2">
        <div className="relative">
          <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#6B7E9C]" />
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="搜索股票代码或名称…"
            className="w-full pl-8 pr-8 py-2 rounded-xl bg-[#141C2C] border border-[#1E2D42] text-sm focus:outline-none focus:border-[#4F8EF7] placeholder:text-[#3A4E6A]"
          />
          {search && (
            <button onClick={() => setSearch('')} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[#6B7E9C] hover:text-[#E8EDFB]">
              <X size={13} />
            </button>
          )}
        </div>
        <div className="flex gap-1 items-center">
          <span className="text-xs text-[#6B7E9C] mr-0.5">日期:</span>
          {DATE_RANGES.map(r => (
            <button key={r.key} onClick={() => setDateRange(r.key)}
              className={`px-2.5 py-1 rounded-lg text-xs transition-all ${
                dateRange === r.key
                  ? 'bg-[#4F8EF7]/20 text-[#4F8EF7] border border-[#4F8EF7]/40'
                  : 'text-[#6B7E9C] hover:text-[#E8EDFB] hover:bg-[#172033]'
              }`}>
              {r.label}
            </button>
          ))}
          {(search || dateRange !== 'all') && (
            <span className="ml-auto text-xs text-[#3A4E6A]">
              {filtered.length} / {transactions.length} 条
            </span>
          )}
        </div>
      </div>

      {/* List */}
      {filtered.length === 0 ? (
        <div className="text-center py-10 text-[#6B7E9C] text-sm">
          {transactions.length === 0 ? '暂无交易记录' : '没有符合条件的记录'}
        </div>
      ) : (
        <div className="space-y-1">
          {filtered.map((t) => (
            <div key={t.id} className="flex items-center gap-3 px-3 py-3 rounded-xl hover:bg-[#172033]/50 group transition-colors">
              <div className={`w-7 h-7 rounded-lg flex items-center justify-center shrink-0 ${
                t.type === 'buy' ? 'bg-emerald-500/15 text-emerald-400' : 'bg-rose-500/15 text-rose-400'
              }`}>
                {t.type === 'buy' ? <TrendingUp size={13} /> : <TrendingDown size={13} />}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-baseline gap-1.5">
                  <span className="font-mono text-sm font-semibold">{t.ticker}</span>
                  <span className="text-xs text-[#6B7E9C]">
                    {t.type === 'buy' ? '买入' : '卖出'}{' '}
                    {t.quantity % 1 === 0 ? t.quantity : t.quantity.toFixed(4)} 股 @ ${fmt(t.price)}
                  </span>
                </div>
                <div className="flex items-center gap-2 mt-0.5">
                  <span className="text-xs text-[#3A4E6A]">
                    {format(new Date(t.date + 'T00:00:00'), 'yyyy年M月d日')}
                  </span>
                  {t.notes && <span className="text-xs text-[#3A4E6A] italic truncate max-w-[120px]">· {t.notes}</span>}
                </div>
              </div>
              <div className="text-right shrink-0">
                <div className="font-mono text-sm font-medium">${fmt(t.quantity * t.price)}</div>
              </div>
              <button
                onClick={() => del(t.id)}
                disabled={deleting === t.id}
                className="opacity-30 group-hover:opacity-100 active:opacity-100 p-1.5 rounded-lg hover:bg-rose-500/15 text-rose-400 transition-all shrink-0"
              >
                <Trash2 size={13} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
