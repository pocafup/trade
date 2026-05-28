'use client';
import { useState, useEffect, useRef } from 'react';
import Link from 'next/link';
import { TrendingUp, TrendingDown, SlidersHorizontal, Check } from 'lucide-react';

interface Holding {
  ticker: string; name: string; shares: number; avgCost: number;
  currentPrice: number; currentValue: number; pnl: number; pnlPct: number;
  dayChange: number; dayChangePct: number; portfolioPct: number;
}

type ColKey = 'shares' | 'cost' | 'price' | 'value' | 'pnl' | 'alloc';

const COL_DEFS: { key: ColKey; label: string }[] = [
  { key: 'shares', label: '持股数' },
  { key: 'cost',   label: '成本价' },
  { key: 'price',  label: '现价'   },
  { key: 'value',  label: '市值'   },
  { key: 'pnl',    label: '盈亏'   },
  { key: 'alloc',  label: '占比'   },
];
const DEFAULT_COLS: ColKey[] = ['shares', 'cost', 'price', 'value', 'pnl', 'alloc'];
const LS_KEY = 'holdings-cols';

function fmt(n: number, dec = 2) {
  return n.toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec });
}
function PctBadge({ v }: { v: number }) {
  const pos = v >= 0;
  return (
    <span className={`inline-flex items-center gap-0.5 text-xs font-medium ${pos ? 'text-emerald-400' : 'text-rose-400'}`}>
      {pos ? <TrendingUp size={11} /> : <TrendingDown size={11} />}
      {pos ? '+' : ''}{fmt(v)}%
    </span>
  );
}

export default function HoldingsTable({ holdings }: { holdings: Holding[] }) {
  const [visible, setVisible] = useState<Set<ColKey>>(new Set(DEFAULT_COLS));
  const [pickerOpen, setPickerOpen] = useState(false);
  const pickerRef = useRef<HTMLDivElement>(null);

  // Load from localStorage after mount
  useEffect(() => {
    try {
      const saved = localStorage.getItem(LS_KEY);
      if (saved) {
        const parsed: ColKey[] = JSON.parse(saved);
        if (parsed.length) setVisible(new Set(parsed));
      }
    } catch {}
  }, []);

  // Close picker on outside click
  useEffect(() => {
    function handler(e: MouseEvent) {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) setPickerOpen(false);
    }
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  function toggleCol(key: ColKey) {
    setVisible(prev => {
      const next = new Set(prev);
      if (next.has(key)) {
        if (next.size <= 1) return prev; // always keep at least 1
        next.delete(key);
      } else {
        next.add(key);
      }
      try { localStorage.setItem(LS_KEY, JSON.stringify([...next])); } catch {}
      return next;
    });
  }

  if (!holdings.length) {
    return <div className="text-center py-16 text-[#6B7E9C] text-sm">暂无持仓，点击上方「记录交易」添加第一笔。</div>;
  }

  const show = (k: ColKey) => visible.has(k);

  return (
    <>
      {/* 桌面表格 */}
      <div className="hidden md:block overflow-x-auto">
        <div className="flex items-center justify-between mb-3">
          <span className="text-xs text-[#3A4E6A]">{holdings.length} 只股票</span>
          <div className="relative" ref={pickerRef}>
            <button onClick={() => setPickerOpen(o => !o)}
              className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs transition-colors border ${
                pickerOpen ? 'bg-[#4F8EF7]/10 text-[#4F8EF7] border-[#4F8EF7]/40' : 'text-[#6B7E9C] border-[#1E2D42] hover:text-[#E8EDFB] hover:border-[#2A3F60]'
              }`}>
              <SlidersHorizontal size={11} />
              自定义列
            </button>
            {pickerOpen && (
              <div className="absolute right-0 top-full mt-1.5 w-36 bg-[#141C2C] border border-[#1E2D42] rounded-xl shadow-xl z-20 overflow-hidden">
                {COL_DEFS.map(({ key, label }) => (
                  <button key={key} onClick={() => toggleCol(key)}
                    className="w-full flex items-center justify-between px-3.5 py-2.5 hover:bg-[#172033] transition-colors text-sm">
                    <span className={visible.has(key) ? 'text-[#E8EDFB]' : 'text-[#6B7E9C]'}>{label}</span>
                    {visible.has(key) && <Check size={12} className="text-[#4F8EF7]" />}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        <table className="w-full text-sm">
          <thead>
            <tr className="text-xs text-[#6B7E9C] border-b border-[#1E2D42]">
              <th className="text-left pb-3 pr-4 font-medium">股票</th>
              {show('shares') && <th className="text-right pb-3 px-4 font-medium">持股数</th>}
              {show('cost')   && <th className="text-right pb-3 px-4 font-medium">成本价</th>}
              {show('price')  && <th className="text-right pb-3 px-4 font-medium">现价</th>}
              {show('value')  && <th className="text-right pb-3 px-4 font-medium">市值</th>}
              {show('pnl')    && <th className="text-right pb-3 px-4 font-medium">盈亏</th>}
              {show('alloc')  && <th className="text-right pb-3 pl-4 font-medium">占比</th>}
            </tr>
          </thead>
          <tbody className="divide-y divide-[#1E2D42]/50">
            {holdings.map(h => (
              <tr key={h.ticker} className="hover:bg-[#172033]/50 transition-colors group">
                <td className="py-3.5 pr-4">
                  <Link href={`/stock/${h.ticker}`} className="flex items-center gap-3 group-hover:text-[#4F8EF7] transition-colors">
                    <div className="w-8 h-8 rounded-lg bg-[#172033] flex items-center justify-center text-xs font-mono font-bold text-[#4F8EF7] shrink-0">
                      {h.ticker.slice(0, 2)}
                    </div>
                    <div>
                      <div className="font-semibold font-mono text-sm">{h.ticker}</div>
                      <div className="text-xs text-[#6B7E9C] truncate max-w-[160px]">{h.name}</div>
                    </div>
                  </Link>
                </td>
                {show('shares') && <td className="py-3.5 px-4 text-right font-mono text-sm">{fmt(h.shares, 4).replace(/\.?0+$/, '')}</td>}
                {show('cost')   && <td className="py-3.5 px-4 text-right font-mono text-sm text-[#6B7E9C]">${fmt(h.avgCost)}</td>}
                {show('price')  && (
                  <td className="py-3.5 px-4 text-right">
                    <div className="font-mono text-sm">${fmt(h.currentPrice)}</div>
                    <PctBadge v={h.dayChangePct} />
                  </td>
                )}
                {show('value')  && <td className="py-3.5 px-4 text-right font-mono text-sm font-medium">${fmt(h.currentValue)}</td>}
                {show('pnl')    && (
                  <td className="py-3.5 px-4 text-right">
                    <div className={`font-mono text-sm font-medium ${h.pnl >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                      {h.pnl >= 0 ? '+' : ''}${fmt(h.pnl)}
                    </div>
                    <PctBadge v={h.pnlPct} />
                  </td>
                )}
                {show('alloc')  && (
                  <td className="py-3.5 pl-4 text-right">
                    <div className="flex items-center justify-end gap-2">
                      <div className="w-16 h-1.5 bg-[#172033] rounded-full overflow-hidden">
                        <div className="h-full bg-[#4F8EF7] rounded-full" style={{ width: `${Math.min(h.portfolioPct, 100)}%` }} />
                      </div>
                      <span className="font-mono text-xs text-[#6B7E9C] w-10 text-right">{fmt(h.portfolioPct, 1)}%</span>
                    </div>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* 手机卡片 */}
      <div className="md:hidden space-y-2">
        {holdings.map(h => (
          <Link key={h.ticker} href={`/stock/${h.ticker}`}
            className="block p-4 rounded-xl bg-[#0F1520] border border-[#1E2D42] hover:border-[#2A3F60] active:border-[#4F8EF7] transition-colors">
            <div className="flex items-start justify-between mb-3">
              <div className="flex items-center gap-2.5">
                <div className="w-9 h-9 rounded-xl bg-[#172033] flex items-center justify-center text-xs font-mono font-bold text-[#4F8EF7]">
                  {h.ticker.slice(0, 2)}
                </div>
                <div>
                  <div className="font-semibold font-mono text-sm">{h.ticker}</div>
                  <div className="text-xs text-[#6B7E9C] max-w-[160px] truncate">{h.name}</div>
                </div>
              </div>
              <div className="text-right">
                <div className="font-mono text-sm font-semibold">${fmt(h.currentValue)}</div>
                <div className="text-xs text-[#6B7E9C]">{fmt(h.portfolioPct, 1)}% 占比</div>
              </div>
            </div>
            <div className="grid grid-cols-3 gap-2 pt-3 border-t border-[#1E2D42]/60 text-xs">
              <div>
                <div className="text-[#6B7E9C] mb-0.5">持股</div>
                <div className="font-mono">{fmt(h.shares, 2)}</div>
              </div>
              <div>
                <div className="text-[#6B7E9C] mb-0.5">成本</div>
                <div className="font-mono">${fmt(h.avgCost)}</div>
              </div>
              <div>
                <div className="text-[#6B7E9C] mb-0.5">盈亏</div>
                <div className={`font-mono font-medium ${h.pnl >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                  {h.pnl >= 0 ? '+' : ''}${fmt(h.pnl)}
                </div>
              </div>
            </div>
          </Link>
        ))}
      </div>
    </>
  );
}
