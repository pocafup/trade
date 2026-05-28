import { NextRequest, NextResponse } from 'next/server';
import { getNews } from '@/lib/yahoo';
import { translateToZh } from '@/lib/translate';

export const dynamic = 'force-dynamic';

const DAY = 24 * 60 * 60 * 1000;

export async function GET(_req: NextRequest, { params }: { params: { ticker: string } }) {
  const raw = await getNews(params.ticker.toUpperCase());

  // Translate all titles in parallel (each result cached 6h)
  const items = await Promise.all(
    raw.map(async (item) => {
      const ts  = item.pubDate ? new Date(item.pubDate).getTime() : NaN;
      const titleZh = await translateToZh(item.title).catch(() => item.title);
      return { ...item, ts: isNaN(ts) ? 0 : ts, titleZh };
    })
  );

  const now = Date.now();

  const day1 = items.filter(i => i.ts > 0 && now - i.ts <= DAY);
  const day3 = items.filter(i => i.ts > 0 && now - i.ts > DAY && now - i.ts <= 3 * DAY);
  const week = items.filter(i => i.ts > 0 && now - i.ts > 3 * DAY && now - i.ts <= 7 * DAY);

  return NextResponse.json({ day1, day3, week });
}
