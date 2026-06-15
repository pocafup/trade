import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { getCurrentUserId } from '@/lib/session';

export const dynamic = 'force-dynamic';

export async function DELETE(_req: NextRequest, { params }: { params: { ticker: string } }) {
  const userId = await getCurrentUserId();
  if (userId == null) return NextResponse.json({ error: '未登录' }, { status: 401 });

  const db = getDb();
  db.prepare('DELETE FROM watchlist WHERE user_id = ? AND ticker = ?').run(userId, params.ticker.toUpperCase());
  return NextResponse.json({ ok: true });
}
