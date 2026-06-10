const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

// ── Crumb / cookie session ───────────────────────────────────────────────────
let _crumb = '';
let _cookie = '';
let _crumbExpiry = 0;
let _authInFlight: Promise<{ crumb: string; cookie: string }> | null = null;

async function getAuth() {
  if (_crumb && _crumbExpiry > Date.now()) return { crumb: _crumb, cookie: _cookie };

  // 多个并发请求同时触发 getAuth 时，只发一次 crumb 请求，其余等待同一个 promise
  if (!_authInFlight) {
    _authInFlight = (async () => {
      const fcRes = await fetch('https://fc.yahoo.com/', {
        headers: { 'User-Agent': UA },
        redirect: 'follow',
        cache: 'no-store',
      });
      _cookie = fcRes.headers.get('set-cookie') ?? '';

      const crumbRes = await fetch('https://query2.finance.yahoo.com/v1/test/getcrumb', {
        headers: { 'User-Agent': UA, Cookie: _cookie },
        cache: 'no-store',
      });
      _crumb = await crumbRes.text();
      _crumbExpiry = Date.now() + 50 * 60 * 1000;
      _authInFlight = null;
      return { crumb: _crumb, cookie: _cookie };
    })();
  }

  return _authInFlight;
}

async function yfFetch(url: string, needsCrumb = false) {
  const headers: Record<string, string> = { 'User-Agent': UA, Accept: 'application/json' };
  let fullUrl = url;

  if (needsCrumb) {
    const { crumb, cookie } = await getAuth();
    headers['Cookie'] = cookie;
    fullUrl += (url.includes('?') ? '&' : '?') + `crumb=${encodeURIComponent(crumb)}`;
  }

  const res = await fetch(fullUrl, { headers, cache: 'no-store' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function raw(v: any): number | null {
  if (v == null) return null;
  return typeof v === 'object' ? (v.raw ?? null) : v;
}

// ── Caches ───────────────────────────────────────────────────────────────────
const quoteCache    = new Map<string, { data: any; expiry: number }>();
const summaryCache  = new Map<string, { data: any; expiry: number }>();
const chartCache    = new Map<string, { data: any; expiry: number }>();
const ytdPriceCache = new Map<string, { price: number; expiry: number }>();

// ── Public API ───────────────────────────────────────────────────────────────
export async function getQuote(ticker: string) {
  const cached = quoteCache.get(ticker);
  if (cached && cached.expiry > Date.now()) return cached.data;

  try {
    const json = await yfFetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1d&range=1d`,
      true
    );
    const meta = json?.chart?.result?.[0]?.meta;
    if (!meta) return null;

    const data = {
      price: meta.regularMarketPrice ?? 0,
      prevClose: meta.chartPreviousClose ?? meta.previousClose ?? meta.regularMarketPrice,
      change: meta.regularMarketPrice - (meta.chartPreviousClose ?? meta.regularMarketPrice),
      changePct:
        ((meta.regularMarketPrice - (meta.chartPreviousClose ?? meta.regularMarketPrice)) /
          (meta.chartPreviousClose ?? meta.regularMarketPrice)) *
        100,
      name: meta.longName || meta.shortName || ticker,
      high52w: meta.fiftyTwoWeekHigh,
      low52w: meta.fiftyTwoWeekLow,
      marketState: meta.marketState,
    };

    quoteCache.set(ticker, { data, expiry: Date.now() + 15_000 });
    return data;
  } catch {
    return null;
  }
}

export async function getChart(ticker: string, range: string) {
  const key = `${ticker}:${range}`;
  const cached = chartCache.get(key);
  if (cached && cached.expiry > Date.now()) return cached.data;

  const intervalMap: Record<string, string> = {
    '1d': '5m', '5d': '30m', '1mo': '1d', '3mo': '1d', '1y': '1wk', '5y': '1mo',
  };
  const interval = intervalMap[range] ?? '1d';

  try {
    const json = await yfFetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=${interval}&range=${range}`
    );
    const result = json?.chart?.result?.[0];
    if (!result) return null;

    const timestamps: number[] = result.timestamp ?? [];
    const closes: (number | null)[] = result.indicators?.quote?.[0]?.close ?? [];
    const points: { t: number; p: number }[] = [];
    for (let i = 0; i < timestamps.length; i++) {
      if (closes[i] != null) points.push({ t: timestamps[i] * 1000, p: closes[i]! });
    }

    const prices = points.map(p => p.p);
    const meta = result.meta ?? {};
    const data = {
      points,
      high: prices.length ? Math.max(...prices) : 0,
      low: prices.length ? Math.min(...prices) : 0,
      prevClose: meta.chartPreviousClose ?? null,
    };

    chartCache.set(key, { data, expiry: Date.now() + (range === '1d' ? 15_000 : 5 * 60_000) });
    return data;
  } catch {
    return null;
  }
}

export async function getQuoteSummary(ticker: string) {
  const cached = summaryCache.get(ticker);
  if (cached && cached.expiry > Date.now()) return cached.data;

  try {
    const [chartJson, summaryJson, fallbackJson] = await Promise.all([
      yfFetch(`https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1d&range=1d`),
      yfFetch(
        `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${ticker}?modules=financialData,defaultKeyStatistics,summaryProfile,calendarEvents,earnings`,
        true
      ).catch(() => null),
      yfFetch(
        `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${ticker}?modules=earningsHistory,incomeStatementHistoryQuarterly`,
        true
      ).catch(() => null),
    ]);

    const meta = chartJson?.chart?.result?.[0]?.meta ?? {};
    const price = meta.regularMarketPrice ?? 0;
    const prevClose = meta.chartPreviousClose ?? price;

    const r0 = summaryJson?.quoteSummary?.result?.[0] ?? {};
    const fin = r0.financialData ?? {};
    const stats = r0.defaultKeyStatistics ?? {};
    const profile = r0.summaryProfile ?? {};
    const cal = r0.calendarEvents ?? {};
    const earningsModule = summaryJson?.quoteSummary?.result?.[0]?.earnings ?? {};

    // 主路径：earnings 模块（earningsChart.quarterly + financialsChart.quarterly）
    const qEps: any[]  = earningsModule.earningsChart?.quarterly  ?? [];
    const qRev: any[]  = earningsModule.financialsChart?.quarterly ?? [];
    const revMap = new Map(qRev.map((q: any) => [q.date, { revenue: raw(q.revenue), netIncome: raw(q.earnings) }]));
    let earningsHistory = [...qEps].reverse().map((q: any) => ({
      period:      q.date,
      epsActual:   raw(q.actual),
      epsEstimate: raw(q.estimate),
      ...(revMap.get(q.date) ?? {}),
    }));

    // 备用路径 2：earningsHistory 模块
    // quarter.fmt 格式实测为 "YYYY-MM-DD"（如 "2025-06-30"），period 是 "-4q" 等相对标签
    if (!earningsHistory.length) {
      const eh: any[] = fallbackJson?.quoteSummary?.result?.[0]?.earningsHistory?.history ?? [];
      earningsHistory = [...eh].reverse().map((q: any) => {
        const fmt = q.quarter?.fmt ?? '';           // "2025-06-30"
        const parts = fmt.split('-').map(Number);   // [2025, 6, 30]
        const period = (parts[0] && parts[1])
          ? `${Math.ceil(parts[1] / 3)}Q${parts[0]}` : (q.period ?? fmt);
        return { period, epsActual: raw(q.epsActual), epsEstimate: raw(q.epsEstimate) };
      });
    }

    // 备用路径 3：incomeStatementHistoryQuarterly（无 EPS，但有季度营收/净利润）
    // 当前两条路径都失效时用这条兜底，至少能显示营收趋势
    if (!earningsHistory.length) {
      const ih: any[] = fallbackJson?.quoteSummary?.result?.[0]
        ?.incomeStatementHistoryQuarterly?.incomeStatementHistory ?? [];
      earningsHistory = ih.map((q: any) => {
        const fmt = q.endDate?.fmt ?? '';           // "2024-03-31"
        const parts = fmt.split('-').map(Number);
        const period = (parts[0] && parts[1])
          ? `${Math.ceil(parts[1] / 3)}Q${parts[0]}` : fmt;
        return {
          period,
          epsActual: null,
          epsEstimate: null,
          revenue: raw(q.totalRevenue),
          netIncome: raw(q.netIncome),
        };
      });
    }

    const earningsDate: number[] = (cal.earnings?.earningsDate ?? [])
      .map((d: any) => (typeof d === 'object' && d.raw ? d.raw * 1000 : typeof d === 'number' ? d * 1000 : null))
      .filter(Boolean) as number[];

    const data = {
      quote: {
        symbol: ticker,
        longName: meta.longName || meta.shortName || ticker,
        regularMarketPrice: price,
        regularMarketChange: price - prevClose,
        regularMarketChangePercent: prevClose ? ((price - prevClose) / prevClose) * 100 : 0,
        marketCap: meta.marketCap,
        marketState: meta.marketState,
        trailingPE: raw(stats.trailingPE),
        fiftyTwoWeekHigh: meta.fiftyTwoWeekHigh,
        fiftyTwoWeekLow: meta.fiftyTwoWeekLow,
        regularMarketVolume: meta.regularMarketVolume,
        epsTrailingTwelveMonths: raw(stats.trailingEps),
      },
      summary: {
        financialData: {
          totalRevenue: raw(fin.totalRevenue),
          revenueGrowth: raw(fin.revenueGrowth),
          grossMargins: raw(fin.grossMargins),
          operatingMargins: raw(fin.operatingMargins),
          profitMargins: raw(fin.profitMargins),
          returnOnEquity: raw(fin.returnOnEquity),
          debtToEquity: raw(fin.debtToEquity),
          freeCashflow: raw(fin.freeCashflow),
          targetMeanPrice: raw(fin.targetMeanPrice),
          recommendationKey: fin.recommendationKey ?? null,
          numberOfAnalystOpinions: raw(fin.numberOfAnalystOpinions),
        },
        defaultKeyStatistics: {
          forwardPE: raw(stats.forwardPE),
          forwardEps: raw(stats.forwardEps),
          trailingEps: raw(stats.trailingEps),
          pegRatio: raw(stats.pegRatio),
          priceToBook: raw(stats.priceToBook),
          beta: raw(stats.beta),
          dividendYield: raw(stats.dividendYield ?? stats.trailingAnnualDividendYield),
        },
        summaryProfile: {
          sector: profile.sector,
          industry: profile.industry,
          longBusinessSummary: profile.longBusinessSummary,
          fullTimeEmployees: profile.fullTimeEmployees,
          website: profile.website,
        },
        calendarEvents: { earningsDate },
        earningsHistory,
      },
    };

    summaryCache.set(ticker, { data, expiry: Date.now() + 60_000 });
    return data;
  } catch {
    return null;
  }
}

// 返回当年第一个交易日的收盘价（YTD 收益计算用）
// 缓存 6 小时，价格不会变
export async function getYearStartPrice(ticker: string): Promise<number> {
  const cached = ytdPriceCache.get(ticker);
  if (cached && cached.expiry > Date.now()) return cached.price;

  try {
    const json = await yfFetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1d&range=ytd`
    );
    const result = json?.chart?.result?.[0];
    const closes: (number | null)[] = result?.indicators?.quote?.[0]?.close ?? [];
    const price = closes.find((c) => c != null) ?? 0;
    ytdPriceCache.set(ticker, { price, expiry: Date.now() + 6 * 60 * 60 * 1000 });
    return price;
  } catch {
    return 0;
  }
}

export async function searchTickers(query: string) {
  try {
    const json = await yfFetch(
      `https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(query)}&quotesCount=8&newsCount=0&enableFuzzyQuery=false`
    );
    return (json?.quotes ?? [])
      .filter((q: any) => ['EQUITY', 'ETF', 'MUTUALFUND'].includes(q.quoteType))
      .map((q: any) => ({
        symbol: q.symbol as string,
        name: (q.longname || q.shortname || q.symbol) as string,
        exchange: (q.exchDisp || q.exchange) as string,
      }));
  } catch {
    return [];
  }
}

export async function getNewsExpanded(
  ticker: string
): Promise<{ title: string; link: string; publisher: string; ts: number }[]> {
  try {
    const json = await yfFetch(
      `https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(ticker)}&quotesCount=0&newsCount=30&enableFuzzyQuery=false`
    );
    return (json?.news ?? [])
      .filter((n: any) => n.title && n.providerPublishTime)
      .map((n: any) => ({
        title:     n.title as string,
        link:      (n.link ?? '') as string,
        publisher: (n.publisher ?? '') as string,
        ts:        (n.providerPublishTime as number) * 1000,
      }));
  } catch {
    return [];
  }
}

export async function getNews(
  ticker: string
): Promise<{ title: string; link: string; pubDate: string }[]> {
  try {
    const url = `https://feeds.finance.yahoo.com/rss/2.0/headline?s=${ticker}&region=US&lang=en-US`;
    const res = await fetch(url, { headers: { 'User-Agent': UA } });
    if (!res.ok) return [];

    const text = await res.text();
    const items = text.match(/<item>[\s\S]*?<\/item>/g) ?? [];

    return items.slice(0, 8).map((item) => {
      const title =
        item.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/)?.[1] ||
        item.match(/<title>(.*?)<\/title>/)?.[1] ||
        '';
      const link = item.match(/<link>(.*?)<\/link>/)?.[1] ?? '';
      const pubDate = item.match(/<pubDate>(.*?)<\/pubDate>/)?.[1] ?? '';
      return { title: title.replace(/&amp;/g, '&'), link, pubDate };
    });
  } catch {
    return [];
  }
}
