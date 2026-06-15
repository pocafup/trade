import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { getCurrentUserId } from '@/lib/session';
import { getChart } from '@/lib/yahoo';

export const dynamic = 'force-dynamic';

interface Txn { ticker: string; type: 'buy' | 'sell'; quantity: number; date: string; }

const cache = new Map<string, { data: unknown; expiry: number }>();

export async function GET(req: NextRequest) {
  const userId = await getCurrentUserId();
  if (userId == null) return NextResponse.json({ error: '未登录' }, { status: 401 });

  const range = new URL(req.url).searchParams.get('range') ?? '1y';
  const cacheKey = `${userId}:${range}`;
  const cached = cache.get(cacheKey);
  if (cached && cached.expiry > Date.now()) return NextResponse.json(cached.data);

  const db = getDb();
  const txns = db.prepare('SELECT ticker, type, quantity, date FROM transactions WHERE user_id = ? ORDER BY date ASC').all(userId) as unknown as Txn[];
  if (!txns.length) return NextResponse.json([]);

  const tickers = [...new Set(txns.map(t => t.ticker))];
  const yfRange = range === 'max' ? '5y' : range;

  const chartResults = await Promise.all(tickers.map(t => getChart(t, yfRange)));

  // priceMap: ticker -> (dayStartMs -> price)
  const priceMap = new Map<string, Map<number, number>>();
  for (let i = 0; i < tickers.length; i++) {
    const cd = chartResults[i];
    if (!cd?.points?.length) continue;
    const m = new Map<number, number>();
    for (const pt of cd.points) {
      const d = new Date(pt.t); d.setUTCHours(0, 0, 0, 0);
      m.set(d.getTime(), pt.p);
    }
    priceMap.set(tickers[i], m);
  }

  // Sorted union of all trading days
  const allDays = new Set<number>();
  for (const [, m] of priceMap) for (const [d] of m) allDays.add(d);
  const sortedDays = Array.from(allDays).sort((a, b) => a - b);

  // Forward-fill prices per ticker so weekend/holiday gaps don't break the chart
  const priceSeries = new Map<string, number[]>();
  for (const ticker of tickers) {
    const m = priceMap.get(ticker);
    const series: number[] = [];
    let last = 0;
    for (const day of sortedDays) {
      const p = m?.get(day);
      if (p != null) last = p;
      series.push(last);
    }
    priceSeries.set(ticker, series);
  }

  // Process transactions chronologically, compute portfolio value per day
  const holdingsState = new Map<string, number>();
  const sortedTxns = [...txns].sort((a, b) => a.date.localeCompare(b.date));
  let txnIdx = 0;

  const result: { t: number; p: number }[] = [];

  for (let di = 0; di < sortedDays.length; di++) {
    const dayMs = sortedDays[di];

    // Apply all transactions up to this day
    while (txnIdx < sortedTxns.length) {
      const txn = sortedTxns[txnIdx];
      const txnDay = new Date(txn.date); txnDay.setUTCHours(0, 0, 0, 0);
      if (txnDay.getTime() > dayMs) break;
      const cur = holdingsState.get(txn.ticker) ?? 0;
      holdingsState.set(txn.ticker, txn.type === 'buy' ? cur + txn.quantity : cur - txn.quantity);
      txnIdx++;
    }

    let value = 0;
    for (const [ticker, shares] of holdingsState) {
      if (shares <= 0.0001) continue;
      const price = priceSeries.get(ticker)?.[di] ?? 0;
      value += shares * price;
    }
    if (value > 0) result.push({ t: dayMs, p: value });
  }

  cache.set(cacheKey, { data: result, expiry: Date.now() + 5 * 60_000 });
  return NextResponse.json(result);
}
