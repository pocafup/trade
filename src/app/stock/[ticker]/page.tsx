'use client';
import { useState, useEffect } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { ArrowLeft, TrendingUp, TrendingDown, ExternalLink, Globe, Users, Target, ChevronDown, ChevronUp, Star } from 'lucide-react';
import { format } from 'date-fns';
import FontSizeToggle from '@/components/FontSizeToggle';

// ── 辅助函数 ──────────────────────────────────────────────────────────────────
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
    if (range === '5d') return format(d, 'M月d日 HH:mm');
    if (range === '1y' || range === '5y') return format(d, 'yyyy年M月d日');
    return format(d, 'M月d日');
  } catch { return ''; }
}
function daysFrom(ts: number) {
  const d = Math.round((ts - Date.now()) / 86_400_000);
  if (d === 0) return '今天';
  if (d === 1) return '明天';
  if (d > 0)   return `${d} 天后`;
  if (d === -1) return '昨天';
  return `${Math.abs(d)} 天前`;
}
function fmtQuarter(q: string) {
  const m = q.match(/(\d)Q(\d{4})/);
  return m ? `${m[2]} Q${m[1]}` : q;
}
function fmtNewsDate(ts: number) {
  try { return format(new Date(ts), 'M月d日 HH:mm'); } catch { return ''; }
}

// ── 常量 ───────────────────────────────────────────────────────────────────────
const RECO: Record<string, { label: string; cls: string }> = {
  strong_buy:   { label: '强力买入', cls: 'text-emerald-400 bg-emerald-400/10 border-emerald-400/30' },
  buy:          { label: '买入',     cls: 'text-green-400 bg-green-400/10 border-green-400/30' },
  hold:         { label: '持有',     cls: 'text-amber-400 bg-amber-400/10 border-amber-400/30' },
  underperform: { label: '表现不佳', cls: 'text-orange-400 bg-orange-400/10 border-orange-400/30' },
  sell:         { label: '卖出',     cls: 'text-rose-400 bg-rose-400/10 border-rose-400/30' },
};

const RANGES = ['1d', '5d', '1mo', '3mo', '1y', '5y'] as const;
type Range = typeof RANGES[number];
const RANGE_LABEL: Record<Range, string> = { '1d':'1日','5d':'5日','1mo':'1月','3mo':'3月','1y':'1年','5y':'5年' };

const STAT_LABELS: Record<string, string> = {
  'Market Cap':'总市值', 'P/E (Fwd)':'市盈率(预期)', 'P/E (TTM)':'市盈率(TTM)',
  'EPS (TTM)':'每股收益(TTM)', 'EPS (Fwd)':'每股收益(预期)', 'Beta':'贝塔系数',
  'Div Yield':'股息率', 'Volume':'成交量', 'Revenue':'营收', 'Rev Growth':'营收增速',
  'Gross Margin':'毛利率', 'Op. Margin':'营业利润率', 'Profit Margin':'净利润率',
  'Free Cash Flow':'自由现金流', 'Debt/Equity':'负债权益比', 'ROE':'净资产收益率',
};

// ── 走势图组件 ─────────────────────────────────────────────────────────────────
function Sparkline({ points, height, hoverIdx, onHover }: {
  points: { t: number; p: number }[];
  height: number;
  hoverIdx: number | null;
  onHover: (i: number | null) => void;
}) {
  if (points.length < 2) return null;
  const prices = points.map(p => p.p);
  const min = Math.min(...prices), max = Math.max(...prices);
  const span = max - min || min * 0.001 || 1;
  const W = 1000, H = height, px = 2, py = 10;
  const toX = (i: number) => px + (i / (points.length - 1)) * (W - 2 * px);
  const toY = (p: number) => py + (1 - (p - min) / span) * (H - 2 * py);
  const isPos = prices[prices.length - 1] >= prices[0];
  const color = isPos ? '#22C55E' : '#F43F5E';
  const line = points.map((pt, i) => `${i ? 'L' : 'M'}${toX(i).toFixed(1)},${toY(pt.p).toFixed(1)}`).join(' ');
  const fill = `${line} L${toX(points.length - 1).toFixed(1)},${H} L${toX(0).toFixed(1)},${H} Z`;

  function getIdx(cx: number, rect: DOMRect) {
    return Math.max(0, Math.min(points.length - 1, Math.round(((cx - rect.left) / rect.width) * (points.length - 1))));
  }
  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none"
      className="w-full cursor-crosshair select-none" style={{ height, touchAction: 'none' }}
      onMouseMove={e => onHover(getIdx(e.clientX, e.currentTarget.getBoundingClientRect()))}
      onMouseLeave={() => onHover(null)}
      onTouchStart={e => { e.preventDefault(); onHover(getIdx(e.touches[0].clientX, e.currentTarget.getBoundingClientRect())); }}
      onTouchMove={e => { e.preventDefault(); onHover(getIdx(e.touches[0].clientX, e.currentTarget.getBoundingClientRect())); }}
      onTouchEnd={() => onHover(null)}>
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
          <line x1={toX(hoverIdx)} y1={py - 6} x2={toX(hoverIdx)} y2={H} stroke="#4F8EF7" strokeWidth="1" opacity="0.5" />
          <circle cx={toX(hoverIdx)} cy={toY(points[hoverIdx].p)} r="5" fill="#4F8EF7" stroke="#080B14" strokeWidth="2.5" />
        </>
      )}
    </svg>
  );
}

// ── 新闻摘要组件 ───────────────────────────────────────────────────────────────
function NewsSummary({ summary }: { summary: { day1: any; day3: any; week: any } | null }) {
  const [tab, setTab]         = useState(0);
  const [showSrc, setShowSrc] = useState(false);

  if (!summary) return (
    <div className="rounded-2xl bg-[#0F1520] border border-[#1E2D42] p-5">
      <p className="text-xs text-[#6B7E9C] mb-3 font-medium uppercase tracking-wider">智能新闻摘要</p>
      <div className="space-y-2">
        <div className="h-4 w-3/4 rounded bg-[#172033] animate-pulse" />
        <div className="h-4 w-5/6 rounded bg-[#172033] animate-pulse" />
        <div className="h-4 w-2/3 rounded bg-[#172033] animate-pulse" />
      </div>
      <p className="text-[10px] text-[#3A4E6A] mt-3">AI 摘要生成中…</p>
    </div>
  );

  const tabs = [
    { label: '今日',  data: summary.day1 },
    { label: '近3天', data: summary.day3 },
    { label: '本周',  data: summary.week },
  ];
  const active      = tabs[tab];
  const items: any[]   = active.data.items  ?? [];
  const aiSummary      = active.data.summary ?? null;
  const para: string   = aiSummary?.para ?? '';
  const bullets: string[] = aiSummary?.bullets ?? [];
  const hasSummary  = para.length > 0 || bullets.length > 0;

  return (
    <div className="rounded-2xl bg-[#0F1520] border border-[#1E2D42] p-5">
      {/* 标题 + Tab 切换 */}
      <div className="flex items-center justify-between mb-4">
        <p className="text-xs text-[#6B7E9C] font-medium uppercase tracking-wider">智能新闻摘要</p>
        <div className="flex gap-1">
          {tabs.map((t, i) => (
            <button key={i} onClick={() => { setTab(i); setShowSrc(false); }}
              className={`px-2.5 py-1 text-xs rounded-lg transition-all ${
                tab === i ? 'bg-[#4F8EF7]/20 text-[#4F8EF7] font-medium' : 'text-[#6B7E9C] hover:text-[#E8EDFB]'
              }`}>
              {t.label}
              <span className="ml-1 opacity-50">{t.data.items?.length ?? 0}</span>
            </button>
          ))}
        </div>
      </div>

      {items.length === 0 ? (
        <p className="text-sm text-[#6B7E9C]">此时段内暂无相关资讯</p>
      ) : hasSummary ? (
        <>
          {/* AI 综合分析段落 */}
          {para && (
            <p className="text-sm text-[#C8D4EC] leading-relaxed mb-4 border-b border-[#1E2D42] pb-4">
              {para}
            </p>
          )}

          {/* AI bullet points */}
          {bullets.length > 0 && (
            <ul className="space-y-3 mb-4">
              {bullets.map((b, i) => (
                <li key={i} className="flex items-start gap-2.5">
                  <span className="text-[#4F8EF7] shrink-0 font-bold mt-0.5">•</span>
                  <p className="text-sm text-[#C8D4EC] leading-relaxed">{b}</p>
                </li>
              ))}
            </ul>
          )}

          {/* 折叠展示原始新闻来源 */}
          <button onClick={() => setShowSrc(s => !s)}
            className="flex items-center gap-1.5 text-xs text-[#3A4E6A] hover:text-[#6B7E9C] transition-colors mb-2">
            {showSrc ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
            {showSrc ? '收起' : `查看 ${items.length} 条原始资讯`}
          </button>
          {showSrc && (
            <ul className="space-y-1.5 border-t border-[#1E2D42]/60 pt-3">
              {items.map((item: any, i: number) => (
                <li key={i}>
                  <a href={item.link} target="_blank" rel="noopener noreferrer"
                    className="group flex items-start gap-2 hover:opacity-75 transition-opacity">
                    <span className="text-[#3A4E6A] mt-[3px] shrink-0 text-[10px]">•</span>
                    <div>
                      <p className="text-xs text-[#6B7E9C] group-hover:text-[#8B9CC0] leading-snug">
                        {item.titleZh || item.title}
                      </p>
                      <p className="text-[10px] text-[#2A3A54] mt-0.5">
                        {item.publisher}  {fmtNewsDate(item.ts)}
                      </p>
                    </div>
                  </a>
                </li>
              ))}
            </ul>
          )}
        </>
      ) : (
        /* 兜底：无 Gemini Key 时显示翻译标题 */
        <ul className="space-y-3">
          {items.map((item: any, i: number) => (
            <li key={i}>
              <a href={item.link} target="_blank" rel="noopener noreferrer"
                className="group flex items-start gap-2 hover:opacity-80 transition-opacity">
                <span className="text-[#4F8EF7] mt-[3px] shrink-0 text-xs">•</span>
                <div>
                  <p className="text-sm text-[#C8D4EC] group-hover:text-[#E8EDFB] leading-snug">
                    {item.titleZh || item.title}
                  </p>
                  <p className="text-[10px] text-[#3A4E6A] mt-0.5">
                    {item.publisher}  {fmtNewsDate(item.ts)}
                  </p>
                </div>
              </a>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ── 往期财报组件 ───────────────────────────────────────────────────────────────
function EarningsHistory({ history, ticker }: { history: any[] | null; ticker: string }) {
  const [open, setOpen] = useState(true);
  if (!history?.length) return null;

  return (
    <div className="rounded-2xl bg-[#0F1520] border border-[#1E2D42] overflow-hidden">
      <button onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between px-5 py-4 hover:bg-[#172033]/50 active:bg-[#172033] transition-colors">
        <p className="text-xs text-[#6B7E9C] font-medium uppercase tracking-wider">往期财报</p>
        {open ? <ChevronUp size={14} className="text-[#6B7E9C]" /> : <ChevronDown size={14} className="text-[#6B7E9C]" />}
      </button>

      {open && (
        <>
          <div className="px-5 pb-3 overflow-x-auto">
            <table className="w-full text-sm min-w-[360px]">
              <thead>
                <tr className="text-xs text-[#6B7E9C] border-b border-[#1E2D42]">
                  <th className="text-left pb-2.5 pr-3 font-medium">季度</th>
                  <th className="text-right pb-2.5 px-3 font-medium">EPS预期</th>
                  <th className="text-right pb-2.5 px-3 font-medium">EPS实际</th>
                  <th className="text-right pb-2.5 px-3 font-medium">超预期</th>
                  <th className="text-right pb-2.5 pl-3 font-medium">营收</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#1E2D42]/40">
                {history.map((row: any) => {
                  const beat = row.epsActual != null && row.epsEstimate != null
                    ? row.epsActual - row.epsEstimate : null;
                  const beatPct = beat != null && row.epsEstimate
                    ? (beat / Math.abs(row.epsEstimate)) * 100 : null;
                  const isPos = beatPct != null && beatPct >= 0;
                  return (
                    <tr key={row.period} className="hover:bg-[#172033]/30 transition-colors">
                      <td className="py-2.5 pr-3 font-mono text-xs font-medium">{fmtQuarter(row.period)}</td>
                      <td className="py-2.5 px-3 text-right font-mono text-xs text-[#6B7E9C]">
                        {row.epsEstimate != null ? `$${row.epsEstimate.toFixed(2)}` : '—'}
                      </td>
                      <td className="py-2.5 px-3 text-right font-mono text-xs font-medium">
                        {row.epsActual != null ? `$${row.epsActual.toFixed(2)}` : '—'}
                      </td>
                      <td className="py-2.5 px-3 text-right text-xs">
                        {beatPct != null ? (
                          <span className={isPos ? 'text-emerald-400' : 'text-rose-400'}>
                            {isPos ? '+' : ''}{beatPct.toFixed(1)}%
                          </span>
                        ) : '—'}
                      </td>
                      <td className="py-2.5 pl-3 text-right font-mono text-xs text-[#8B9CC0]">
                        {row.revenue ? fmtBig(row.revenue) : '—'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="px-5 py-3 border-t border-[#1E2D42]">
            <a href={`https://finance.yahoo.com/quote/${ticker}/financials/`}
              target="_blank" rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-xs text-[#4F8EF7] hover:underline">
              查看完整财务报表 <ExternalLink size={10} />
            </a>
          </div>
        </>
      )}
    </div>
  );
}

// ── 主页面 ─────────────────────────────────────────────────────────────────────
export default function StockDetail() {
  const { ticker } = useParams<{ ticker: string }>();
  const router = useRouter();

  const [data, setData]             = useState<any>(null);
  const [news, setNews]             = useState<any[]>([]);
  const [newsSummary, setNewsSummary] = useState<any>(null);
  const [position, setPosition]     = useState<any>(null);
  const [myTxns, setMyTxns]         = useState<any[]>([]);
  const [chartData, setChartData]   = useState<any>(null);
  const [loading, setLoading]       = useState(true);
  const [chartLoading, setChartLoading] = useState(false);
  const [range, setRange]           = useState<Range>('1d');
  const [hoverIdx, setHoverIdx]     = useState<number | null>(null);
  const [inWatchlist, setInWatchlist] = useState(false);

  useEffect(() => {
    // Check watchlist status
    fetch('/api/watchlist').then(r => r.json()).then((items: any[]) => {
      setInWatchlist(items.some(i => i.ticker === ticker));
    }).catch(() => {});

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
        const pf      = await pfRes.json();
        const allTxns = await txnRes.json();
        setData(await stockRes.json());
        setNews(await newsRes.json());
        setPosition(pf.holdings?.find((h: any) => h.ticker === ticker) ?? null);
        setChartData(await chartRes.json());
        setMyTxns(allTxns.filter((t: any) => t.ticker === ticker));
      } finally {
        setLoading(false);
      }
      // News summary loads separately (slower — needs translation)
      fetch(`/api/news-summary/${ticker}`)
        .then(r => r.json())
        .then(setNewsSummary)
        .catch(() => {});
    }
    load();
  }, [ticker]);

  async function toggleWatchlist() {
    if (inWatchlist) {
      await fetch(`/api/watchlist/${ticker}`, { method: 'DELETE' });
      setInWatchlist(false);
    } else {
      await fetch('/api/watchlist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ticker, name: data?.quote?.longName ?? ticker }),
      });
      setInWatchlist(true);
    }
  }

  async function handleRange(r: Range) {
    setRange(r); setHoverIdx(null); setChartLoading(true);
    try {
      const res = await fetch(`/api/chart/${ticker}?range=${r}`);
      setChartData(await res.json());
    } finally { setChartLoading(false); }
  }

  const q       = data?.quote;
  const fin     = data?.summary?.financialData;
  const stats   = data?.summary?.defaultKeyStatistics;
  const profile = data?.summary?.summaryProfile;
  const cal     = data?.summary?.calendarEvents;
  const earningsHistory: any[] = data?.summary?.earningsHistory ?? [];

  const price     = q?.regularMarketPrice ?? 0;
  const change    = q?.regularMarketChange ?? 0;
  const changePct = q?.regularMarketChangePercent ?? 0;
  const pos       = change >= 0;

  const recoInfo    = fin?.recommendationKey ? RECO[fin.recommendationKey] ?? null : null;
  const targetPrice = fin?.targetMeanPrice;
  const upside      = targetPrice && price ? ((targetPrice - price) / price) * 100 : null;

  const earningsDates: number[] = cal?.earningsDate ?? [];
  const nextEarnings = earningsDates.find(d => d > Date.now()) ?? null;

  const low52  = q?.fiftyTwoWeekLow;
  const hi52   = q?.fiftyTwoWeekHigh;
  const w52Pct = (low52 && hi52 && hi52 > low52)
    ? Math.max(0, Math.min(100, ((price - low52) / (hi52 - low52)) * 100)) : null;

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
  const descZh = profile?.longBusinessSummaryZh || profile?.longBusinessSummary;

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
          <div className="ml-auto flex items-center gap-2">
            {q?.marketState && q.marketState !== 'REGULAR' && (
              <span className="text-[10px] px-2 py-0.5 rounded bg-[#172033] text-[#6B7E9C] border border-[#1E2D42]">
                {q.marketState === 'CLOSED' ? '已收盘' : q.marketState === 'PRE' ? '盘前' : q.marketState === 'POST' ? '盘后' : q.marketState}
              </span>
            )}
            <button onClick={toggleWatchlist} title={inWatchlist ? '取消自选' : '加入自选'}
              className={`p-2 rounded-lg transition-colors ${inWatchlist ? 'text-amber-400 hover:text-amber-300' : 'text-[#6B7E9C] hover:text-amber-400'} hover:bg-[#172033]`}>
              <Star size={16} fill={inWatchlist ? 'currentColor' : 'none'} />
            </button>
            <FontSizeToggle />
          </div>
        </div>
      </header>

      <main className="max-w-3xl mx-auto px-4 pb-12 pt-5 space-y-3">
        {loading ? (
          <div className="space-y-3">
            {[140, 200, 120, 160, 200].map((h, i) => (
              <div key={i} className="rounded-2xl bg-[#0F1520] animate-pulse" style={{ height: h }} />
            ))}
          </div>
        ) : (
          <>
            {/* 价格 + 52W */}
            {q && (
              <div className="rounded-2xl bg-[#0F1520] border border-[#1E2D42] p-5">
                <div className="flex items-end gap-4 flex-wrap">
                  <div>
                    <p className="text-xs text-[#6B7E9C] mb-1">当前价格</p>
                    <p className="text-4xl font-bold font-mono">${fmt(price)}</p>
                  </div>
                  <div className={`flex items-center gap-1.5 pb-1 text-lg font-mono ${pos ? 'text-emerald-400' : 'text-rose-400'}`}>
                    {pos ? <TrendingUp size={16} /> : <TrendingDown size={16} />}
                    {pos ? '+' : ''}{fmt(change)} ({pos ? '+' : ''}{fmt(changePct)}%)
                  </div>
                </div>
                {w52Pct != null && (
                  <div className="mt-4 pt-4 border-t border-[#1E2D42]">
                    <div className="flex justify-between text-[10px] font-mono text-[#6B7E9C] mb-1.5">
                      <span>52周低 ${fmt(low52)}</span>
                      <span>52周高 ${fmt(hi52)}</span>
                    </div>
                    <div className="relative h-1.5 bg-[#172033] rounded-full">
                      <div className="absolute left-0 h-full bg-gradient-to-r from-rose-500 via-amber-400 to-emerald-400 rounded-full opacity-40 w-full" />
                      <div className="absolute w-3 h-3 -mt-[3px] rounded-full bg-white border-2 border-[#4F8EF7] -translate-x-1/2"
                        style={{ left: `${w52Pct}%` }} />
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* 走势图 */}
            <div className="rounded-2xl bg-[#0F1520] border border-[#1E2D42] p-4 sm:p-5">
              <div className="flex gap-1 mb-3">
                {RANGES.map(r => (
                  <button key={r} onClick={() => handleRange(r)}
                    className={`flex-1 py-1.5 text-xs rounded-lg transition-all ${
                      range === r ? 'bg-[#4F8EF7]/20 text-[#4F8EF7] font-semibold' : 'text-[#6B7E9C] hover:text-[#E8EDFB] hover:bg-[#172033]'
                    }`}>
                    {RANGE_LABEL[r]}
                  </button>
                ))}
              </div>
              <div className="h-5 flex items-center mb-1">
                {hoveredPt ? (
                  <span className="text-xs font-mono">
                    <span className="font-semibold text-[#E8EDFB]">${hoveredPt.p.toFixed(2)}</span>
                    <span className="text-[#6B7E9C] ml-2">{fmtChartTime(hoveredPt.t, range)}</span>
                  </span>
                ) : chartData?.points?.length > 0 && (
                  <span className="text-xs text-[#3A4E6A]">{chartData.points.length} 个数据点</span>
                )}
              </div>
              {chartLoading ? (
                <div className="h-[140px] rounded-xl bg-[#172033] animate-pulse" />
              ) : chartData?.points?.length > 1 ? (
                <Sparkline points={chartData.points} height={140} hoverIdx={hoverIdx} onHover={setHoverIdx} />
              ) : (
                <div className="h-[140px] flex items-center justify-center text-sm text-[#6B7E9C]">暂无图表数据</div>
              )}
            </div>

            {/* 新闻摘要（独立栏目） */}
            <NewsSummary summary={newsSummary} />

            {/* 分析师 + 财报日期 */}
            {(recoInfo || nextEarnings) && (
              <div className={`grid gap-3 ${recoInfo && nextEarnings ? 'sm:grid-cols-2' : ''}`}>
                {recoInfo && targetPrice && (
                  <div className="rounded-2xl bg-[#0F1520] border border-[#1E2D42] p-4 sm:p-5">
                    <p className="text-xs text-[#6B7E9C] mb-3 font-medium uppercase tracking-wider flex items-center gap-1.5">
                      <Target size={11} /> 分析师评级
                    </p>
                    <div className="flex items-center gap-3 flex-wrap">
                      <span className={`text-xs font-semibold px-2.5 py-1 rounded-lg border ${recoInfo.cls}`}>
                        {recoInfo.label}
                      </span>
                      <div className="text-sm font-mono">
                        <span className="text-[#6B7E9C]">目标价 </span>
                        <span className="font-semibold">${fmt(targetPrice)}</span>
                        {upside != null && (
                          <span className={`ml-1.5 text-xs ${upside >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                            ({upside >= 0 ? '+' : ''}{upside.toFixed(1)}%)
                          </span>
                        )}
                      </div>
                      {fin?.numberOfAnalystOpinions > 0 && (
                        <span className="text-xs text-[#3A4E6A]">{fin.numberOfAnalystOpinions} 位分析师</span>
                      )}
                    </div>
                  </div>
                )}
                {nextEarnings && (
                  <div className="rounded-2xl bg-[#0F1520] border border-[#1E2D42] p-4 sm:p-5">
                    <p className="text-xs text-[#6B7E9C] mb-3 font-medium uppercase tracking-wider">下次财报</p>
                    <p className="font-mono font-semibold">{format(new Date(nextEarnings), 'yyyy年M月d日')}</p>
                    <p className="text-xs text-[#4F8EF7] mt-1">{daysFrom(nextEarnings)}</p>
                  </div>
                )}
              </div>
            )}

            {/* 我的持仓 */}
            {position && (
              <div className="rounded-2xl bg-[#172033] border border-[#2A3F60] p-5">
                <p className="text-xs text-[#4F8EF7] mb-3 font-medium uppercase tracking-wider">我的持仓</p>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                  {[
                    { label: '股数',   value: fmt(position.shares, 4).replace(/\.?0+$/, '') },
                    { label: '成本价', value: `$${fmt(position.avgCost)}` },
                    { label: '市值',   value: `$${fmt(position.currentValue)}` },
                    {
                      label: '持仓盈亏',
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

            {/* 关键指标 */}
            {keyStats.length > 0 && (
              <div className="rounded-2xl bg-[#0F1520] border border-[#1E2D42] p-5">
                <p className="text-xs text-[#6B7E9C] mb-4 font-medium uppercase tracking-wider">关键指标</p>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-4">
                  {keyStats.map(({ label, value }) => (
                    <div key={label}>
                      <p className="text-xs text-[#6B7E9C] mb-0.5">{STAT_LABELS[label] ?? label}</p>
                      <p className="font-mono text-sm font-medium">{value}</p>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* 往期财报（可折叠） */}
            <EarningsHistory history={earningsHistory} ticker={ticker} />

            {/* 公司简介（翻译后） */}
            {profile && (profile.sector || descZh) && (
              <div className="rounded-2xl bg-[#0F1520] border border-[#1E2D42] p-5">
                <p className="text-xs text-[#6B7E9C] mb-3 font-medium uppercase tracking-wider">公司简介</p>
                <div className="flex flex-wrap gap-3 mb-3 text-xs text-[#6B7E9C]">
                  {profile.sector && (
                    <span className="flex items-center gap-1">
                      <BarChartIcon /> {profile.sector}{profile.industry ? ` · ${profile.industry}` : ''}
                    </span>
                  )}
                  {profile.fullTimeEmployees && (
                    <span className="flex items-center gap-1"><Users size={11} /> {profile.fullTimeEmployees.toLocaleString()} 名员工</span>
                  )}
                  {profile.website && (
                    <a href={profile.website} target="_blank" rel="noopener noreferrer"
                      className="flex items-center gap-1 text-[#4F8EF7] hover:underline">
                      <Globe size={11} /> 官网 <ExternalLink size={10} />
                    </a>
                  )}
                </div>
                {descZh && (
                  <p className="text-sm text-[#8B9CC0] leading-relaxed line-clamp-6">{descZh}</p>
                )}
              </div>
            )}

            {/* 我的交易记录 */}
            {myTxns.length > 0 && (
              <div className="rounded-2xl bg-[#0F1520] border border-[#1E2D42] p-5">
                <p className="text-xs text-[#6B7E9C] mb-4 font-medium uppercase tracking-wider">我的交易记录</p>
                <div className="space-y-1">
                  {myTxns.map((t: any) => {
                    const isBuy = t.type === 'buy';
                    return (
                      <div key={t.id} className="flex items-center justify-between py-2.5 border-b border-[#1E2D42]/60 last:border-0">
                        <div className="flex items-center gap-3">
                          <span className={`text-[10px] font-bold px-2 py-0.5 rounded ${isBuy ? 'bg-emerald-400/10 text-emerald-400' : 'bg-rose-400/10 text-rose-400'}`}>
                            {isBuy ? '买入' : '卖出'}
                          </span>
                          <div>
                            <p className="text-sm font-mono">{t.quantity} 股 × ${fmt(t.price)}</p>
                            <p className="text-xs text-[#6B7E9C]">{t.date}</p>
                          </div>
                        </div>
                        <div className="text-right">
                          <p className="text-sm font-mono font-medium">${fmt(t.quantity * t.price)}</p>
                          {t.notes && <p className="text-xs text-[#3A4E6A] truncate max-w-[100px]">{t.notes}</p>}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* 最新资讯（原文） */}
            <div className="rounded-2xl bg-[#0F1520] border border-[#1E2D42] p-5">
              <p className="text-xs text-[#6B7E9C] mb-4 font-medium uppercase tracking-wider">最新资讯</p>
              {news.length === 0 ? (
                <p className="text-sm text-[#6B7E9C]">暂无最新资讯</p>
              ) : (
                <div className="space-y-1">
                  {news.map((item: any, i: number) => (
                    <a key={i} href={item.link} target="_blank" rel="noopener noreferrer"
                      className="block group p-3 rounded-xl hover:bg-[#172033] active:bg-[#172033] transition-colors border border-transparent hover:border-[#2A3F60]">
                      <p className="text-sm font-medium group-hover:text-[#4F8EF7] transition-colors leading-snug">{item.title}</p>
                      {item.pubDate && <p className="text-xs text-[#3A4E6A] mt-1">{fmtDate(item.pubDate)}</p>}
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
  try { return format(new Date(dateStr), 'M月d日 HH:mm'); } catch { return dateStr; }
}
