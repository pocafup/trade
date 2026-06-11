import { getQuote } from './yahoo';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

// ── Types ──────────────────────────────────────────────────────────────────────

export interface MarketTick {
  symbol: string;
  label: string;
  price: number;
  changePct: number;
  group: 'index' | 'vol' | 'rate' | 'fx' | 'commodity' | 'crypto';
}

export interface FearGreed {
  score: number;        // 0–100
  rating: string;       // 英文档位（extreme fear / fear / neutral / greed / extreme greed）
  label: string;        // 中文档位
  prevClose: number;    // 昨日
  week: number;         // 一周前
  month: number;        // 一月前
  year: number;         // 一年前
}

export interface EconIndicator {
  key: string;
  label: string;
  value: number;
  unit: string;
  date: string;         // 数据所属月份 YYYY-MM
  prev: number | null;  // 上一期读数，用于看趋势方向
  higherIsHot: boolean; // true = 数值升高代表"过热/偏紧"语境（通胀、利率），用于着色
  hint: string;
}

export interface CalendarEvent {
  label: string;
  date: string;         // YYYY-MM-DD
  daysAway: number;
  note: string;
}

export interface FomcSummary {
  date: string;         // 声明发布日 YYYY-MM-DD
  title: string;
  url: string;
  summary: string;      // AI 中文摘要
  changes: string[];    // 较上次的措辞变化（仅最新一条有）
}

export interface MacroData {
  marketPulse: MarketTick[];
  fearGreed: FearGreed | null;
  indicators: EconIndicator[];
  calendar: CalendarEvent[];
  fomc: FomcSummary[];
  generatedAt: string;
}

// ── 市场脉搏：复用 yahoo.ts 的 getQuote（带 crumb 认证），不直接裸调 ─────────────────

const PULSE_SYMBOLS: { symbol: string; label: string; group: MarketTick['group'] }[] = [
  { symbol: '^GSPC',     label: '标普500',   group: 'index' },
  { symbol: '^IXIC',     label: '纳斯达克',  group: 'index' },
  { symbol: '^DJI',      label: '道琼斯',    group: 'index' },
  { symbol: '^RUT',      label: '罗素2000',  group: 'index' },
  { symbol: '^VIX',      label: 'VIX 恐慌',  group: 'vol' },
  { symbol: '^TNX',      label: '10年期美债', group: 'rate' },
  { symbol: 'DX-Y.NYB',  label: '美元指数',  group: 'fx' },
  { symbol: 'GC=F',      label: '黄金',      group: 'commodity' },
  { symbol: 'CL=F',      label: '原油 WTI',  group: 'commodity' },
  { symbol: 'BTC-USD',   label: '比特币',    group: 'crypto' },
];

let _pulseCache: { data: MarketTick[]; exp: number } | null = null;

async function getMarketPulse(): Promise<MarketTick[]> {
  if (_pulseCache && _pulseCache.exp > Date.now()) return _pulseCache.data;

  const ticks = await Promise.all(
    PULSE_SYMBOLS.map(async (s) => {
      const q = await getQuote(s.symbol);
      if (!q) return null;
      return {
        symbol: s.symbol,
        label: s.label,
        price: q.price as number,
        changePct: q.changePct as number,
        group: s.group,
      } as MarketTick;
    }),
  );

  const data = ticks.filter((t): t is MarketTick => t !== null);
  _pulseCache = { data, exp: Date.now() + 60_000 }; // 1 分钟
  return data;
}

// ── 市场情绪：CNN 恐惧贪婪指数（需要 Origin/Referer 头才不被反爬拦） ─────────────────

const FG_LABELS: { max: number; label: string }[] = [
  { max: 25, label: '极度恐惧' },
  { max: 45, label: '恐惧' },
  { max: 55, label: '中性' },
  { max: 75, label: '贪婪' },
  { max: 100, label: '极度贪婪' },
];

function fgLabel(score: number): string {
  return FG_LABELS.find((x) => score <= x.max)?.label ?? '中性';
}

let _fgCache: { data: FearGreed | null; exp: number } | null = null;

async function getFearGreed(): Promise<FearGreed | null> {
  if (_fgCache && _fgCache.exp > Date.now()) return _fgCache.data;

  let data: FearGreed | null = null;
  try {
    const res = await fetch('https://production.dataviz.cnn.io/index/fearandgreed/graphdata', {
      headers: {
        'User-Agent': UA,
        Accept: 'application/json, text/plain, */*',
        Origin: 'https://www.cnn.com',
        Referer: 'https://www.cnn.com/',
      },
      cache: 'no-store',
      signal: AbortSignal.timeout(12_000),
    });
    if (res.ok) {
      const json = await res.json();
      const fg = json?.fear_and_greed;
      if (fg && typeof fg.score === 'number') {
        const score = Math.round(fg.score);
        data = {
          score,
          rating: fg.rating ?? '',
          label: fgLabel(score),
          prevClose: Math.round(fg.previous_close ?? score),
          week: Math.round(fg.previous_1_week ?? score),
          month: Math.round(fg.previous_1_month ?? score),
          year: Math.round(fg.previous_1_year ?? score),
        };
      }
    }
  } catch {
    data = null;
  }

  // 缓存 30 分钟；失败时只缓存 5 分钟，便于尽快重试
  _fgCache = { data, exp: Date.now() + (data ? 30 * 60_000 : 5 * 60_000) };
  return data;
}

// ── 经济数值：FRED（圣路易斯联储数据库），units=pc1 直接拿同比% ──────────────────────

const FRED_SERIES: {
  id: string;
  label: string;
  units: 'pc1' | 'lin';
  unit: string;
  higherIsHot: boolean;
  hint: string;
}[] = [
  { id: 'CPIAUCSL', label: 'CPI 通胀(同比)',   units: 'pc1', unit: '%', higherIsHot: true, hint: '整体消费者物价同比涨幅' },
  { id: 'CPILFESL', label: '核心CPI(同比)',    units: 'pc1', unit: '%', higherIsHot: true, hint: '剔除食品和能源，更稳定' },
  { id: 'PCEPILFE', label: '核心PCE(同比)',    units: 'pc1', unit: '%', higherIsHot: true, hint: '美联储最看重的通胀口径，目标2%' },
  { id: 'UNRATE',   label: '失业率',           units: 'lin', unit: '%', higherIsHot: false, hint: '升高=就业转弱' },
  { id: 'FEDFUNDS', label: '联邦基金利率',     units: 'lin', unit: '%', higherIsHot: true, hint: '当前政策利率(月均)' },
];

let _fredCache: { data: EconIndicator[]; exp: number } | null = null;

async function fetchFredOne(cfg: (typeof FRED_SERIES)[number]): Promise<EconIndicator | null> {
  const key = process.env.FRED_API_KEY;
  if (!key) return null;
  try {
    // sort_order=desc + limit=2 → 最新值 + 上一期（用于趋势箭头）
    const url =
      `https://api.stlouisfed.org/fred/series/observations` +
      `?series_id=${cfg.id}&api_key=${key}&file_type=json` +
      `&sort_order=desc&limit=2&units=${cfg.units}`;
    const res = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(12_000) });
    if (!res.ok) return null;
    const json = await res.json();
    const obs = (json?.observations ?? []).filter((o: any) => o.value !== '.');
    if (!obs.length) return null;
    const latest = obs[0];
    const prev = obs[1];
    return {
      key: cfg.id,
      label: cfg.label,
      value: Number(latest.value),
      unit: cfg.unit,
      date: String(latest.date).slice(0, 7),
      prev: prev ? Number(prev.value) : null,
      higherIsHot: cfg.higherIsHot,
      hint: cfg.hint,
    };
  } catch {
    return null;
  }
}

async function getIndicators(): Promise<EconIndicator[]> {
  if (_fredCache && _fredCache.exp > Date.now()) return _fredCache.data;
  const results = await Promise.all(FRED_SERIES.map(fetchFredOne));
  const data = results.filter((r): r is EconIndicator => r !== null);
  // 宏观月度数据，缓存 6 小时
  _fredCache = { data, exp: Date.now() + 6 * 60 * 60_000 };
  return data;
}

// ── 经济日历：FOMC 决议日期(官方提前公布、写死) + 非农(每月首个周五，规则计算) ───────────

// FOMC 声明发布日 = 两天会议的第二天（官方日程，提前一年公布）
const FOMC_RELEASE_DATES = [
  '2026-01-28', '2026-03-18', '2026-04-29', '2026-06-17',
  '2026-07-29', '2026-09-16', '2026-10-28', '2026-12-16',
  '2027-01-27', '2027-03-17', '2027-04-28', '2027-06-16',
];

function nextNfpFriday(from: Date): Date {
  // 非农就业报告：每月第一个周五 08:30 ET 发布
  const firstFriday = (year: number, month: number) => {
    const d = new Date(Date.UTC(year, month, 1));
    const offset = (5 - d.getUTCDay() + 7) % 7; // 0=周日…5=周五
    return new Date(Date.UTC(year, month, 1 + offset));
  };
  let y = from.getUTCFullYear();
  let m = from.getUTCMonth();
  let cand = firstFriday(y, m);
  if (cand < from) {
    m += 1;
    if (m > 11) { m = 0; y += 1; }
    cand = firstFriday(y, m);
  }
  return cand;
}

function buildCalendar(): CalendarEvent[] {
  const now = new Date();
  const startOfToday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const dayMs = 24 * 60 * 60_000;
  const events: CalendarEvent[] = [];

  const nextFomc = FOMC_RELEASE_DATES
    .map((d) => new Date(`${d}T00:00:00Z`))
    .find((d) => d >= startOfToday);
  if (nextFomc) {
    events.push({
      label: 'FOMC 利率决议',
      date: nextFomc.toISOString().slice(0, 10),
      daysAway: Math.round((nextFomc.getTime() - startOfToday.getTime()) / dayMs),
      note: '美联储议息，公布利率与声明',
    });
  }

  const nfp = nextNfpFriday(startOfToday);
  events.push({
    label: '非农就业报告',
    date: nfp.toISOString().slice(0, 10),
    daysAway: Math.round((nfp.getTime() - startOfToday.getTime()) / dayMs),
    note: '每月首个周五，就业市场风向标',
  });

  return events.sort((a, b) => a.daysAway - b.daysAway);
}

// ── FOMC 声明：官方 RSS → 抓声明正文 → AI 中文摘要（最新 + 上一次 + 措辞变化） ──────────

interface RawStatement {
  date: string;
  title: string;
  url: string;
  text: string;
}

function parseRssStatements(xml: string): { title: string; url: string; pubDate: string }[] {
  const items = xml.match(/<item>[\s\S]*?<\/item>/g) ?? [];
  return items.map((item) => {
    const title =
      item.match(/<title><!\[CDATA\[([\s\S]*?)\]\]><\/title>/)?.[1] ??
      item.match(/<title>([\s\S]*?)<\/title>/)?.[1] ??
      '';
    const url =
      item.match(/<link><!\[CDATA\[([\s\S]*?)\]\]><\/link>/)?.[1] ??
      item.match(/<link>([\s\S]*?)<\/link>/)?.[1] ??
      '';
    const pubDate = item.match(/<pubDate>([\s\S]*?)<\/pubDate>/)?.[1] ?? '';
    return { title: title.trim(), url: url.trim(), pubDate: pubDate.trim() };
  });
}

function extractStatementText(html: string): string {
  // 声明正文在 <div id="article"> 内。抓取后剥标签、压空白，
  // 并在已知页脚/附注标记处截断，避免把投票名单和"Implementation Note"塞进摘要。
  const start = html.indexOf('<div id="article">');
  if (start < 0) return '';
  let body = html.slice(start);
  body = body.replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
  body = body.replace(/\s+/g, ' ').trim();

  for (const marker of ['Implementation Note', 'Voting for the', 'For media inquiries', 'Last Update']) {
    const idx = body.indexOf(marker);
    if (idx > 200) { body = body.slice(0, idx); break; }
  }
  return body.slice(0, 2600).trim();
}

async function fetchStatements(): Promise<RawStatement[]> {
  const res = await fetch('https://www.federalreserve.gov/feeds/press_monetary.xml', {
    headers: { 'User-Agent': UA },
    cache: 'no-store',
    signal: AbortSignal.timeout(12_000),
  });
  if (!res.ok) return [];
  const xml = await res.text();
  const statements = parseRssStatements(xml)
    .filter((i) => /FOMC statement/i.test(i.title))
    .slice(0, 2);

  const out: RawStatement[] = [];
  for (const s of statements) {
    try {
      const pageRes = await fetch(s.url, {
        headers: { 'User-Agent': UA },
        cache: 'no-store',
        signal: AbortSignal.timeout(12_000),
      });
      if (!pageRes.ok) continue;
      const html = await pageRes.text();
      const text = extractStatementText(html);
      if (!text) continue;
      const d = s.pubDate ? new Date(s.pubDate) : null;
      out.push({
        date: d && !isNaN(d.getTime()) ? d.toISOString().slice(0, 10) : '',
        title: s.title,
        url: s.url,
        text,
      });
    } catch {
      /* 跳过这条 */
    }
  }
  return out;
}

function buildFomcPrompt(statements: RawStatement[]): string {
  const latest = statements[0];
  const prev = statements[1];
  const prevBlock = prev
    ? `\n\n【上一次声明 · ${prev.date}】\n${prev.text}`
    : '';

  return `你是宏观固收分析师，面向需要快速做投资决定的个人投资者。下面是美联储最近的 FOMC 货币政策声明英文原文。

【最新声明 · ${latest.date}】
${latest.text}${prevBlock}

任务：用简体中文输出三部分，严格按下面格式（标签必须完全一致）。

LATEST:
[针对"最新声明"写一段 4~6 句话的摘要：①利率决定，要写出具体目标区间和是维持/加息/降息；②对经济增长、就业、通胀的判断；③前瞻指引/对后续动作的措辞；④整体语气偏鹰(收紧)还是偏鸽(宽松)。直接写正文，不要小标题。]

PREVIOUS:
[针对"上一次声明"写一段 3~4 句话的摘要，同样涵盖利率与基调；如果没有提供上一次声明，就写"（无上一次声明数据）"。]

CHANGES:
• [较上次的实质性措辞/立场变化，市场最在意这个。只列真正变了的点，引用变化前后差异。]
• [第二条变化（如有）]
• [若两次基本一致，仅输出一行：与上次基本一致，无重大措辞调整]`;
}

async function aiComplete(prompt: string): Promise<string> {
  const claudeKey = process.env.ANTHROPIC_API_KEY;
  const geminiKey = process.env.GEMINI_API_KEY;

  if (claudeKey) {
    try {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': claudeKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 1400,
          messages: [{ role: 'user', content: prompt }],
        }),
        signal: AbortSignal.timeout(35_000),
      });
      if (res.ok) {
        const data = await res.json();
        const text = data.content?.[0]?.text ?? '';
        if (text) return text;
      }
    } catch {
      /* fall through to gemini */
    }
  }

  if (geminiKey) {
    try {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${geminiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { temperature: 0.2, maxOutputTokens: 1400 },
          }),
          signal: AbortSignal.timeout(35_000),
        },
      );
      if (res.ok) {
        const data = await res.json();
        const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
        if (text) return text;
      }
    } catch {
      /* give up */
    }
  }

  return '';
}

function parseFomcResponse(raw: string): { latest: string; previous: string; changes: string[] } {
  // AI 有时把标签包成 markdown 粗体(**LATEST:**)或用全角冒号，会让下面的分段正则失效，
  // 先去掉所有星号、把标签后的冒号归一化为半角，再切分。
  const clean = raw
    .replace(/\*+/g, '')
    .replace(/(LATEST|PREVIOUS|CHANGES)\s*[:：]/gi, '$1:');
  const latest = clean.match(/LATEST:\s*([\s\S]*?)(?:\n\s*PREVIOUS:|\n\s*CHANGES:|$)/i)?.[1]?.trim() ?? '';
  const previous = clean.match(/PREVIOUS:\s*([\s\S]*?)(?:\n\s*CHANGES:|$)/i)?.[1]?.trim() ?? '';
  const changesBlock = clean.match(/CHANGES:\s*([\s\S]*)$/i)?.[1]?.trim() ?? '';
  const changes = changesBlock
    .split('\n')
    .map((l) => l.replace(/^[•·\-*]\s*/, '').trim())
    .filter((l) => l.length > 3);
  return { latest, previous, changes };
}

let _fomcCache: { data: FomcSummary[]; exp: number } | null = null;

async function getFomc(): Promise<FomcSummary[]> {
  if (_fomcCache && _fomcCache.exp > Date.now()) return _fomcCache.data;

  let data: FomcSummary[] = [];
  try {
    const statements = await fetchStatements();
    if (statements.length) {
      const raw = await aiComplete(buildFomcPrompt(statements));
      const parsed = raw ? parseFomcResponse(raw) : { latest: '', previous: '', changes: [] };

      data = statements.map((s, i) => ({
        date: s.date,
        title: s.title,
        url: s.url,
        summary: i === 0 ? parsed.latest : parsed.previous,
        changes: i === 0 ? parsed.changes : [],
      }));
      // 若 AI 失败导致摘要为空，至少保留原文链接（summary 留空，前端给出兜底提示）
    }
  } catch {
    data = [];
  }

  // 声明一年才 8 次，缓存 12 小时；空结果只缓存 30 分钟便于重试
  const ok = data.some((d) => d.summary);
  _fomcCache = { data, exp: Date.now() + (ok ? 12 * 60 * 60_000 : 30 * 60_000) };
  return data;
}

// ── 主入口 ───────────────────────────────────────────────────────────────────

export async function getMacroData(): Promise<MacroData> {
  const [marketPulse, fearGreed, indicators, fomc] = await Promise.all([
    getMarketPulse(),
    getFearGreed(),
    getIndicators(),
    getFomc(),
  ]);

  return {
    marketPulse,
    fearGreed,
    indicators,
    calendar: buildCalendar(),
    fomc,
    generatedAt: new Date().toISOString(),
  };
}
