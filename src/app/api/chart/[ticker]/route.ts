import { NextRequest, NextResponse } from 'next/server';
import { getChart } from '@/lib/yahoo';

export const dynamic = 'force-dynamic';

const VALID_RANGES = new Set(['1d', '5d', '1mo', '3mo', '1y', '5y']);

export async function GET(req: NextRequest, { params }: { params: { ticker: string } }) {
  const range = req.nextUrl.searchParams.get('range') ?? '1d';
  if (!VALID_RANGES.has(range)) return NextResponse.json({ error: 'Invalid range' }, { status: 400 });

  const data = await getChart(params.ticker.toUpperCase(), range);
  if (!data) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  return NextResponse.json(data);
}
