const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

export interface FocusStock {
  ticker: string;
  name: string;
  price: number;
  changePct: number;
  reason: string;
}

export interface RiskAlert {
  ticker: string;
  name: string;
  price: number;
  changePct: number;
  warning: string;
}

export interface DailyInsight {
  focus: FocusStock[];
  alerts: RiskAlert[];
}

let _cache: { data: DailyInsight; exp: number } | null = null;

// ── Market data sources ───────────────────────────────────────────────────────

async function getScreenerQuotes(
  scrId: string,
  count = 25,
): Promise<{ ticker: string; name: string; price: number; changePct: number }[]> {
  try {
    const res = await fetch(
      `https://query1.finance.yahoo.com/v1/finance/screener/predefined/saved?formatted=false&lang=en-US&region=US&scrIds=${scrId}&count=${count}`,
      { headers: { 'User-Agent': UA, Accept: 'application/json' } },
    );
    if (!res.ok) return [];
    const json = await res.json();
    return (json?.finance?.result?.[0]?.quotes ?? [])
      .filter((q: any) => q.symbol && q.regularMarketPrice != null)
      .map((q: any) => ({
        ticker: q.symbol as string,
        name: (q.longName || q.shortName || q.symbol) as string,
        price: q.regularMarketPrice as number,
        changePct: (q.regularMarketChangePercent as number) ?? 0,
      }));
  } catch {
    return [];
  }
}

async function getTrendingTickers(): Promise<string[]> {
  try {
    const res = await fetch(
      'https://query1.finance.yahoo.com/v1/finance/trending/US?count=20',
      { headers: { 'User-Agent': UA } },
    );
    if (!res.ok) return [];
    const json = await res.json();
    return (json?.finance?.result?.[0]?.quotes ?? [])
      .map((q: any) => q.symbol as string)
      .filter(Boolean)
      .slice(0, 15);
  } catch {
    return [];
  }
}

async function batchQuotes(
  tickers: string[],
): Promise<Record<string, { name: string; price: number; changePct: number }>> {
  if (!tickers.length) return {};
  try {
    const res = await fetch(
      `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${tickers.join(',')}&fields=regularMarketPrice,regularMarketChangePercent,shortName,longName`,
      { headers: { 'User-Agent': UA, Accept: 'application/json' } },
    );
    if (!res.ok) return {};
    const json = await res.json();
    const out: Record<string, { name: string; price: number; changePct: number }> = {};
    for (const q of json?.quoteResponse?.result ?? []) {
      out[q.symbol] = {
        name: q.longName || q.shortName || q.symbol,
        price: q.regularMarketPrice ?? 0,
        changePct: q.regularMarketChangePercent ?? 0,
      };
    }
    return out;
  } catch {
    return {};
  }
}

async function getHeadlines(ticker: string): Promise<string[]> {
  try {
    const res = await fetch(
      `https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(ticker)}&quotesCount=0&newsCount=5&enableFuzzyQuery=false`,
      { headers: { 'User-Agent': UA } },
    );
    if (!res.ok) return [];
    const json = await res.json();
    return (json?.news ?? [])
      .filter((n: any) => n.title)
      .map((n: any) => n.title as string)
      .slice(0, 5);
  } catch {
    return [];
  }
}

// ── Candidate type ────────────────────────────────────────────────────────────

type Candidate = {
  ticker: string;
  name: string;
  price: number;
  changePct: number;
  headlines: string[];
  isHeld: boolean;
};

// ── Prompt & parser ───────────────────────────────────────────────────────────

function buildPrompt(marketCandidates: Candidate[], heldCandidates: Candidate[]): string {
  const marketList = marketCandidates.map(c =>
    `【${c.ticker}】${c.name}（${c.changePct >= 0 ? '+' : ''}${c.changePct.toFixed(2)}%）\n` +
    (c.headlines.length ? c.headlines.map((h, i) => `${i + 1}. ${h}`).join('\n') : '（暂无新闻）'),
  ).join('\n\n');

  const heldList = heldCandidates.length
    ? '\n\n【持仓股（仅用于风险预警）】\n' + heldCandidates.map(c =>
        `【${c.ticker}】${c.name}（${c.changePct >= 0 ? '+' : ''}${c.changePct.toFixed(2)}%）\n` +
        (c.headlines.length ? c.headlines.map((h, i) => `${i + 1}. ${h}`).join('\n') : '（暂无新闻）'),
      ).join('\n\n')
    : '';

  return `你是专业股市分析师。以下是今日市场热门股票及最新新闻标题：

${marketList}${heldList}

===任务一：今日市场看涨焦点（5只）===
仅从上方"市场热门股票"中，选出今日最具上涨潜力的5只。
选股标准（优先级高→低）：有实质性利好催化（分析师上调评级/目标价、业绩超预期、重大合作/收购/新产品发布）、今日涨幅强劲且有事件支撑、市场资金高度关注。
纯粹依赖涨幅大而无具体催化剂的，降低优先级。
对每只用2~3句中文说明看涨理由，引用新闻标题中的具体事件或数据。

格式（每行一只，竖线分隔）：
TICKER|看涨理由

===任务二：持仓风险预警===
对"持仓股"中的股票，若存在多个明确看跌信号（业绩大幅未达预期、多位分析师集中下调、重大负面事件、管理层大额减持等），给出警告。
门槛要高：只有风险清晰且较大时才列出，普通波动不报。没有明确高风险则输出 NONE。
格式（每行一只）：
TICKER|HIGH|警告说明（1~2句，引用具体信号）

---严格按以下格式输出，两段之间空一行---
FOCUS:
TICKER|理由
TICKER|理由
TICKER|理由
TICKER|理由
TICKER|理由

ALERTS:
（TICKER|HIGH|警告说明 或 NONE）`;
}

function parseResponse(raw: string, allCandidates: Candidate[]): DailyInsight {
  const focusMatch = raw.match(/FOCUS:\n([\s\S]*?)(?:\n\nALERTS:|$)/);
  const alertsMatch = raw.match(/ALERTS:\n([\s\S]*)$/);

  const focus: FocusStock[] = [];
  for (const line of (focusMatch?.[1] ?? '').split('\n')) {
    const idx = line.indexOf('|');
    if (idx < 0) continue;
    const ticker = line.slice(0, idx).trim().replace(/[^A-Z0-9.^-]/g, '');
    const reason = line.slice(idx + 1).trim();
    if (!ticker || !reason || focus.length >= 5) continue;
    const c = allCandidates.find(x => x.ticker === ticker);
    if (!c) continue;
    focus.push({ ticker, name: c.name, price: c.price, changePct: c.changePct, reason });
  }

  const alerts: RiskAlert[] = [];
  const alertsText = alertsMatch?.[1]?.trim() ?? '';
  if (alertsText && !alertsText.startsWith('NONE')) {
    for (const line of alertsText.split('\n')) {
      const parts = line.split('|');
      if (parts.length < 3) continue;
      const ticker = parts[0].trim().replace(/[^A-Z0-9.^-]/g, '');
      const warning = parts[2].trim();
      if (!ticker || !warning) continue;
      // 只允许真正持仓的股票出现在预警里，防止 AI 把市场热股混入
      const c = allCandidates.find(x => x.ticker === ticker && x.isHeld);
      if (!c) continue;
      alerts.push({ ticker, name: c.name, price: c.price, changePct: c.changePct, warning });
    }
  }

  return { focus, alerts };
}

// ── Main export ───────────────────────────────────────────────────────────────

export async function getDailyInsight(heldTickers: string[]): Promise<DailyInsight> {
  if (_cache && _cache.exp > Date.now()) return _cache.data;

  // 1. Fetch market data from three sources in parallel
  const [gainers, actives, trending] = await Promise.all([
    getScreenerQuotes('day_gainers', 25),
    getScreenerQuotes('most_actives', 20),
    getTrendingTickers(),
  ]);

  // 2. Build market quote map (screeners already have price data)
  const marketQuoteMap: Record<string, { name: string; price: number; changePct: number }> = {};
  for (const q of [...gainers, ...actives]) {
    if (!marketQuoteMap[q.ticker]) marketQuoteMap[q.ticker] = q;
  }

  // 3. Fetch quotes for trending tickers not already covered
  const trendingNew = trending.filter(t => !marketQuoteMap[t]);
  if (trendingNew.length) {
    const trendingQuotes = await batchQuotes(trendingNew);
    for (const [t, q] of Object.entries(trendingQuotes)) marketQuoteMap[t] = q;
  }

  // 4. Fetch quotes for held tickers not in market pool (needed for risk alerts)
  const heldNew = heldTickers.filter(t => !marketQuoteMap[t]);
  if (heldNew.length) {
    const heldQuotes = await batchQuotes(heldNew);
    for (const [t, q] of Object.entries(heldQuotes)) marketQuoteMap[t] = q;
  }

  // 5. Ordered market tickers: gainers first (strongest signal), then actives, then trending
  const marketTickers = [
    ...gainers.map(q => q.ticker),
    ...actives.map(q => q.ticker).filter(t => !gainers.find(g => g.ticker === t)),
    ...trending.filter(t => !marketQuoteMap[t] || (!gainers.find(g => g.ticker === t) && !actives.find(a => a.ticker === t))),
  ].slice(0, 40);

  const heldSet = new Set(heldTickers);

  // 6. Fetch headlines for top 30 market tickers + held tickers (parallel)
  const tickersForNews = [...new Set([...marketTickers.slice(0, 30), ...heldTickers])];
  const newsMap = Object.fromEntries(
    await Promise.all(tickersForNews.map(async t => [t, await getHeadlines(t)] as [string, string[]])),
  );

  // 7. Build separate candidate lists
  const makeCandidate = (t: string): Candidate => ({
    ticker: t,
    name: marketQuoteMap[t]?.name ?? t,
    price: marketQuoteMap[t]?.price ?? 0,
    changePct: marketQuoteMap[t]?.changePct ?? 0,
    headlines: newsMap[t] ?? [],
    isHeld: heldSet.has(t),
  });

  const marketCandidates = marketTickers.map(makeCandidate);
  const heldCandidates = heldTickers.map(makeCandidate);
  const allCandidates = [...marketCandidates, ...heldCandidates.filter(c => !marketTickers.includes(c.ticker))];

  // 8. AI analysis
  const claudeKey = process.env.ANTHROPIC_API_KEY;
  const geminiKey = process.env.GEMINI_API_KEY;
  let data: DailyInsight = { focus: [], alerts: [] };

  if (claudeKey && marketCandidates.length > 0) {
    data = await callClaude(marketCandidates, heldCandidates, allCandidates, claudeKey);
  } else if (geminiKey && marketCandidates.length > 0) {
    data = await callGemini(marketCandidates, heldCandidates, allCandidates, geminiKey);
  }

  // 9. Fallback: top gainers with headline or generated reason
  if (data.focus.length === 0 && marketCandidates.length > 0) {
    const sorted = [...marketCandidates].sort((a, b) => b.changePct - a.changePct);
    data.focus = sorted.slice(0, 5).map(c => ({
      ticker: c.ticker,
      name: c.name,
      price: c.price,
      changePct: c.changePct,
      reason: c.headlines[0] ??
        (c.changePct > 0
          ? `今日涨幅 +${c.changePct.toFixed(2)}%，位居市场涨幅榜前列，盘面资金关注度高。`
          : `今日成交量活跃，市场持续关注，建议跟踪后续基本面动态。`),
    }));
  }

  // Cache: 1 hour for good results, 5 minutes for empty
  const cacheMs = data.focus.length > 0 ? 60 * 60_000 : 5 * 60_000;
  _cache = { data, exp: Date.now() + cacheMs };
  return data;
}

// ── AI callers ────────────────────────────────────────────────────────────────

async function callClaude(
  marketCandidates: Candidate[],
  heldCandidates: Candidate[],
  allCandidates: Candidate[],
  apiKey: string,
): Promise<DailyInsight> {
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1200,
        messages: [{ role: 'user', content: buildPrompt(marketCandidates, heldCandidates) }],
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) return { focus: [], alerts: [] };
    const data = await res.json();
    const raw: string = data.content?.[0]?.text ?? '';
    return parseResponse(raw, allCandidates);
  } catch {
    return { focus: [], alerts: [] };
  }
}

async function callGemini(
  marketCandidates: Candidate[],
  heldCandidates: Candidate[],
  allCandidates: Candidate[],
  apiKey: string,
): Promise<DailyInsight> {
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: buildPrompt(marketCandidates, heldCandidates) }] }],
          generationConfig: { temperature: 0.2, maxOutputTokens: 1200 },
        }),
        signal: AbortSignal.timeout(30_000),
      },
    );
    if (!res.ok) return { focus: [], alerts: [] };
    const data = await res.json();
    const raw: string = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
    return parseResponse(raw, allCandidates);
  } catch {
    return { focus: [], alerts: [] };
  }
}
