import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { getCurrentUserId } from '@/lib/session';

export const dynamic = 'force-dynamic';

export async function GET() {
  const userId = await getCurrentUserId();
  if (userId == null) return NextResponse.json({ error: '未登录' }, { status: 401 });

  const db = getDb();
  const rows = db.prepare('SELECT * FROM cash_flows WHERE user_id = ? ORDER BY date DESC, id DESC').all(userId);
  return NextResponse.json(rows);
}

export async function POST(req: NextRequest) {
  const userId = await getCurrentUserId();
  if (userId == null) return NextResponse.json({ error: '未登录' }, { status: 401 });

  const { type, amount, date, notes } = await req.json();
  if (!['deposit', 'withdrawal'].includes(type) || !amount || amount <= 0 || !date) {
    return NextResponse.json({ error: 'Invalid params' }, { status: 400 });
  }
  const db = getDb();
  const result = db.prepare(
    'INSERT INTO cash_flows (user_id, type, amount, date, notes) VALUES (?, ?, ?, ?, ?)',
  ).run(userId, type, Number(amount), date, notes ?? '');
  return NextResponse.json({ id: result.lastInsertRowid });
}
