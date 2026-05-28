import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { getQuote } from '@/lib/yahoo';

export const dynamic = 'force-dynamic';

interface Txn {
  ticker: string; name: string; type: 'buy' | 'sell';
  quantity: number; price: number; date: string;
}

export interface PnlRecord {
  ticker: string; name: string; status: 'open' | 'closed';
  realizedPnl: number; unrealizedPnl: number; totalPnl: number;
  currentShares: number; currentPrice: number; avgCost: number;
  firstBuyDate: string; lastActivityDate: string; holdingDays: number;
}

export async function GET() {
  const db = getDb();
  const txns = db.prepare('SELECT ticker, name, type, quantity, price, date FROM transactions ORDER BY date ASC').all() as unknown as Txn[];

  const byTicker = new Map<string, { txns: Txn[]; name: string }>();
  for (const t of txns) {
    if (!byTicker.has(t.ticker)) byTicker.set(t.ticker, { txns: [], name: t.name });
    byTicker.get(t.ticker)!.txns.push(t);
  }

  // Identify open tickers for live price fetch
  const openTickers: string[] = [];
  for (const [ticker, { txns }] of byTicker) {
    const shares = txns.reduce((s, t) => s + (t.type === 'buy' ? t.quantity : -t.quantity), 0);
    if (shares > 0.0001) openTickers.push(ticker);
  }
  const quotes = await Promise.all(openTickers.map(t => getQuote(t)));
  const quoteMap = new Map(openTickers.map((t, i) => [t, quotes[i]]));

  const result: PnlRecord[] = [];

  for (const [ticker, { txns, name }] of byTicker) {
    let avgCost = 0, shares = 0, costBasis = 0, realizedPnl = 0;

    for (const txn of txns) {
      if (txn.type === 'buy') {
        costBasis += txn.quantity * txn.price;
        shares += txn.quantity;
        avgCost = costBasis / shares;
      } else {
        realizedPnl += txn.quantity * (txn.price - avgCost);
        shares -= txn.quantity;
        costBasis = shares > 0 ? shares * avgCost : 0;
        if (shares < 0.0001) shares = 0;
      }
    }

    const isOpen = shares > 0.0001;
    const q = quoteMap.get(ticker);
    const currentPrice = q?.price ?? 0;
    const unrealizedPnl = isOpen ? shares * (currentPrice - avgCost) : 0;

    const firstBuy = txns.find(t => t.type === 'buy')!;
    const lastTxn  = txns[txns.length - 1];
    const firstDate = new Date(firstBuy.date);
    const endDate   = isOpen ? new Date() : new Date(lastTxn.date);
    const holdingDays = Math.max(1, Math.ceil((endDate.getTime() - firstDate.getTime()) / 86_400_000));

    result.push({
      ticker,
      name: (q as any)?.name ?? name,
      status: isOpen ? 'open' : 'closed',
      realizedPnl,
      unrealizedPnl,
      totalPnl: realizedPnl + unrealizedPnl,
      currentShares: isOpen ? shares : 0,
      currentPrice,
      avgCost: isOpen ? avgCost : 0,
      firstBuyDate: firstBuy.date,
      lastActivityDate: lastTxn.date,
      holdingDays,
    });
  }

  result.sort((a, b) => b.totalPnl - a.totalPnl);
  return NextResponse.json(result);
}
