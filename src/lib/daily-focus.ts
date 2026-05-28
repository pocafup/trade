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

async function getTrendingTickers(): Promise<string[]> {
  try {
    const res = await fetch(
      'https://query1.finance.yahoo.com/v1/finance/trending/US?count=20',
      { headers: { 'User-Agent': UA } }
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

async function getHeadlines(ticker: string): Promise<string[]> {
  try {
    const res = await fetch(
      `https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(ticker)}&quotesCount=0&newsCount=5&enableFuzzyQuery=false`,
      { headers: { 'User-Agent': UA } }
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

async function batchQuotes(
  tickers: string[]
): Promise<Record<string, { name: string; price: number; changePct: number }>> {
  if (!tickers.length) return {};
  try {
    const res = await fetch(
      `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${tickers.join(',')}&fields=regularMarketPrice,regularMarketChangePercent,shortName,longName`,
      { headers: { 'User-Agent': UA, Accept: 'application/json' } }
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

export async function getDailyInsight(heldTickers: string[]): Promise<DailyInsight> {
  if (_cache && _cache.exp > Date.now()) return _cache.data;

  const trending = await getTrendingTickers();
  const all = [...new Set([...heldTickers, ...trending])].slice(0, 20);

  const [quotes, newsMap] = await Promise.all([
    batchQuotes(all),
    Promise.all(all.map(async t => [t, await getHeadlines(t)] as [string, string[]]))
      .then(pairs => Object.fromEntries(pairs)),
  ]);

  const candidates = all.map(t => ({
    ticker: t,
    name: quotes[t]?.name ?? t,
    price: quotes[t]?.price ?? 0,
    changePct: quotes[t]?.changePct ?? 0,
    headlines: (newsMap[t] ?? []) as string[],
    isHeld: heldTickers.includes(t),
  }));

  const apiKey = process.env.GEMINI_API_KEY;
  let data: DailyInsight = { focus: [], alerts: [] };

  if (apiKey && candidates.length > 0) {
    data = await callGemini(candidates, apiKey);
  } else {
    // Fallback: top 5 positive movers
    data.focus = candidates
      .filter(c => c.changePct > 0 && c.headlines.length > 0)
      .sort((a, b) => b.changePct - a.changePct)
      .slice(0, 5)
      .map(c => ({
        ticker: c.ticker, name: c.name, price: c.price,
        changePct: c.changePct, reason: c.headlines[0] ?? '',
      }));
  }

  _cache = { data, exp: Date.now() + 6 * 3_600_000 };
  return data;
}

async function callGemini(
  candidates: { ticker: string; name: string; price: number; changePct: number; headlines: string[]; isHeld: boolean }[],
  apiKey: string,
): Promise<DailyInsight> {
  const stockList = candidates.map(c =>
    `【${c.ticker}】${c.name}（${c.changePct >= 0 ? '+' : ''}${c.changePct.toFixed(2)}%）${c.isHeld ? ' [我持有]' : ''}\n` +
    (c.headlines.length ? c.headlines.map((h, i) => `${i + 1}. ${h}`).join('\n') : '（暂无新闻）')
  ).join('\n\n');

  const prompt = `你是专业股市分析师。以下是今日候选股票及最新新闻标题：

${stockList}

===任务一：今日看涨焦点（5只）===
选出今日最具上涨潜力或看涨势头的5只股票。
选股标准（优先级高→低）：分析师上调评级/目标价、业绩超预期、重大正面催化剂（回购/合作/新产品）、价格强势上涨。
对每只用2~3句中文说明为何看涨，引用具体事件或数据。

格式（每行一只，竖线分隔）：
TICKER|看涨理由

===任务二：持仓风险预警===
对标注"[我持有]"的股票，若同时存在多个明确看跌信号（业绩大幅未达预期、多位分析师集中下调、重大负面事件、管理层大额减持等），给出警告。
门槛要高：只有风险清晰且较大时才列出，普通小跌不报。没有明确高风险则输出 NONE。
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

  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.2, maxOutputTokens: 1200 },
        }),
        signal: AbortSignal.timeout(30_000),
      }
    );
    if (!res.ok) return { focus: [], alerts: [] };
    const data = await res.json();
    const raw: string = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';

    // Parse FOCUS
    const focusMatch = raw.match(/FOCUS:\n([\s\S]*?)(?:\n\nALERTS:|$)/);
    const alertsMatch = raw.match(/ALERTS:\n([\s\S]*)$/);

    const focus: FocusStock[] = [];
    for (const line of (focusMatch?.[1] ?? '').split('\n')) {
      const idx = line.indexOf('|');
      if (idx < 0) continue;
      const ticker = line.slice(0, idx).trim().replace(/[^A-Z0-9.^-]/g, '');
      const reason = line.slice(idx + 1).trim();
      if (!ticker || !reason || focus.length >= 5) continue;
      const c = candidates.find(x => x.ticker === ticker);
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
        const c = candidates.find(x => x.ticker === ticker);
        if (!c) continue;
        alerts.push({ ticker, name: c.name, price: c.price, changePct: c.changePct, warning });
      }
    }

    return { focus, alerts };
  } catch {
    return { focus: [], alerts: [] };
  }
}
