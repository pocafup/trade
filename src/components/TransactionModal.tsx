'use client';
import { useState, useEffect, useRef } from 'react';
import { X, Search, TrendingUp, TrendingDown } from 'lucide-react';

interface SearchResult { symbol: string; name: string; exchange: string }

interface Props {
  onClose: () => void;
  onSaved: () => void;
}

export default function TransactionModal({ onClose, onSaved }: Props) {
  const [type, setType] = useState<'buy' | 'sell'>('buy');
  const [ticker, setTicker] = useState('');
  const [tickerName, setTickerName] = useState('');
  const [quantity, setQuantity] = useState('');
  const [price, setPrice] = useState('');
  const [date, setDate] = useState(new Date().toISOString().split('T')[0]);
  const [notes, setNotes] = useState('');
  const [search, setSearch] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [step, setStep] = useState<'search' | 'form'>('search');
  const searchRef = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => {
    if (search.length < 1) { setResults([]); return; }
    clearTimeout(searchRef.current);
    searchRef.current = setTimeout(async () => {
      setLoading(true);
      try {
        const r = await fetch(`/api/search?q=${encodeURIComponent(search)}`);
        setResults(await r.json());
      } finally {
        setLoading(false);
      }
    }, 300);
  }, [search]);

  async function pickTicker(r: SearchResult) {
    setTicker(r.symbol);
    setTickerName(r.name);
    setStep('form');
    try {
      const res = await fetch(`/api/stock/${r.symbol}`);
      const data = await res.json();
      const p = data?.quote?.regularMarketPrice;
      if (p) setPrice(String(p.toFixed(2)));
    } catch {}
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      await fetch('/api/transactions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ticker, name: tickerName, type, quantity: +quantity, price: +price, date, notes }),
      });
      onSaved();
      onClose();
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-full sm:max-w-md bg-[#0F1520] border border-[#1E2D42] rounded-t-2xl sm:rounded-2xl shadow-2xl">
        <div className="flex items-center justify-between p-5 border-b border-[#1E2D42]">
          <h2 className="text-base font-semibold">记录交易</h2>
          <button onClick={onClose} className="p-1 rounded-lg hover:bg-[#172033] transition-colors">
            <X size={18} className="text-[#6B7E9C]" />
          </button>
        </div>

        {step === 'search' ? (
          <div className="p-5">
            <p className="text-sm text-[#6B7E9C] mb-3">搜索股票名称或代码</p>
            <div className="relative">
              <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#6B7E9C]" />
              <input
                autoFocus
                value={search}
                onChange={(e) => setSearch(e.target.value.toUpperCase())}
                placeholder="AAPL、NVDA、TSLA…"
                className="w-full pl-9 pr-4 py-2.5 rounded-lg bg-[#141C2C] border border-[#1E2D42] text-sm font-mono focus:outline-none focus:border-[#4F8EF7] placeholder:text-[#3A4E6A]"
              />
            </div>
            <div className="mt-2 space-y-0.5 max-h-56 overflow-y-auto">
              {loading && <p className="py-3 text-center text-sm text-[#6B7E9C]">搜索中…</p>}
              {results.map((r) => (
                <button
                  key={r.symbol}
                  onClick={() => pickTicker(r)}
                  className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg hover:bg-[#172033] active:bg-[#172033] text-left transition-colors"
                >
                  <span className="font-mono text-sm font-medium text-[#4F8EF7] w-16 shrink-0">{r.symbol}</span>
                  <span className="text-sm text-[#8B9CC0] truncate">{r.name}</span>
                  <span className="ml-auto text-xs text-[#3A4E6A] shrink-0">{r.exchange}</span>
                </button>
              ))}
            </div>
          </div>
        ) : (
          <form onSubmit={submit} className="p-5 space-y-4">
            <div className="flex items-center gap-2 mb-1">
              <button type="button" onClick={() => setStep('search')}
                className="text-xs text-[#6B7E9C] hover:text-[#E8EDFB] transition-colors">← 返回</button>
              <span className="font-mono text-sm font-semibold text-[#4F8EF7]">{ticker}</span>
              <span className="text-sm text-[#6B7E9C] truncate">{tickerName}</span>
            </div>

            {/* 买入 / 卖出 切换 */}
            <div className="grid grid-cols-2 gap-1 p-1 bg-[#141C2C] rounded-xl">
              {(['buy', 'sell'] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setType(t)}
                  className={`py-2 rounded-lg text-sm font-medium transition-all flex items-center justify-center gap-1.5 ${
                    type === t
                      ? t === 'buy'
                        ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                        : 'bg-rose-500/20 text-rose-400 border border-rose-500/30'
                      : 'text-[#6B7E9C] hover:text-[#E8EDFB]'
                  }`}
                >
                  {t === 'buy' ? <TrendingUp size={14} /> : <TrendingDown size={14} />}
                  {t === 'buy' ? '买入' : '卖出'}
                </button>
              ))}
            </div>

            <div className="grid grid-cols-2 gap-3">
              <label className="block">
                <span className="text-xs text-[#6B7E9C] mb-1.5 block">股数</span>
                <input
                  required
                  type="number"
                  inputMode="decimal"
                  step="any"
                  min="0.0001"
                  value={quantity}
                  onChange={(e) => setQuantity(e.target.value)}
                  placeholder="100"
                  className="w-full px-3 py-2.5 rounded-lg bg-[#141C2C] border border-[#1E2D42] text-sm font-mono focus:outline-none focus:border-[#4F8EF7]"
                />
              </label>
              <label className="block">
                <span className="text-xs text-[#6B7E9C] mb-1.5 block">单价（美元）</span>
                <input
                  required
                  type="number"
                  inputMode="decimal"
                  step="any"
                  min="0"
                  value={price}
                  onChange={(e) => setPrice(e.target.value)}
                  placeholder="0.00"
                  className="w-full px-3 py-2.5 rounded-lg bg-[#141C2C] border border-[#1E2D42] text-sm font-mono focus:outline-none focus:border-[#4F8EF7]"
                />
              </label>
            </div>

            <label className="block">
              <span className="text-xs text-[#6B7E9C] mb-1.5 block">交易日期</span>
              <input
                required
                type="date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
                className="w-full px-3 py-2.5 rounded-lg bg-[#141C2C] border border-[#1E2D42] text-sm focus:outline-none focus:border-[#4F8EF7]"
              />
            </label>

            {quantity && price && (
              <div className="text-xs text-[#6B7E9C] bg-[#141C2C] rounded-lg px-3 py-2">
                合计：<span className="font-mono text-[#E8EDFB]">
                  ${(+quantity * +price).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </span>
              </div>
            )}

            <label className="block">
              <span className="text-xs text-[#6B7E9C] mb-1.5 block">备注（可选）</span>
              <input
                type="text"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="如：财报前布局"
                className="w-full px-3 py-2.5 rounded-lg bg-[#141C2C] border border-[#1E2D42] text-sm focus:outline-none focus:border-[#4F8EF7]"
              />
            </label>

            <button
              type="submit"
              disabled={saving}
              className={`w-full py-3 rounded-xl text-sm font-semibold transition-all ${
                type === 'buy'
                  ? 'bg-emerald-500 hover:bg-emerald-400 active:bg-emerald-600 text-white'
                  : 'bg-rose-500 hover:bg-rose-400 active:bg-rose-600 text-white'
              } disabled:opacity-50`}
            >
              {saving ? '保存中…' : type === 'buy' ? '记录买入' : '记录卖出'}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
