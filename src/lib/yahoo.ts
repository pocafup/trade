const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

// ── Crumb / cookie session ───────────────────────────────────────────────────
let _crumb = '';
let _cookie = '';
let _crumbExpiry = 0;

async function getAuth() {
  if (_crumb && _crumbExpiry > Date.now()) return { crumb: _crumb, cookie: _cookie };

  const fcRes = await fetch('https://fc.yahoo.com/', {
    headers: { 'User-Agent': UA },
    redirect: 'follow',
  });
  _cookie = fcRes.headers.get('set-cookie') ?? '';

  const crumbRes = await fetch('https://query2.finance.yahoo.com/v1/test/getcrumb', {
    headers: { 'User-Agent': UA, Cookie: _cookie },
  });
  _crumb = await crumbRes.text();
  _crumbExpiry = Date.now() + 50 * 60 * 1000;
  return { crumb: _crumb, cookie: _cookie };
}

async function yfFetch(url: string, needsCrumb = false) {
  const headers: Record<string, string> = { 'User-Agent': UA, Accept: 'application/json' };
  let fullUrl = url;

  if (needsCrumb) {
    const { crumb, cookie } = await getAuth();
    headers['Cookie'] = cookie;
    fullUrl += (url.includes('?') ? '&' : '?') + `crumb=${encodeURIComponent(crumb)}`;
  }

  const res = await fetch(fullUrl, { headers });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function raw(v: any): number | null {
  if (v == null) return null;
  return typeof v === 'object' ? (v.raw ?? null) : v;
}

// ── Caches ───────────────────────────────────────────────────────────────────
const quoteCache = new Map<string, { data: any; expiry: number }>();
const summaryCache = new Map<string, { data: any; expiry: number }>();

// ── Public API ───────────────────────────────────────────────────────────────
export async function getQuote(ticker: string) {
  const cached = quoteCache.get(ticker);
  if (cached && cached.expiry > Date.now()) return cached.data;

  try {
    const json = await yfFetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1d&range=1d`
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

    quoteCache.set(ticker, { data, expiry: Date.now() + 60_000 });
    return data;
  } catch {
    return null;
  }
}

export async function getQuoteSummary(ticker: string) {
  const cached = summaryCache.get(ticker);
  if (cached && cached.expiry > Date.now()) return cached.data;

  try {
    const [chartJson, summaryJson] = await Promise.all([
      yfFetch(`https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1d&range=1d`),
      yfFetch(
        `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${ticker}?modules=financialData,defaultKeyStatistics,summaryProfile`,
        true
      ).catch(() => null),
    ]);

    const meta = chartJson?.chart?.result?.[0]?.meta ?? {};
    const price = meta.regularMarketPrice ?? 0;
    const prevClose = meta.chartPreviousClose ?? price;

    const fin = summaryJson?.quoteSummary?.result?.[0]?.financialData ?? {};
    const stats = summaryJson?.quoteSummary?.result?.[0]?.defaultKeyStatistics ?? {};
    const profile = summaryJson?.quoteSummary?.result?.[0]?.summaryProfile ?? {};

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
          profitMargins: raw(fin.profitMargins),
          returnOnEquity: raw(fin.returnOnEquity),
        },
        defaultKeyStatistics: {
          forwardPE: raw(stats.forwardPE),
          trailingEps: raw(stats.trailingEps),
        },
        summaryProfile: {
          sector: profile.sector,
          industry: profile.industry,
          longBusinessSummary: profile.longBusinessSummary,
          fullTimeEmployees: profile.fullTimeEmployees,
          website: profile.website,
        },
      },
    };

    summaryCache.set(ticker, { data, expiry: Date.now() + 5 * 60_000 });
    return data;
  } catch {
    return null;
  }
}

export async function searchTickers(query: string) {
  try {
    const json = await yfFetch(
      `https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(query)}&quotesCount=8&newsCount=0&enableFuzzyQuery=false`
    );
    return (json?.quotes ?? [])
      .filter((q: any) => q.quoteType === 'EQUITY')
      .map((q: any) => ({
        symbol: q.symbol as string,
        name: (q.longname || q.shortname || q.symbol) as string,
        exchange: (q.exchDisp || q.exchange) as string,
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
