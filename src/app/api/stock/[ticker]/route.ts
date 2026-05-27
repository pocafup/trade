import { NextRequest, NextResponse } from 'next/server';
import { getQuoteSummary } from '@/lib/yahoo';

export async function GET(req: NextRequest, { params }: { params: { ticker: string } }) {
  const data = await getQuoteSummary(params.ticker.toUpperCase());
  if (!data) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  return NextResponse.json(data);
}
