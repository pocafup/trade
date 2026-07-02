import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { getCurrentUserId } from '@/lib/session';
import {
  QTY_EPS,
  round8,
  computeOpenLots,
  fifoAllocate,
  validateAllocations,
  type BuyTxn,
  type AllocInput,
} from '@/lib/lots';

export const dynamic = 'force-dynamic';

export async function GET() {
  const userId = await getCurrentUserId();
  if (userId == null) return NextResponse.json({ error: '未登录' }, { status: 401 });

  const db = getDb();
  const rows = db
    .prepare('SELECT * FROM transactions WHERE user_id = ? ORDER BY date DESC, created_at DESC')
    .all(userId);
  return NextResponse.json(rows);
}

export async function POST(req: NextRequest) {
  const userId = await getCurrentUserId();
  if (userId == null) return NextResponse.json({ error: '未登录' }, { status: 401 });

  const { ticker, name, type, quantity, price, date, notes, allocations } = await req.json();

  const qty = Number(quantity);
  const prc = Number(price);
  if (
    !ticker || !date ||
    (type !== 'buy' && type !== 'sell') ||
    !Number.isFinite(qty) || qty <= 0 ||
    !Number.isFinite(prc) || prc < 0
  ) {
    return NextResponse.json({ error: '参数无效：股数需大于 0，价格不能为负' }, { status: 400 });
  }

  const db = getDb();
  const tickerU = (ticker as string).toUpperCase().trim();
  const insertTxn = db.prepare(
    `INSERT INTO transactions (user_id, ticker, name, type, quantity, price, date, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  // 买入：直接开新批次，无需校验持仓
  if (type === 'buy') {
    const result = insertTxn.run(userId, tickerU, name || '', type, qty, prc, date, notes || '');
    return NextResponse.json({ id: Number(result.lastInsertRowid) }, { status: 201 });
  }

  // 卖出：必须能分配到买入批次（防超卖）。校验 + 写入放在同一个写事务里，
  // 避免并发请求在"查剩余量"和"插入"之间互相穿插导致超卖。
  db.exec('BEGIN IMMEDIATE');
  try {
    const buys = db
      .prepare(
        `SELECT id, quantity, price, date, created_at FROM transactions
         WHERE user_id = ? AND ticker = ? AND type = 'buy'`,
      )
      .all(userId, tickerU) as unknown as BuyTxn[];
    const existing = db
      .prepare(
        `SELECT sa.buy_txn_id, sa.quantity
         FROM sell_allocations sa
         JOIN transactions b ON b.id = sa.buy_txn_id
         WHERE b.user_id = ? AND b.ticker = ?`,
      )
      .all(userId, tickerU) as unknown as AllocInput[];

    let allocs: AllocInput[];
    if (Array.isArray(allocations) && allocations.length > 0) {
      // 前端显式勾选了批次：逐项校验（存在性/归属/日期/剩余量/合计）
      const cleaned: AllocInput[] = allocations.map((a: any) => ({
        buy_txn_id: Number(a?.buy_txn_id),
        quantity: Number(a?.quantity),
      }));
      const openLots = computeOpenLots(buys, existing);
      const v = validateAllocations({ quantity: qty, date }, cleaned, openLots);
      if (!v.ok) {
        db.exec('ROLLBACK');
        return NextResponse.json({ error: v.error }, { status: 400 });
      }
      allocs = cleaned.map((a) => ({ ...a, quantity: round8(a.quantity) }));
    } else {
      // 未带分配（旧客户端/脚本）：服务端按 FIFO 自动分配，不够卖直接拒绝
      const openLots = computeOpenLots(buys, existing, date);
      const { allocations: auto, unallocated } = fifoAllocate(qty, openLots);
      if (unallocated > QTY_EPS) {
        const available = round8(openLots.reduce((s, l) => s + l.remaining, 0));
        db.exec('ROLLBACK');
        return NextResponse.json(
          { error: `持仓不足：截至 ${date} 可卖批次共 ${available} 股，无法卖出 ${qty} 股` },
          { status: 400 },
        );
      }
      allocs = auto;
    }

    const result = insertTxn.run(userId, tickerU, name || '', type, qty, prc, date, notes || '');
    const sellId = Number(result.lastInsertRowid);
    const insAlloc = db.prepare(
      'INSERT INTO sell_allocations (sell_txn_id, buy_txn_id, quantity) VALUES (?, ?, ?)',
    );
    for (const a of allocs) insAlloc.run(sellId, a.buy_txn_id, a.quantity);

    db.exec('COMMIT');
    return NextResponse.json({ id: sellId }, { status: 201 });
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch {}
    throw err;
  }
}
