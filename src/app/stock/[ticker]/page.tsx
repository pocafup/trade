'use client';
import { useState, useEffect } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { ArrowLeft, TrendingUp, TrendingDown, ExternalLink, Globe, Users, DollarSign } from 'lucide-react';
import { format } from 'date-fns';

function fmt(n: number, dec = 2) {
  return n?.toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec }) ?? '—';
}
function fmtBig(n: number) {
  if (!n) return '—';
  if (n >= 1e12) return `$${(n / 1e12).toFixed(2)}T`;
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  return `$${fmt(n)}`;
}

export default function StockDetail() {
  const { ticker } = useParams<{ ticker: string }>();
  const router = useRouter();
  const [data, setData] = useState<any>(null);
  const [news, setNews] = useState<any[]>([]);
  const [position, setPosition] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function load() {
      setLoading(true);
      try {
        const [stockRes, newsRes, portfolioRes] = await Promise.all([
          fetch(`/api/stock/${ticker}`),
          fetch(`/api/news/${ticker}`),
          fetch('/api/portfolio'),
        ]);
        const stockData = await stockRes.json();
        setData(stockData);
        setNews(await newsRes.json());
        const pf = await portfolioRes.json();
        setPosition(pf.holdings?.find((h: any) => h.ticker === ticker) ?? null);
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [ticker]);

  const q = data?.quote;
  const fin = data?.summary?.financialData;
  const stats = data?.summary?.defaultKeyStatistics;
  const profile = data?.summary?.summaryProfile;

  const price = q?.regularMarketPrice ?? 0;
  const change = q?.regularMarketChange ?? 0;
  const changePct = q?.regularMarketChangePercent ?? 0;
  const pos = change >= 0;

  return (
    <div className="min-h-screen bg-[#080B14]">
      {/* Header */}
      <header className="sticky top-0 z-30 bg-[#080B14]/90 backdrop-blur border-b border-[#1E2D42]">
        <div className="max-w-3xl mx-auto px-4 h-14 flex items-center gap-3">
          <button onClick={() => router.back()} className="p-2 rounded-lg hover:bg-[#172033] text-[#6B7E9C] hover:text-[#E8EDFB] transition-colors">
            <ArrowLeft size={16} />
          </button>
          <span className="font-mono font-bold text-[#4F8EF7]">{ticker}</span>
          {q && <span className="text-sm text-[#6B7E9C] truncate">{q.longName || q.shortName}</span>}
        </div>
      </header>

      <main className="max-w-3xl mx-auto px-4 pb-12 pt-6 space-y-4">
        {loading ? (
          <div className="space-y-4">
            {[...Array(4)].map((_, i) => <div key={i} className="h-28 rounded-2xl bg-[#0F1520] animate-pulse" />)}
          </div>
        ) : (
          <>
            {/* Price card */}
            {q && (
              <div className="rounded-2xl bg-[#0F1520] border border-[#1E2D42] p-5">
                <p className="text-xs text-[#6B7E9C] mb-1">Current Price</p>
                <div className="flex items-end gap-4 flex-wrap">
                  <p className="text-4xl font-bold font-mono">${fmt(price)}</p>
                  <div className={`flex items-center gap-1.5 pb-1 text-lg font-mono ${pos ? 'text-emerald-400' : 'text-rose-400'}`}>
                    {pos ? <TrendingUp size={18} /> : <TrendingDown size={18} />}
                    {pos ? '+' : ''}{fmt(change)} ({pos ? '+' : ''}{fmt(changePct)}%)
                  </div>
                </div>
                {q.marketState && (
                  <p className="mt-2 text-xs text-[#3A4E6A]">Market: {q.marketState}</p>
                )}
              </div>
            )}

            {/* Your position (if holding) */}
            {position && (
              <div className="rounded-2xl bg-[#172033] border border-[#2A3F60] p-5">
                <p className="text-xs text-[#4F8EF7] mb-3 font-medium uppercase tracking-wider">Your Position</p>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                  <div>
                    <p className="text-xs text-[#6B7E9C] mb-1">Shares</p>
                    <p className="font-mono font-semibold">{fmt(position.shares, 4).replace(/\.?0+$/, '')}</p>
                  </div>
                  <div>
                    <p className="text-xs text-[#6B7E9C] mb-1">Avg Cost</p>
                    <p className="font-mono font-semibold">${fmt(position.avgCost)}</p>
                  </div>
                  <div>
                    <p className="text-xs text-[#6B7E9C] mb-1">Market Value</p>
                    <p className="font-mono font-semibold">${fmt(position.currentValue)}</p>
                  </div>
                  <div>
                    <p className="text-xs text-[#6B7E9C] mb-1">Total P&L</p>
                    <p className={`font-mono font-semibold ${position.pnl >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                      {position.pnl >= 0 ? '+' : ''}${fmt(position.pnl)}
                      <span className="text-xs ml-1 opacity-75">({position.pnl >= 0 ? '+' : ''}{fmt(position.pnlPct)}%)</span>
                    </p>
                  </div>
                </div>
              </div>
            )}

            {/* Key stats */}
            {(q || fin || stats) && (
              <div className="rounded-2xl bg-[#0F1520] border border-[#1E2D42] p-5">
                <p className="text-xs text-[#6B7E9C] mb-4 font-medium uppercase tracking-wider">Key Stats</p>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-4">
                  {[
                    { label: 'Market Cap', value: fmtBig(q?.marketCap) },
                    { label: 'P/E Ratio', value: stats?.forwardPE ? fmt(stats.forwardPE) : q?.trailingPE ? fmt(q.trailingPE) : '—' },
                    { label: 'EPS (TTM)', value: q?.epsTrailingTwelveMonths ? `$${fmt(q.epsTrailingTwelveMonths)}` : '—' },
                    { label: '52W High', value: q?.fiftyTwoWeekHigh ? `$${fmt(q.fiftyTwoWeekHigh)}` : '—' },
                    { label: '52W Low', value: q?.fiftyTwoWeekLow ? `$${fmt(q.fiftyTwoWeekLow)}` : '—' },
                    { label: 'Volume', value: q?.regularMarketVolume ? (q.regularMarketVolume / 1e6).toFixed(2) + 'M' : '—' },
                    { label: 'Revenue', value: fin?.totalRevenue ? fmtBig(fin.totalRevenue) : '—' },
                    { label: 'Profit Margin', value: fin?.profitMargins != null ? `${(fin.profitMargins * 100).toFixed(1)}%` : '—' },
                    { label: 'Return on Equity', value: fin?.returnOnEquity != null ? `${(fin.returnOnEquity * 100).toFixed(1)}%` : '—' },
                  ].map(({ label, value }) => (
                    <div key={label}>
                      <p className="text-xs text-[#6B7E9C] mb-0.5">{label}</p>
                      <p className="font-mono text-sm font-medium">{value}</p>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Company info */}
            {profile && (
              <div className="rounded-2xl bg-[#0F1520] border border-[#1E2D42] p-5">
                <p className="text-xs text-[#6B7E9C] mb-3 font-medium uppercase tracking-wider">About</p>
                <div className="flex flex-wrap gap-3 mb-3 text-xs text-[#6B7E9C]">
                  {profile.sector && (
                    <span className="flex items-center gap-1"><BarChartIcon /> {profile.sector}</span>
                  )}
                  {profile.industry && (
                    <span className="flex items-center gap-1"><Globe size={11} /> {profile.industry}</span>
                  )}
                  {profile.fullTimeEmployees && (
                    <span className="flex items-center gap-1"><Users size={11} /> {profile.fullTimeEmployees.toLocaleString()} employees</span>
                  )}
                  {profile.website && (
                    <a href={profile.website} target="_blank" rel="noopener noreferrer"
                      className="flex items-center gap-1 text-[#4F8EF7] hover:underline">
                      <ExternalLink size={11} /> Website
                    </a>
                  )}
                </div>
                {profile.longBusinessSummary && (
                  <p className="text-sm text-[#8B9CC0] leading-relaxed line-clamp-4">
                    {profile.longBusinessSummary}
                  </p>
                )}
              </div>
            )}

            {/* News */}
            <div className="rounded-2xl bg-[#0F1520] border border-[#1E2D42] p-5">
              <p className="text-xs text-[#6B7E9C] mb-4 font-medium uppercase tracking-wider">Latest News</p>
              {news.length === 0 ? (
                <p className="text-sm text-[#6B7E9C]">No recent news found.</p>
              ) : (
                <div className="space-y-3">
                  {news.map((item, i) => (
                    <a key={i} href={item.link} target="_blank" rel="noopener noreferrer"
                      className="block group p-3 rounded-xl hover:bg-[#172033] transition-colors border border-transparent hover:border-[#2A3F60]">
                      <p className="text-sm font-medium group-hover:text-[#4F8EF7] transition-colors leading-snug">
                        {item.title}
                      </p>
                      {item.pubDate && (
                        <p className="text-xs text-[#3A4E6A] mt-1">
                          {formatDate(item.pubDate)}
                        </p>
                      )}
                    </a>
                  ))}
                </div>
              )}
            </div>
          </>
        )}
      </main>
    </div>
  );
}

function BarChartIcon() {
  return <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="18" y="3" width="4" height="18"/><rect x="10" y="8" width="4" height="13"/><rect x="2" y="13" width="4" height="8"/></svg>;
}

function formatDate(dateStr: string) {
  try {
    return format(new Date(dateStr), 'MMM d, yyyy · h:mm a');
  } catch {
    return dateStr;
  }
}
