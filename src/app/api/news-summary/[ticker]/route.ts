import { NextRequest, NextResponse } from 'next/server';
import { getNewsExpanded } from '@/lib/yahoo';
import { translateToZh } from '@/lib/translate';
import { summarizeNews } from '@/lib/summarize';

export const dynamic = 'force-dynamic';

const DAY = 24 * 60 * 60 * 1000;

export async function GET(_req: NextRequest, { params }: { params: { ticker: string } }) {
  const ticker = params.ticker.toUpperCase();
  const now    = Date.now();

  // 30 articles covering ~2 weeks from Yahoo Finance search API
  const raw = await getNewsExpanded(ticker);

  // Group first (before translation, which is slow)
  const day1Raw = raw.filter(i => now - i.ts <= DAY);
  const day3Raw = raw.filter(i => now - i.ts > DAY     && now - i.ts <= 3 * DAY);
  const weekRaw = raw.filter(i => now - i.ts > 3 * DAY && now - i.ts <= 7 * DAY);

  // Run summaries + translations in parallel
  const [sum1, sum3, sumW, day1Items, day3Items, weekItems] = await Promise.all([
    summarizeNews(ticker, '今日（24小时内）', day1Raw.map(i => i.title)),
    summarizeNews(ticker, '近3天',           day3Raw.map(i => i.title)),
    summarizeNews(ticker, '近一周',          weekRaw.map(i => i.title)),

    Promise.all(day1Raw.map(async i => ({ ...i, titleZh: await translateToZh(i.title).catch(() => i.title) }))),
    Promise.all(day3Raw.map(async i => ({ ...i, titleZh: await translateToZh(i.title).catch(() => i.title) }))),
    Promise.all(weekRaw.map(async i => ({ ...i, titleZh: await translateToZh(i.title).catch(() => i.title) }))),
  ]);

  return NextResponse.json({
    day1: { items: day1Items, summary: sum1 },
    day3: { items: day3Items, summary: sum3 },
    week: { items: weekItems, summary: sumW },
  });
}
