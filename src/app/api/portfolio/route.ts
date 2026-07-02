import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { getCurrentUserId } from '@/lib/session';
import { getQuote, getYearStartPrice, getDividends } from '@/lib/yahoo';
import {
  computeOpenLots,
  weightedAvgCost,
  sellRealizedPnl,
  fallbackCostForSell,
  type AllocInput,
} from '@/lib/lots';

export const dynamic = 'force-dynamic';

interface Txn {
  id: number;
  ticker: string;
  name: string;
  type: 'buy' | 'sell';
  quantity: number;
  price: number;
  date: string;
  created_at: string;
}

export async function GET() {
  const userId = await getCurrentUserId();
  if (userId == null) return NextResponse.json({ error: '未登录' }, { status: 401 });

  const db = getDb();
  const txns = db.prepare('SELECT * FROM transactions WHERE user_id = ? ORDER BY date ASC').all(userId) as unknown as Txn[];

  const byTicker = new Map<string, { txns: Txn[]; name: string }>();
  for (const t of txns) {
    if (!byTicker.has(t.ticker)) byTicker.set(t.ticker, { txns: [], name: t.name });
    byTicker.get(t.ticker)!.txns.push(t);
  }

  // 批次分配：每笔卖出对应哪些买入批次、各多少股（具体识别法的数据基础）
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

  const tickers = Array.from(byTicker.keys());
  const quotes = await Promise.all(tickers.map((t) => getQuote(t)));
  const quoteMap = new Map(tickers.map((t, i) => [t, quotes[i]]));

  const yearStart = `${new Date().getFullYear()}-01-01`;

  // YTD 已实现盈亏：今年以来每笔卖出按"具体识别法"计算——
  // 卖了哪个批次，就用哪个批次的买价做成本：Σ(卖价 − 该批买价) × 分配股数。
  // 迁移前的老卖出已按 FIFO 回填分配；个别无法配对的存量超卖残量走 fallback（历史买入均价）。
  let ytdPnl = 0;
  for (const [, { txns }] of byTicker) {
    const buys = txns.filter((t) => t.type === 'buy');
    for (const txn of txns) {
      if (txn.type !== 'sell' || txn.date < yearStart) continue;
      ytdPnl += sellRealizedPnl(
        txn.quantity,
        txn.price,
        allocsBySell.get(txn.id) ?? [],
        fallbackCostForSell(buys, txn.date, txn.price),
      );
    }
  }

  // 年初持仓：每个 ticker 在 yearStart 前所有交易的净持股数
  const sharesAtYearStart = new Map<string, number>();
  for (const [ticker, { txns }] of byTicker) {
    let s = 0;
    for (const t of txns) {
      if (t.date >= yearStart) break;
      s += t.type === 'buy' ? t.quantity : -t.quantity;
    }
    if (s > 0.0001) sharesAtYearStart.set(ticker, s);
  }

  // 获取年初有持仓的 ticker 的第一个交易日收盘价
  const ytdStartPriceMap = new Map<string, number>();
  await Promise.all(
    Array.from(sharesAtYearStart.keys()).map(async (ticker) => {
      const price = await getYearStartPrice(ticker);
      if (price > 0) ytdStartPriceMap.set(ticker, price);
    })
  );

  // 年初组合市值：年初持股 × 年初价格
  // 若取不到年初价格则用该股票的历史均价兜底
  let jan1PortfolioValue = 0;
  for (const [ticker, shares] of sharesAtYearStart) {
    const jan1Price = ytdStartPriceMap.get(ticker);
    if (jan1Price) {
      jan1PortfolioValue += shares * jan1Price;
    } else {
      // 兜底：用年初前所有买入的加权均价
      const preBuys = byTicker.get(ticker)!.txns.filter(
        (t) => t.date < yearStart && t.type === 'buy'
      );
      const cost = preBuys.reduce((s, t) => s + t.quantity * t.price, 0);
      const qty  = preBuys.reduce((s, t) => s + t.quantity, 0);
      jan1PortfolioValue += shares * (qty > 0 ? cost / qty : 0);
    }
  }

  // 今年买入成本 & 卖出收入
  let ytdBuyCosts = 0, ytdSellProceeds = 0;
  for (const [, { txns }] of byTicker) {
    for (const t of txns) {
      if (t.date < yearStart) continue;
      if (t.type === 'buy') ytdBuyCosts    += t.quantity * t.price;
      else                  ytdSellProceeds += t.quantity * t.price;
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

    // 持仓成本 = 剩余批次的加权成本（具体识别法）：卖掉某批后，成本只反映还没卖的批次。
    // 例：10股@100 + 10股@200，卖掉 @100 那批后成本是 200，而不是历史均价 150。
    const openLots = computeOpenLots(buys, allocsByTicker.get(ticker) ?? []);
    let avgCost = weightedAvgCost(openLots);
    if (avgCost === 0 && shares > 0.0001) {
      // 存量超卖的"幽灵仓"：净持股为正但批次已全部耗尽（历史数据不一致），
      // 回退到终身买入均价，避免显示 0 成本
      const totalBuyCost = buys.reduce((s, t) => s + t.quantity * t.price, 0);
      avgCost = totalBuyCost / sharesBought;
    }

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

  // ── Cash flow computations ───────────────────────────────────────────────────
  const cashFlows = db.prepare(
    'SELECT type, amount, date FROM cash_flows WHERE user_id = ? ORDER BY date ASC',
  ).all(userId) as { type: string; amount: number; date: string }[];

  // Net cash spent on stocks across all time (buys - sells, by proceeds)
  const netStockSpend = txns.reduce(
    (s, t) => s + (t.type === 'buy' ? t.quantity * t.price : -t.quantity * t.price),
    0,
  );

  // Remaining cash = deposits - withdrawals - money currently in stocks
  const totalDeposited  = cashFlows.filter(cf => cf.type === 'deposit').reduce((s, cf) => s + cf.amount, 0);
  const totalWithdrawn  = cashFlows.filter(cf => cf.type === 'withdrawal').reduce((s, cf) => s + cf.amount, 0);
  const currentCash     = cashFlows.length > 0
    ? totalDeposited - totalWithdrawn - netStockSpend
    : -netStockSpend; // default: negative = "not configured yet"

  // 今年净赚 = 当前市值 + 今年卖出收入 − 年初组合市值 − 今年买入成本
  // 等价于：年初以来每只股票的价格变动 × 持有数量之和
  const ytdNetPnl = totalValue + ytdSellProceeds - jan1PortfolioValue - ytdBuyCosts;

  // YTD 分红：对每只 ticker 抓取除权日 + 每股金额，乘以当天持股数
  // 除权日当天或之前持股才算收到分红（Yahoo events.dividends 用除权日，不是派息日）
  const allDivData = await Promise.all(
    Array.from(byTicker.keys()).map((t) => getDividends(t))
  );
  const divMap = new Map(
    Array.from(byTicker.keys()).map((t, i) => [t, allDivData[i]])
  );

  let ytdDividends = 0;
  for (const [ticker, { txns }] of byTicker) {
    const divs = divMap.get(ticker) ?? [];
    for (const div of divs) {
      const divDateStr = new Date(div.date).toISOString().split('T')[0];
      if (divDateStr < yearStart) continue;   // 只算今年的分红
      // 计算除权日当天持股数（txns 按 date ASC 排序）
      let sharesHeld = 0;
      for (const txn of txns) {
        if (txn.date > divDateStr) break;
        sharesHeld += txn.type === 'buy' ? txn.quantity : -txn.quantity;
      }
      if (sharesHeld > 0.0001) ytdDividends += sharesHeld * div.amount;
    }
  }

  // Annual return: (ytdNetPnl + ytdDividends) / Σ(daily cumulative balance) * 365
  // Daily balance = cumulative net deposits (cash flow-based, per the Modified Dietz approach)
  let annualReturn: number | null = null;
  if (cashFlows.length > 0) {
    // Balance carried into Jan 1 from prior-year flows
    let balAtYearStart = 0;
    for (const cf of cashFlows) {
      if (cf.date >= yearStart) break;
      balAtYearStart += cf.type === 'deposit' ? cf.amount : -cf.amount;
    }

    // Build day-of-year delta map
    const dailyDelta = new Map<string, number>();
    for (const cf of cashFlows) {
      if (cf.date < yearStart) continue;
      const d = cf.type === 'deposit' ? cf.amount : -cf.amount;
      dailyDelta.set(cf.date, (dailyDelta.get(cf.date) ?? 0) + d);
    }

    // Sum cumulative balance over every day Jan 1 → today
    const todayDate = new Date(); todayDate.setHours(0, 0, 0, 0);
    const startDate = new Date(yearStart + 'T00:00:00');
    let cum = balAtYearStart, dailySum = 0;
    const cur = new Date(startDate);
    while (cur <= todayDate) {
      const ds = cur.toISOString().split('T')[0];
      cum += dailyDelta.get(ds) ?? 0;
      dailySum += cum;
      cur.setDate(cur.getDate() + 1);
    }

    if (dailySum > 0) annualReturn = ((ytdNetPnl + ytdDividends) / dailySum) * 365 * 100;
  }

  return NextResponse.json({
    holdings,
    summary: {
      totalValue,
      totalCost,
      totalPnl: totalValue - totalCost,
      totalPnlPct: totalCost > 0 ? ((totalValue - totalCost) / totalCost) * 100 : 0,
      ytdPnl,
      ytdPnlPct: totalCost > 0 ? (ytdPnl / totalCost) * 100 : 0,
      currentCash,
      ytdNetPnl: ytdNetPnl + ytdDividends,
      ytdDividends,
      annualReturn,
    },
  });
}
