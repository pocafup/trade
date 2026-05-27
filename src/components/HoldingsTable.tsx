'use client';
import Link from 'next/link';
import { TrendingUp, TrendingDown } from 'lucide-react';

interface Holding {
  ticker: string;
  name: string;
  shares: number;
  avgCost: number;
  currentPrice: number;
  currentValue: number;
  pnl: number;
  pnlPct: number;
  dayChange: number;
  dayChangePct: number;
  portfolioPct: number;
}

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
  if (!holdings.length) {
    return (
      <div className="text-center py-16 text-[#6B7E9C] text-sm">
        No holdings yet. Add your first trade above.
      </div>
    );
  }

  return (
    <>
      {/* Desktop table */}
      <div className="hidden md:block overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-xs text-[#6B7E9C] border-b border-[#1E2D42]">
              <th className="text-left pb-3 pr-4 font-medium">Stock</th>
              <th className="text-right pb-3 px-4 font-medium">Shares</th>
              <th className="text-right pb-3 px-4 font-medium">Avg Cost</th>
              <th className="text-right pb-3 px-4 font-medium">Price</th>
              <th className="text-right pb-3 px-4 font-medium">Value</th>
              <th className="text-right pb-3 px-4 font-medium">P&L</th>
              <th className="text-right pb-3 pl-4 font-medium">Alloc</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[#1E2D42]/50">
            {holdings.map((h) => (
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
                <td className="py-3.5 px-4 text-right font-mono text-sm">{fmt(h.shares, 4).replace(/\.?0+$/, '')}</td>
                <td className="py-3.5 px-4 text-right font-mono text-sm text-[#6B7E9C]">${fmt(h.avgCost)}</td>
                <td className="py-3.5 px-4 text-right">
                  <div className="font-mono text-sm">${fmt(h.currentPrice)}</div>
                  <PctBadge v={h.dayChangePct} />
                </td>
                <td className="py-3.5 px-4 text-right font-mono text-sm font-medium">${fmt(h.currentValue)}</td>
                <td className="py-3.5 px-4 text-right">
                  <div className={`font-mono text-sm font-medium ${h.pnl >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                    {h.pnl >= 0 ? '+' : ''}${fmt(h.pnl)}
                  </div>
                  <PctBadge v={h.pnlPct} />
                </td>
                <td className="py-3.5 pl-4 text-right">
                  <div className="flex items-center justify-end gap-2">
                    <div className="w-16 h-1.5 bg-[#172033] rounded-full overflow-hidden">
                      <div className="h-full bg-[#4F8EF7] rounded-full" style={{ width: `${Math.min(h.portfolioPct, 100)}%` }} />
                    </div>
                    <span className="font-mono text-xs text-[#6B7E9C] w-10 text-right">{fmt(h.portfolioPct, 1)}%</span>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Mobile cards */}
      <div className="md:hidden space-y-2">
        {holdings.map((h) => (
          <Link key={h.ticker} href={`/stock/${h.ticker}`} className="block p-4 rounded-xl bg-[#0F1520] border border-[#1E2D42] hover:border-[#2A3F60] transition-colors">
            <div className="flex items-start justify-between mb-3">
              <div className="flex items-center gap-2.5">
                <div className="w-9 h-9 rounded-xl bg-[#172033] flex items-center justify-center text-xs font-mono font-bold text-[#4F8EF7]">
                  {h.ticker.slice(0, 2)}
                </div>
                <div>
                  <div className="font-semibold font-mono text-sm">{h.ticker}</div>
                  <div className="text-xs text-[#6B7E9C] max-w-[180px] truncate">{h.name}</div>
                </div>
              </div>
              <div className="text-right">
                <div className="font-mono text-sm font-semibold">${fmt(h.currentValue)}</div>
                <div className="text-xs text-[#6B7E9C]">{fmt(h.portfolioPct, 1)}% of portfolio</div>
              </div>
            </div>
            <div className="grid grid-cols-3 gap-2 pt-3 border-t border-[#1E2D42]/60 text-xs">
              <div>
                <div className="text-[#6B7E9C] mb-0.5">Shares</div>
                <div className="font-mono">{fmt(h.shares, 2)}</div>
              </div>
              <div>
                <div className="text-[#6B7E9C] mb-0.5">Avg Cost</div>
                <div className="font-mono">${fmt(h.avgCost)}</div>
              </div>
              <div>
                <div className="text-[#6B7E9C] mb-0.5">P&L</div>
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
