import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { getCurrentUserId } from '@/lib/session';

export const dynamic = 'force-dynamic';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

async function batchQuotes(tickers: string[]) {
  if (!tickers.length) return {} as Record<string, { price: number; changePct: number; change: number }>;
  try {
    const res = await fetch(
      `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${tickers.join(',')}&fields=regularMarketPrice,regularMarketChange,regularMarketChangePercent`,
      { headers: { 'User-Agent': UA, Accept: 'application/json' } }
    );
    if (!res.ok) return {};
    const json = await res.json();
    const out: Record<string, { price: number; changePct: number; change: number }> = {};
    for (const q of json?.quoteResponse?.result ?? []) {
      out[q.symbol] = {
        price: q.regularMarketPrice ?? 0,
        change: q.regularMarketChange ?? 0,
        changePct: q.regularMarketChangePercent ?? 0,
      };
    }
    return out;
  } catch {
    return {};
  }
}

export async function GET() {
  const userId = await getCurrentUserId();
  if (userId == null) return NextResponse.json({ error: '未登录' }, { status: 401 });

  const db = getDb();
  const rows = db.prepare('SELECT ticker, name FROM watchlist WHERE user_id = ? ORDER BY added_at DESC').all(userId) as { ticker: string; name: string }[];
  if (!rows.length) return NextResponse.json([]);

  const quotes = await batchQuotes(rows.map(r => r.ticker));
  return NextResponse.json(rows.map(r => ({
    ticker: r.ticker,
    name: r.name,
    price: quotes[r.ticker]?.price ?? 0,
    change: quotes[r.ticker]?.change ?? 0,
    changePct: quotes[r.ticker]?.changePct ?? 0,
  })));
}

export async function POST(req: NextRequest) {
  const userId = await getCurrentUserId();
  if (userId == null) return NextResponse.json({ error: '未登录' }, { status: 401 });

  const { ticker, name } = await req.json();
  if (!ticker) return NextResponse.json({ error: 'ticker required' }, { status: 400 });
  const db = getDb();
  db.prepare('INSERT OR REPLACE INTO watchlist (user_id, ticker, name) VALUES (?, ?, ?)').run(userId, ticker.toUpperCase(), name ?? ticker);
  return NextResponse.json({ ok: true });
}
