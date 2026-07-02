'use client';
import { useState, useEffect, useRef } from 'react';
import { X, Search, TrendingUp, TrendingDown } from 'lucide-react';
import { round8, QTY_EPS } from '@/lib/lots';

interface SearchResult { symbol: string; name: string; exchange: string }

/** /api/lots 返回的开放批次：某笔买入还剩多少股没卖 */
interface OpenLotView { buy_txn_id: number; date: string; price: number; quantity: number; remaining: number }

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
  const [error, setError] = useState('');
  // 卖出批次选择：lots = 该股票的开放批次；sel = 勾选的批次 → 卖出数量（输入框字符串）
  const [lots, setLots] = useState<OpenLotView[] | null>(null);
  const [lotsLoading, setLotsLoading] = useState(false);
  const [lotsVersion, setLotsVersion] = useState(0); // 自增触发重新拉取（如提交被拒后剩余量已过期）
  const [sel, setSel] = useState<Record<number, string>>({});
  const searchRef = useRef<ReturnType<typeof setTimeout>>();

  // 进入卖出表单时拉取开放批次，默认全选满额（即初始状态就是"全部卖出"）
  useEffect(() => {
    if (step !== 'form' || type !== 'sell' || !ticker) { setLots(null); setSel({}); return; }
    let cancelled = false;
    setLotsLoading(true);
    fetch(`/api/lots?ticker=${encodeURIComponent(ticker)}`)
      .then((r) => r.json())
      .then((data) => {
        if (cancelled) return;
        const ls: OpenLotView[] = data?.lots ?? [];
        setLots(ls);
        setSel(Object.fromEntries(ls.map((l) => [l.buy_txn_id, String(l.remaining)])));
      })
      .catch(() => { if (!cancelled) setLots([]); })
      .finally(() => { if (!cancelled) setLotsLoading(false); });
    return () => { cancelled = true; };
  }, [step, type, ticker, lotsVersion]);

  // 买入日期晚于卖出日期的批次不可选（当天可以）
  const eligibleLots = (lots ?? []).filter((l) => l.date <= date);
  const selectedAllocs = eligibleLots
    .filter((l) => sel[l.buy_txn_id] !== undefined)
    .map((l) => ({ buy_txn_id: l.buy_txn_id, quantity: parseFloat(sel[l.buy_txn_id]) || 0 }));
  const totalSelected = round8(selectedAllocs.reduce((s, a) => s + a.quantity, 0));
  const hasInvalidSel = selectedAllocs.some((a) => {
    const lot = eligibleLots.find((l) => l.buy_txn_id === a.buy_txn_id);
    return !(a.quantity > 0) || !lot || a.quantity > lot.remaining + QTY_EPS;
  });
  // 有开放批次时走勾选流程；没有（数据异常或新股票误选卖出）保留自由输入，由服务端拒绝
  const sellWithLots = type === 'sell' && lots !== null && lots.length > 0;
  const effectiveQty = sellWithLots ? totalSelected : parseFloat(quantity) || 0;

  function toggleLot(l: OpenLotView) {
    setSel((prev) => {
      const next = { ...prev };
      if (next[l.buy_txn_id] !== undefined) delete next[l.buy_txn_id];
      else next[l.buy_txn_id] = String(l.remaining);
      return next;
    });
  }

  function selectAll() {
    setSel(Object.fromEntries(eligibleLots.map((l) => [l.buy_txn_id, String(l.remaining)])));
  }

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
    setError('');
    setSaving(true);
    try {
      const body: Record<string, unknown> = {
        ticker, name: tickerName, type,
        quantity: sellWithLots ? totalSelected : +quantity,
        price: +price, date, notes,
      };
      if (sellWithLots) body.allocations = selectedAllocs;

      const res = await fetch('/api/transactions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        setError(d?.error || '保存失败');
        // 批次剩余量可能已被其他操作改变（校验被拒的常见原因），重新拉取
        if (res.status === 400 && type === 'sell') setLotsVersion((v) => v + 1);
        return;
      }
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

            {/* 卖出批次选择：勾选这笔卖出来自哪些买入批次（可部分卖出某一批） */}
            {type === 'sell' && (
              <div className="rounded-xl border border-[#1E2D42] bg-[#141C2C] p-3 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs text-[#6B7E9C]">卖出来源批次</span>
                  {sellWithLots && (
                    <button
                      type="button"
                      onClick={selectAll}
                      className="text-xs text-[#4F8EF7] hover:text-[#7FAFFB] transition-colors"
                    >
                      全部卖出
                    </button>
                  )}
                </div>
                {lotsLoading ? (
                  <p className="py-2 text-center text-xs text-[#6B7E9C]">加载批次中…</p>
                ) : !lots || lots.length === 0 ? (
                  <p className="py-2 text-center text-xs text-[#6B7E9C]">暂无可卖批次</p>
                ) : (
                  <div className="space-y-1 max-h-44 overflow-y-auto">
                    {lots.map((l) => {
                      const ineligible = l.date > date;
                      const checked = !ineligible && sel[l.buy_txn_id] !== undefined;
                      const qtyStr = checked ? sel[l.buy_txn_id] : '';
                      const over = checked && (parseFloat(qtyStr) || 0) > l.remaining + QTY_EPS;
                      return (
                        <div
                          key={l.buy_txn_id}
                          className={`flex items-center gap-2 px-2 py-1.5 rounded-lg ${ineligible ? 'opacity-40' : 'hover:bg-[#172033]'}`}
                        >
                          <input
                            type="checkbox"
                            disabled={ineligible}
                            checked={checked}
                            onChange={() => toggleLot(l)}
                            className="accent-rose-500 shrink-0"
                          />
                          <div className="flex-1 min-w-0 text-xs">
                            <span className="font-mono text-[#E8EDFB]">{l.date}</span>
                            <span className="font-mono text-[#6B7E9C] ml-2">@${l.price.toFixed(2)}</span>
                            <span className="text-[#6B7E9C] ml-2">
                              剩 {l.remaining % 1 === 0 ? l.remaining : l.remaining.toFixed(4)} 股
                            </span>
                            {ineligible && <span className="text-amber-400 ml-2">晚于卖出日期</span>}
                          </div>
                          <input
                            type="number"
                            inputMode="decimal"
                            step="any"
                            min="0.0001"
                            max={l.remaining}
                            disabled={!checked}
                            value={qtyStr}
                            onChange={(e) => setSel((prev) => ({ ...prev, [l.buy_txn_id]: e.target.value }))}
                            className={`w-20 px-2 py-1 rounded bg-[#0F1520] border text-xs font-mono text-right focus:outline-none focus:border-[#4F8EF7] disabled:opacity-30 ${
                              over ? 'border-rose-500' : 'border-[#1E2D42]'
                            }`}
                          />
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}

            <div className="grid grid-cols-2 gap-3">
              <label className="block">
                <span className="text-xs text-[#6B7E9C] mb-1.5 block">
                  股数{sellWithLots && <span className="text-[#3A4E6A]">（勾选批次自动合计）</span>}
                </span>
                <input
                  required
                  type="number"
                  inputMode="decimal"
                  step="any"
                  min="0.0001"
                  value={sellWithLots ? String(totalSelected) : quantity}
                  readOnly={sellWithLots}
                  onChange={(e) => setQuantity(e.target.value)}
                  placeholder="100"
                  className={`w-full px-3 py-2.5 rounded-lg bg-[#141C2C] border border-[#1E2D42] text-sm font-mono focus:outline-none focus:border-[#4F8EF7] ${
                    sellWithLots ? 'opacity-60 cursor-not-allowed' : ''
                  }`}
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

            {effectiveQty > 0 && price && (
              <div className="text-xs text-[#6B7E9C] bg-[#141C2C] rounded-lg px-3 py-2">
                合计：<span className="font-mono text-[#E8EDFB]">
                  ${(effectiveQty * +price).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
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

            {error && (
              <p className="text-xs text-rose-400 bg-rose-500/10 border border-rose-500/20 rounded-lg px-3 py-2">
                {error}
              </p>
            )}

            <button
              type="submit"
              disabled={saving || (sellWithLots && (totalSelected <= 0 || hasInvalidSel))}
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
