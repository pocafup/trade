import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { getCurrentUserId } from '@/lib/session';

export const dynamic = 'force-dynamic';

export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  const userId = await getCurrentUserId();
  if (userId == null) return NextResponse.json({ error: '未登录' }, { status: 401 });

  const db = getDb();
  const id = Number(params.id);
  const row = db
    .prepare('SELECT id, type FROM transactions WHERE id = ? AND user_id = ?')
    .get(id, userId) as { id: number; type: 'buy' | 'sell' } | undefined;
  if (!row) return NextResponse.json({ error: '记录不存在' }, { status: 404 });

  if (row.type === 'buy') {
    // 已被卖出配对的买入批次不能删，否则对应卖出的成本就悬空了
    const ref = db
      .prepare('SELECT COUNT(*) AS n FROM sell_allocations WHERE buy_txn_id = ?')
      .get(id) as { n: number };
    if (ref.n > 0) {
      return NextResponse.json(
        { error: `该买入批次已被 ${ref.n} 笔卖出配对占用，请先删除对应的卖出记录` },
        { status: 409 },
      );
    }
    db.prepare('DELETE FROM transactions WHERE id = ? AND user_id = ?').run(id, userId);
    return NextResponse.json({ success: true });
  }

  // 卖出：连同它的批次分配一起删（批次剩余量随之恢复）。
  // 显式删除而不依赖 ON DELETE CASCADE，避免旧版 Node 外键默认关闭的差异。
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM sell_allocations WHERE sell_txn_id = ?').run(id);
    db.prepare('DELETE FROM transactions WHERE id = ? AND user_id = ?').run(id, userId);
    db.exec('COMMIT');
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch {}
    throw err;
  }
  return NextResponse.json({ success: true });
}
