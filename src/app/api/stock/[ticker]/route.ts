import { NextRequest, NextResponse } from 'next/server';
import { getQuoteSummary } from '@/lib/yahoo';
import { translateToZh } from '@/lib/translate';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, { params }: { params: { ticker: string } }) {
  const data = await getQuoteSummary(params.ticker.toUpperCase());
  if (!data) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  // Translate business summary (cached 6h — adds ~300ms first time, instant after)
  const desc = data.summary?.summaryProfile?.longBusinessSummary;
  if (desc) {
    (data.summary.summaryProfile as any).longBusinessSummaryZh = await translateToZh(desc);
  }

  return NextResponse.json(data);
}
