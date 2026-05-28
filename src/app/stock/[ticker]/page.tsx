'use client';
import { useState, useEffect } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { ArrowLeft, TrendingUp, TrendingDown, ExternalLink, Globe, Users, Target } from 'lucide-react';
import { format } from 'date-fns';

// ── Helpers ──────────────────────────────────────────────────────────────────
function fmt(n: number, dec = 2) {
  return n?.toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec }) ?? '—';
}
function fmtBig(n: number) {
  if (!n && n !== 0) return '—';
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (abs >= 1e12) return `${sign}$${(abs / 1e12).toFixed(2)}T`;
  if (abs >= 1e9)  return `${sign}$${(abs / 1e9).toFixed(2)}B`;
  if (abs >= 1e6)  return `${sign}$${(abs / 1e6).toFixed(2)}M`;
  return `${sign}$${fmt(abs)}`;
}
function fmtChartTime(ts: number, range: string) {
  try {
    const d = new Date(ts);
    if (range === '1d') return format(d, 'HH:mm');
    if (range === '5d') return format(d, 'EEE HH:mm');
    if (range === '1y' || range === '5y') return format(d, 'MMM d, yyyy');
    return format(d, 'MMM d');
  } catch { return ''; }
}
function daysFrom(ts: number) {
  const d = Math.round((ts - Date.now()) / 86_400_000);
  if (d === 0) return 'Today';
  if (d === 1) return 'Tomorrow';
  if (d > 0) return `in ${d} days`;
  if (d === -1) return 'Yesterday';
  return `${Math.abs(d)} days ago`;
}

// ── Constants ─────────────────────────────────────────────────────────────────
const RECO: Record<string, { label: string; cls: string }> = {
  strong_buy:  { label: 'Strong Buy',  cls: 'text-emerald-400 bg-emerald-400/10 border-emerald-400/30' },
  buy:         { label: 'Buy',         cls: 'text-green-400 bg-green-400/10 border-green-400/30' },
  hold:        { label: 'Hold',        cls: 'text-amber-400 bg-amber-400/10 border-amber-400/30' },
  underperform:{ label: 'Underperform',cls: 'text-orange-400 bg-orange-400/10 border-orange-400/30' },
  sell:        { label: 'Sell',        cls: 'text-rose-400 bg-rose-400/10 border-rose-400/30' },
};

const RANGES = ['1d', '5d', '1mo', '3mo', '1y', '5y'] as const;
type Range = typeof RANGES[number];
const RANGE_LABEL: Record<Range, string> = { '1d':'1D','5d':'5D','1mo':'1M','3mo':'3M','1y':'1Y','5y':'5Y' };

// ── Sparkline ─────────────────────────────────────────────────────────────────
function Sparkline({
  points, height, hoverIdx, onHover,
}: {
  points: { t: number; p: number }[];
  height: number;
  hoverIdx: number | null;
  onHover: (i: number | null) => void;
}) {
  if (points.length < 2) return null;
  const prices = points.map(p => p.p);
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const span = max - min || min * 0.001 || 1;
  const W = 1000; const H = height; const px = 2; const py = 10;
  const toX = (i: number) => px + (i / (points.length - 1)) * (W - 2 * px);
  const toY = (p: number) => py + (1 - (p - min) / span) * (H - 2 * py);
  const isPos = prices[prices.length - 1] >= prices[0];
  const color = isPos ? '#22C55E' : '#F43F5E';
  const line = points.map((pt, i) => `${i ? 'L' : 'M'}${toX(i).toFixed(1)},${toY(pt.p).toFixed(1)}`).join(' ');
  const fill = `${line} L${toX(points.length - 1).toFixed(1)},${H} L${toX(0).toFixed(1)},${H} Z`;

  function handleMove(e: React.MouseEvent<SVGSVGElement>) {
    const r = e.currentTarget.getBoundingClientRect();
    const pct = (e.clientX - r.left) / r.width;
    onHover(Math.max(0, Math.min(points.length - 1, Math.round(pct * (points.length - 1)))));
  }

  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none"
      className="w-full cursor-crosshair" style={{ height }}
      onMouseMove={handleMove} onMouseLeave={() => onHover(null)}>
      <defs>
        <linearGradient id="sfill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.22" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={fill} fill="url(#sfill)" />
      <path d={line} fill="none" stroke={color} strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" />
      {hoverIdx != null && (
        <>
          <line x1={toX(hoverIdx)} y1={py - 6} x2={toX(hoverIdx)} y2={H}
            stroke="#4F8EF7" strokeWidth="1" opacity="0.5" />
          <circle cx={toX(hoverIdx)} cy={toY(points[hoverIdx].p)}
            r="5" fill="#4F8EF7" stroke="#080B14" strokeWidth="2.5" />
        </>
      )}
    </svg>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────
export default function StockDetail() {
  const { ticker } = useParams<{ ticker: string }>();
  const router = useRouter();

  const [data, setData]           = useState<any>(null);
  const [news, setNews]           = useState<any[]>([]);
  const [position, setPosition]   = useState<any>(null);
  const [myTxns, setMyTxns]       = useState<any[]>([]);
  const [chartData, setChartData] = useState<any>(null);
  const [loading, setLoading]     = useState(true);
  const [chartLoading, setChartLoading] = useState(false);
  const [range, setRange]         = useState<Range>('1d');
  const [hoverIdx, setHoverIdx]   = useState<number | null>(null);

  useEffect(() => {
    async function load() {
      setLoading(true);
      try {
        const [stockRes, newsRes, pfRes, chartRes, txnRes] = await Promise.all([
          fetch(`/api/stock/${ticker}`),
          fetch(`/api/news/${ticker}`),
          fetch('/api/portfolio'),
          fetch(`/api/chart/${ticker}?range=1d`),
          fetch('/api/transactions'),
        ]);
        const pf = await pfRes.json();
        const allTxns = await txnRes.json();
        setData(await stockRes.json());
        setNews(await newsRes.json());
        setPosition(pf.holdings?.find((h: any) => h.ticker === ticker) ?? null);
        setChartData(await chartRes.json());
        setMyTxns(allTxns.filter((t: any) => t.ticker === ticker));
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [ticker]);

  async function handleRange(r: Range) {
    setRange(r);
    setHoverIdx(null);
    setChartLoading(true);
    try {
      const res = await fetch(`/api/chart/${ticker}?range=${r}`);
      setChartData(await res.json());
    } finally {
      setChartLoading(false);
    }
  }

  const q       = data?.quote;
  const fin     = data?.summary?.financialData;
  const stats   = data?.summary?.defaultKeyStatistics;
  const profile = data?.summary?.summaryProfile;
  const cal     = data?.summary?.calendarEvents;

  const price     = q?.regularMarketPrice ?? 0;
  const change    = q?.regularMarketChange ?? 0;
  const changePct = q?.regularMarketChangePercent ?? 0;
  const pos       = change >= 0;

  const recoInfo    = fin?.recommendationKey ? RECO[fin.recommendationKey] ?? null : null;
  const targetPrice = fin?.targetMeanPrice;
  const upside      = targetPrice && price ? ((targetPrice - price) / price) * 100 : null;

  const earningsDates: number[] = cal?.earningsDate ?? [];
  const nextEarnings = earningsDates.find(d => d > Date.now()) ?? null;

  const low52 = q?.fiftyTwoWeekLow;
  const hi52  = q?.fiftyTwoWeekHigh;
  const w52Pct = (low52 && hi52 && hi52 > low52)
    ? Math.max(0, Math.min(100, ((price - low52) / (hi52 - low52)) * 100))
    : null;

  const keyStats = [
    { label: 'Market Cap',    value: q?.marketCap         ? fmtBig(q.marketCap) : null },
    { label: 'P/E (Fwd)',     value: stats?.forwardPE      ? fmt(stats.forwardPE) : null },
    { label: 'P/E (TTM)',     value: q?.trailingPE         ? fmt(q.trailingPE) : null },
    { label: 'EPS (TTM)',     value: q?.epsTrailingTwelveMonths != null ? `$${fmt(q.epsTrailingTwelveMonths)}` : null },
    { label: 'EPS (Fwd)',     value: stats?.forwardEps     != null ? `$${fmt(stats.forwardEps)}` : null },
    { label: 'Beta',          value: stats?.beta           != null ? fmt(stats.beta) : null },
    { label: 'Div Yield',     value: stats?.dividendYield  != null ? `${(stats.dividendYield * 100).toFixed(2)}%` : null },
    { label: 'Volume',        value: q?.regularMarketVolume ? `${(q.regularMarketVolume / 1e6).toFixed(2)}M` : null },
    { label: 'Revenue',       value: fin?.totalRevenue     ? fmtBig(fin.totalRevenue) : null },
    { label: 'Rev Growth',    value: fin?.revenueGrowth    != null ? `${(fin.revenueGrowth * 100).toFixed(1)}%` : null },
    { label: 'Gross Margin',  value: fin?.grossMargins     != null ? `${(fin.grossMargins * 100).toFixed(1)}%` : null },
    { label: 'Op. Margin',    value: fin?.operatingMargins != null ? `${(fin.operatingMargins * 100).toFixed(1)}%` : null },
    { label: 'Profit Margin', value: fin?.profitMargins    != null ? `${(fin.profitMargins * 100).toFixed(1)}%` : null },
    { label: 'Free Cash Flow',value: fin?.freeCashflow     ? fmtBig(fin.freeCashflow) : null },
    { label: 'Debt/Equity',   value: fin?.debtToEquity     != null ? fmt(fin.debtToEquity / 100) : null },
    { label: 'ROE',           value: fin?.returnOnEquity   != null ? `${(fin.returnOnEquity * 100).toFixed(1)}%` : null },
  ].filter(s => s.value != null) as { label: string; value: string }[];

  const hoveredPt = hoverIdx != null ? chartData?.points?.[hoverIdx] : null;

  return (
    <div className="min-h-screen bg-[#080B14]">
      <header className="sticky top-0 z-30 bg-[#080B14]/90 backdrop-blur border-b border-[#1E2D42]">
        <div className="max-w-3xl mx-auto px-4 h-14 flex items-center gap-3">
          <button onClick={() => router.back()}
            className="p-2 rounded-lg hover:bg-[#172033] text-[#6B7E9C] hover:text-[#E8EDFB] transition-colors">
            <ArrowLeft size={16} />
          </button>
          <span className="font-mono font-bold text-[#4F8EF7]">{ticker}</span>
          {q && <span className="text-sm text-[#6B7E9C] truncate">{q.longName}</span>}
          {q?.marketState && q.marketState !== 'REGULAR' && (
            <span className="ml-auto text-[10px] px-2 py-0.5 rounded bg-[#172033] text-[#6B7E9C] border border-[#1E2D42]">
              {q.marketState}
            </span>
          )}
        </div>
      </header>

      <main className="max-w-3xl mx-auto px-4 pb-12 pt-5 space-y-3">
        {loading ? (
          <div className="space-y-3">
            {[140, 200, 120, 200].map((h, i) => (
              <div key={i} className="rounded-2xl bg-[#0F1520] animate-pulse" style={{ height: h }} />
            ))}
          </div>
        ) : (
          <>
            {/* ── Price card ── */}
            {q && (
              <div className="rounded-2xl bg-[#0F1520] border border-[#1E2D42] p-5">
                <div className="flex items-end gap-4 flex-wrap">
                  <div>
                    <p className="text-xs text-[#6B7E9C] mb-1">Current Price</p>
                    <p className="text-4xl font-bold font-mono">${fmt(price)}</p>
                  </div>
                  <div className={`flex items-center gap-1.5 pb-1 text-lg font-mono ${pos ? 'text-emerald-400' : 'text-rose-400'}`}>
                    {pos ? <TrendingUp size={16} /> : <TrendingDown size={16} />}
                    {pos ? '+' : ''}{fmt(change)} ({pos ? '+' : ''}{fmt(changePct)}%)
                  </div>
                </div>

                {/* 52W range bar */}
                {w52Pct != null && (
                  <div className="mt-4 pt-4 border-t border-[#1E2D42]">
                    <div className="flex justify-between text-[10px] font-mono text-[#6B7E9C] mb-1.5">
                      <span>52W Low ${fmt(low52)}</span>
                      <span>52W High ${fmt(hi52)}</span>
                    </div>
                    <div className="relative h-1.5 bg-[#172033] rounded-full">
                      <div className="absolute left-0 h-full bg-gradient-to-r from-rose-500 via-amber-400 to-emerald-400 rounded-full opacity-40"
                        style={{ width: '100%' }} />
                      <div className="absolute w-3 h-3 -mt-[3px] rounded-full bg-white border-2 border-[#4F8EF7] -translate-x-1/2"
                        style={{ left: `${w52Pct}%` }} />
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* ── Chart ── */}
            <div className="rounded-2xl bg-[#0F1520] border border-[#1E2D42] p-4 sm:p-5">
              {/* Range tabs */}
              <div className="flex gap-1 mb-3">
                {RANGES.map(r => (
                  <button key={r} onClick={() => handleRange(r)}
                    className={`flex-1 py-1 text-xs rounded-lg transition-all ${
                      range === r
                        ? 'bg-[#4F8EF7]/20 text-[#4F8EF7] font-semibold'
                        : 'text-[#6B7E9C] hover:text-[#E8EDFB] hover:bg-[#172033]'
                    }`}>
                    {RANGE_LABEL[r]}
                  </button>
                ))}
              </div>

              {/* Hover price badge */}
              <div className="h-5 flex items-center mb-1">
                {hoveredPt ? (
                  <span className="text-xs font-mono text-[#E8EDFB]">
                    <span className="font-semibold">${hoveredPt.p.toFixed(2)}</span>
                    <span className="text-[#6B7E9C] ml-2">{fmtChartTime(hoveredPt.t, range)}</span>
                  </span>
                ) : chartData?.points?.length > 0 && (
                  <span className="text-xs font-mono text-[#6B7E9C]">
                    {chartData.points.length} data points
                  </span>
                )}
              </div>

              {/* Chart area */}
              {chartLoading ? (
                <div className="h-[140px] rounded-xl bg-[#172033] animate-pulse" />
              ) : chartData?.points?.length > 1 ? (
                <Sparkline
                  points={chartData.points}
                  height={140}
                  hoverIdx={hoverIdx}
                  onHover={setHoverIdx}
                />
              ) : (
                <div className="h-[140px] flex items-center justify-center text-sm text-[#6B7E9C]">
                  No chart data
                </div>
              )}
            </div>

            {/* ── Analyst + Earnings row ── */}
            {(recoInfo || nextEarnings) && (
              <div className={`grid gap-3 ${recoInfo && nextEarnings ? 'sm:grid-cols-2' : ''}`}>
                {recoInfo && targetPrice && (
                  <div className="rounded-2xl bg-[#0F1520] border border-[#1E2D42] p-4 sm:p-5">
                    <p className="text-xs text-[#6B7E9C] mb-3 font-medium uppercase tracking-wider flex items-center gap-1.5">
                      <Target size={11} /> Analyst Consensus
                    </p>
                    <div className="flex items-center gap-3 flex-wrap">
                      <span className={`text-xs font-semibold px-2.5 py-1 rounded-lg border ${recoInfo.cls}`}>
                        {recoInfo.label}
                      </span>
                      <div className="text-sm font-mono">
                        <span className="text-[#6B7E9C]">Target </span>
                        <span className="font-semibold">${fmt(targetPrice)}</span>
                        {upside != null && (
                          <span className={`ml-1.5 text-xs ${upside >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                            ({upside >= 0 ? '+' : ''}{upside.toFixed(1)}%)
                          </span>
                        )}
                      </div>
                      {fin?.numberOfAnalystOpinions > 0 && (
                        <span className="text-xs text-[#3A4E6A]">{fin.numberOfAnalystOpinions} analysts</span>
                      )}
                    </div>
                  </div>
                )}

                {nextEarnings && (
                  <div className="rounded-2xl bg-[#0F1520] border border-[#1E2D42] p-4 sm:p-5">
                    <p className="text-xs text-[#6B7E9C] mb-3 font-medium uppercase tracking-wider">Next Earnings</p>
                    <p className="font-mono font-semibold text-[#E8EDFB]">
                      {format(new Date(nextEarnings), 'MMM d, yyyy')}
                    </p>
                    <p className="text-xs text-[#4F8EF7] mt-1">{daysFrom(nextEarnings)}</p>
                  </div>
                )}
              </div>
            )}

            {/* ── Your position ── */}
            {position && (
              <div className="rounded-2xl bg-[#172033] border border-[#2A3F60] p-5">
                <p className="text-xs text-[#4F8EF7] mb-3 font-medium uppercase tracking-wider">Your Position</p>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                  {[
                    { label: 'Shares',       value: fmt(position.shares, 4).replace(/\.?0+$/, '') },
                    { label: 'Avg Cost',     value: `$${fmt(position.avgCost)}` },
                    { label: 'Market Value', value: `$${fmt(position.currentValue)}` },
                    {
                      label: 'Total P&L',
                      value: `${position.pnl >= 0 ? '+' : ''}$${fmt(position.pnl)} (${position.pnl >= 0 ? '+' : ''}${fmt(position.pnlPct)}%)`,
                      cls: position.pnl >= 0 ? 'text-emerald-400' : 'text-rose-400',
                    },
                  ].map(({ label, value, cls }) => (
                    <div key={label}>
                      <p className="text-xs text-[#6B7E9C] mb-1">{label}</p>
                      <p className={`font-mono font-semibold text-sm ${cls ?? ''}`}>{value}</p>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* ── Key stats ── */}
            {keyStats.length > 0 && (
              <div className="rounded-2xl bg-[#0F1520] border border-[#1E2D42] p-5">
                <p className="text-xs text-[#6B7E9C] mb-4 font-medium uppercase tracking-wider">Key Stats</p>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-4">
                  {keyStats.map(({ label, value }) => (
                    <div key={label}>
                      <p className="text-xs text-[#6B7E9C] mb-0.5">{label}</p>
                      <p className="font-mono text-sm font-medium">{value}</p>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* ── About ── */}
            {profile && (profile.sector || profile.longBusinessSummary) && (
              <div className="rounded-2xl bg-[#0F1520] border border-[#1E2D42] p-5">
                <p className="text-xs text-[#6B7E9C] mb-3 font-medium uppercase tracking-wider">About</p>
                <div className="flex flex-wrap gap-3 mb-3 text-xs text-[#6B7E9C]">
                  {profile.sector && (
                    <span className="flex items-center gap-1">
                      <BarChartIcon /> {profile.sector}
                      {profile.industry ? ` · ${profile.industry}` : ''}
                    </span>
                  )}
                  {profile.fullTimeEmployees && (
                    <span className="flex items-center gap-1">
                      <Users size={11} /> {profile.fullTimeEmployees.toLocaleString()} employees
                    </span>
                  )}
                  {profile.website && (
                    <a href={profile.website} target="_blank" rel="noopener noreferrer"
                      className="flex items-center gap-1 text-[#4F8EF7] hover:underline">
                      <Globe size={11} /> Website <ExternalLink size={10} />
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

            {/* ── My transactions ── */}
            {myTxns.length > 0 && (
              <div className="rounded-2xl bg-[#0F1520] border border-[#1E2D42] p-5">
                <p className="text-xs text-[#6B7E9C] mb-4 font-medium uppercase tracking-wider">My Transactions</p>
                <div className="space-y-2">
                  {myTxns.map((t: any) => {
                    const isBuy = t.type === 'buy';
                    return (
                      <div key={t.id}
                        className="flex items-center justify-between py-2 border-b border-[#1E2D42]/60 last:border-0">
                        <div className="flex items-center gap-3">
                          <span className={`text-[10px] font-bold px-2 py-0.5 rounded ${
                            isBuy ? 'bg-emerald-400/10 text-emerald-400' : 'bg-rose-400/10 text-rose-400'
                          }`}>
                            {t.type.toUpperCase()}
                          </span>
                          <div>
                            <p className="text-sm font-mono">
                              {t.quantity} × ${fmt(t.price)}
                            </p>
                            <p className="text-xs text-[#6B7E9C]">{t.date}</p>
                          </div>
                        </div>
                        <div className="text-right">
                          <p className="text-sm font-mono font-medium">${fmt(t.quantity * t.price)}</p>
                          {t.notes && <p className="text-xs text-[#3A4E6A] truncate max-w-[120px]">{t.notes}</p>}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* ── News ── */}
            <div className="rounded-2xl bg-[#0F1520] border border-[#1E2D42] p-5">
              <p className="text-xs text-[#6B7E9C] mb-4 font-medium uppercase tracking-wider">Latest News</p>
              {news.length === 0 ? (
                <p className="text-sm text-[#6B7E9C]">No recent news found.</p>
              ) : (
                <div className="space-y-1">
                  {news.map((item, i) => (
                    <a key={i} href={item.link} target="_blank" rel="noopener noreferrer"
                      className="block group p-3 rounded-xl hover:bg-[#172033] transition-colors border border-transparent hover:border-[#2A3F60]">
                      <p className="text-sm font-medium group-hover:text-[#4F8EF7] transition-colors leading-snug">
                        {item.title}
                      </p>
                      {item.pubDate && (
                        <p className="text-xs text-[#3A4E6A] mt-1">{fmtDate(item.pubDate)}</p>
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
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="18" y="3" width="4" height="18" /><rect x="10" y="8" width="4" height="13" /><rect x="2" y="13" width="4" height="8" />
    </svg>
  );
}

function fmtDate(dateStr: string) {
  try { return format(new Date(dateStr), 'MMM d, yyyy · h:mm a'); }
  catch { return dateStr; }
}
