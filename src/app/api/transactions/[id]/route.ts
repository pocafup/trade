import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { getCurrentUserId } from '@/lib/session';

export const dynamic = 'force-dynamic';

export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  const userId = await getCurrentUserId();
  if (userId == null) return NextResponse.json({ error: '未登录' }, { status: 401 });

  const db = getDb();
  db.prepare('DELETE FROM transactions WHERE id = ? AND user_id = ?').run(Number(params.id), userId);
  return NextResponse.json({ success: true });
}
