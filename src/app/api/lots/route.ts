import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { getCurrentUserId } from '@/lib/session';
import { computeOpenLots, round8, type BuyTxn, type AllocInput } from '@/lib/lots';

export const dynamic = 'force-dynamic';

/**
 * GET /api/lots?ticker=AAPL
 * 返回当前用户在该股票上的开放批次（还有剩余可卖数量的买入），
 * 供卖出弹窗勾选。剩余 = 买入股数 − 已分配给各笔卖出的数量。
 */
export async function GET(req: NextRequest) {
  const userId = await getCurrentUserId();
  if (userId == null) return NextResponse.json({ error: '未登录' }, { status: 401 });

  const ticker = req.nextUrl.searchParams.get('ticker')?.toUpperCase().trim();
  if (!ticker) return NextResponse.json({ error: '缺少 ticker' }, { status: 400 });

  const db = getDb();
  const buys = db
    .prepare(
      `SELECT id, quantity, price, date, created_at FROM transactions
       WHERE user_id = ? AND ticker = ? AND type = 'buy'`,
    )
    .all(userId, ticker) as unknown as BuyTxn[];

  const allocs = db
    .prepare(
      `SELECT sa.buy_txn_id, sa.quantity
       FROM sell_allocations sa
       JOIN transactions b ON b.id = sa.buy_txn_id
       WHERE b.user_id = ? AND b.ticker = ?`,
    )
    .all(userId, ticker) as unknown as AllocInput[];

  const lots = computeOpenLots(buys, allocs);
  return NextResponse.json({
    ticker,
    lots,
    totalRemaining: round8(lots.reduce((s, l) => s + l.remaining, 0)),
  });
}
