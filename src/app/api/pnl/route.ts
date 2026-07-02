import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { getCurrentUserId } from '@/lib/session';
import { getQuote } from '@/lib/yahoo';
import {
  computeOpenLots,
  weightedAvgCost,
  sellRealizedPnl,
  fallbackCostForSell,
  round8,
  type AllocInput,
} from '@/lib/lots';

export const dynamic = 'force-dynamic';

interface Txn {
  id: number; ticker: string; name: string; type: 'buy' | 'sell';
  quantity: number; price: number; date: string; created_at: string;
}

export interface PnlRecord {
  ticker: string; name: string; status: 'open' | 'closed';
  realizedPnl: number; unrealizedPnl: number; totalPnl: number;
  currentShares: number; currentPrice: number; avgCost: number;
  firstBuyDate: string; lastActivityDate: string; holdingDays: number;
}

export async function GET() {
  const userId = await getCurrentUserId();
  if (userId == null) return NextResponse.json({ error: '未登录' }, { status: 401 });

  const db = getDb();
  const txns = db.prepare('SELECT id, ticker, name, type, quantity, price, date, created_at FROM transactions WHERE user_id = ? ORDER BY date ASC').all(userId) as unknown as Txn[];

  const byTicker = new Map<string, { txns: Txn[]; name: string }>();
  for (const t of txns) {
    if (!byTicker.has(t.ticker)) byTicker.set(t.ticker, { txns: [], name: t.name });
    byTicker.get(t.ticker)!.txns.push(t);
  }

  // 批次分配（具体识别法的数据基础）：每笔卖出 → [{该批买价, 分配股数}]
  const allocRows = db
    .prepare(
      `SELECT sa.sell_txn_id, sa.buy_txn_id, sa.quantity, b.price AS buy_price, b.ticker
       FROM sell_allocations sa
       JOIN transactions b ON b.id = sa.buy_txn_id
       WHERE b.user_id = ?`,
    )
    .all(userId) as unknown as {
    sell_txn_id: number; buy_txn_id: number; quantity: number; buy_price: number; ticker: string;
  }[];
  const allocsBySell = new Map<number, { quantity: number; buy_price: number }[]>();
  const allocsByTicker = new Map<string, AllocInput[]>();
  for (const a of allocRows) {
    if (!allocsBySell.has(a.sell_txn_id)) allocsBySell.set(a.sell_txn_id, []);
    allocsBySell.get(a.sell_txn_id)!.push({ quantity: a.quantity, buy_price: a.buy_price });
    if (!allocsByTicker.has(a.ticker)) allocsByTicker.set(a.ticker, []);
    allocsByTicker.get(a.ticker)!.push({ buy_txn_id: a.buy_txn_id, quantity: a.quantity });
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
    const buys = txns.filter((t) => t.type === 'buy');

    // 已实现盈亏：具体识别法，每笔卖出 = Σ(卖价 − 所卖批次买价) × 分配股数。
    // 无法配对的存量超卖残量按卖出日前的买入均价兜底（见 lots.ts）。
    let realizedPnl = 0;
    for (const txn of txns) {
      if (txn.type !== 'sell') continue;
      realizedPnl += sellRealizedPnl(
        txn.quantity,
        txn.price,
        allocsBySell.get(txn.id) ?? [],
        fallbackCostForSell(buys, txn.date, txn.price),
      );
    }

    // 净持股 = Σ买 − Σ卖；持仓成本 = 剩余批次的加权成本（与 /api/portfolio 同口径）
    const netShares = round8(txns.reduce((s, t) => s + (t.type === 'buy' ? t.quantity : -t.quantity), 0));
    const shares = netShares < 0.0001 ? 0 : netShares;
    const openLots = computeOpenLots(buys, allocsByTicker.get(ticker) ?? []);
    let avgCost = weightedAvgCost(openLots);
    if (avgCost === 0 && shares > 0.0001) {
      // 存量超卖的"幽灵仓"：批次耗尽但净持股为正，回退终身买入均价
      const totalBuyCost = buys.reduce((s, t) => s + t.quantity * t.price, 0);
      const totalBuyQty = buys.reduce((s, t) => s + t.quantity, 0);
      avgCost = totalBuyQty > 0 ? totalBuyCost / totalBuyQty : 0;
    }

    const isOpen = shares > 0.0001;
    const q = quoteMap.get(ticker);
    const currentPrice = q?.price ?? 0;
    const unrealizedPnl = isOpen ? shares * (currentPrice - avgCost) : 0;

    const firstBuy = txns.find(t => t.type === 'buy') ?? txns[0]; // 只有卖出的异常数据兜底
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
