import { NextResponse } from 'next/server';
import { getQuote, getQuoteSummary } from '@/lib/yahoo';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const ticker = new URL(req.url).searchParams.get('t') ?? 'AAPL';
  const start = Date.now();

  const [quote, summary] = await Promise.all([
    getQuote(ticker).catch((e: unknown) => ({ error: String(e) })),
    getQuoteSummary(ticker).catch((e: unknown) => ({ error: String(e) })),
  ]);

  return NextResponse.json({
    ticker,
    latencyMs: Date.now() - start,
    quote: {
      ok: quote !== null && !('error' in (quote as object)),
      price: (quote as any)?.price ?? null,
      error: (quote as any)?.error ?? null,
    },
    earnings: {
      historyLength: (summary as any)?.summary?.earningsHistory?.length ?? 0,
      sample: (summary as any)?.summary?.earningsHistory?.slice(0, 1) ?? null,
      summaryOk: summary !== null && !('error' in (summary as object)),
      error: (summary as any)?.error ?? null,
    },
  });
}
