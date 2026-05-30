import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { getQuote } from '@/lib/yahoo';

export const dynamic = 'force-dynamic';

interface Txn {
  ticker: string;
  name: string;
  type: 'buy' | 'sell';
  quantity: number;
  price: number;
  date: string;
}

export async function GET() {
  const db = getDb();
  const txns = db.prepare('SELECT * FROM transactions ORDER BY date ASC').all() as unknown as Txn[];

  const byTicker = new Map<string, { txns: Txn[]; name: string }>();
  for (const t of txns) {
    if (!byTicker.has(t.ticker)) byTicker.set(t.ticker, { txns: [], name: t.name });
    byTicker.get(t.ticker)!.txns.push(t);
  }

  const tickers = Array.from(byTicker.keys());
  const quotes = await Promise.all(tickers.map((t) => getQuote(t)));
  const quoteMap = new Map(tickers.map((t, i) => [t, quotes[i]]));

  // YTD realized P&L: gains from sell transactions since Jan 1 of current year
  const yearStart = `${new Date().getFullYear()}-01-01`;
  let ytdPnl = 0;
  for (const [, { txns }] of byTicker) {
    let avgCost = 0, shares = 0;
    for (const txn of txns) {
      if (txn.type === 'buy') {
        const totalCostBasis = shares * avgCost + txn.quantity * txn.price;
        shares += txn.quantity;
        avgCost = totalCostBasis / shares;
      } else {
        if (txn.date >= yearStart) ytdPnl += txn.quantity * (txn.price - avgCost);
        shares -= txn.quantity;
        if (shares < 0.0001) { shares = 0; avgCost = 0; }
      }
    }
  }

  const holdings = [];
  let totalValue = 0;
  let totalCost = 0;

  for (const [ticker, { txns, name }] of byTicker) {
    const buys = txns.filter((t) => t.type === 'buy');
    const sells = txns.filter((t) => t.type === 'sell');

    const sharesBought = buys.reduce((s, t) => s + t.quantity, 0);
    const sharesSold = sells.reduce((s, t) => s + t.quantity, 0);
    const shares = parseFloat((sharesBought - sharesSold).toFixed(8));

    if (shares <= 0.0001) continue;

    const totalBuyCost = buys.reduce((s, t) => s + t.quantity * t.price, 0);
    const avgCost = totalBuyCost / sharesBought;

    const q = quoteMap.get(ticker);
    const currentPrice = q?.price ?? 0;
    const currentValue = shares * currentPrice;
    const costBasis = shares * avgCost;
    const pnl = currentValue - costBasis;
    const pnlPct = costBasis > 0 ? (pnl / costBasis) * 100 : 0;

    totalValue += currentValue;
    totalCost += costBasis;

    holdings.push({
      ticker,
      name: (q as any)?.name || name || ticker,
      shares,
      avgCost,
      currentPrice,
      currentValue,
      costBasis,
      pnl,
      pnlPct,
      dayChange: q?.change ?? 0,
      dayChangePct: q?.changePct ?? 0,
      portfolioPct: 0,
    });
  }

  for (const h of holdings) {
    h.portfolioPct = totalValue > 0 ? (h.currentValue / totalValue) * 100 : 0;
  }

  holdings.sort((a, b) => b.currentValue - a.currentValue);

  return NextResponse.json({
    holdings,
    summary: {
      totalValue,
      totalCost,
      totalPnl: totalValue - totalCost,
      totalPnlPct: totalCost > 0 ? ((totalValue - totalCost) / totalCost) * 100 : 0,
      ytdPnl,
      ytdPnlPct: totalCost > 0 ? (ytdPnl / totalCost) * 100 : 0,
    },
  });
}
