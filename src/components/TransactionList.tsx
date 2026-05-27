'use client';
import { useState } from 'react';
import { Trash2, TrendingUp, TrendingDown } from 'lucide-react';
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

function fmt(n: number) {
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export default function TransactionList({ transactions, onDeleted }: { transactions: Txn[]; onDeleted: () => void }) {
  const [deleting, setDeleting] = useState<number | null>(null);

  async function del(id: number) {
    if (!confirm('Delete this transaction?')) return;
    setDeleting(id);
    await fetch(`/api/transactions/${id}`, { method: 'DELETE' });
    setDeleting(null);
    onDeleted();
  }

  if (!transactions.length) {
    return <div className="text-center py-10 text-[#6B7E9C] text-sm">No transactions yet.</div>;
  }

  return (
    <div className="space-y-1">
      {transactions.map((t) => (
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
                {t.type === 'buy' ? 'Bought' : 'Sold'} {t.quantity % 1 === 0 ? t.quantity : t.quantity.toFixed(4)} shares @ ${fmt(t.price)}
              </span>
            </div>
            <div className="flex items-center gap-2 mt-0.5">
              <span className="text-xs text-[#3A4E6A]">
                {format(new Date(t.date + 'T00:00:00'), 'MMM d, yyyy')}
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
            className="opacity-0 group-hover:opacity-100 p-1.5 rounded-lg hover:bg-rose-500/15 text-rose-400 transition-all shrink-0"
          >
            <Trash2 size={13} />
          </button>
        </div>
      ))}
    </div>
  );
}
