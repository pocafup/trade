import { NextResponse } from 'next/server';
import { getQuote } from '@/lib/yahoo';

export const dynamic = 'force-dynamic';

export async function GET() {
  const start = Date.now();
  try {
    const q = await getQuote('AAPL');
    return NextResponse.json({
      ok: q !== null,
      ticker: 'AAPL',
      price: q?.price ?? null,
      marketState: q?.marketState ?? null,
      latencyMs: Date.now() - start,
    });
  } catch (err) {
    return NextResponse.json({
      ok: false,
      error: String(err),
      latencyMs: Date.now() - start,
    }, { status: 502 });
  }
}
