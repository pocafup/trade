import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { getCurrentUserId } from '@/lib/session';

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

  const { ticker, name, type, quantity, price, date, notes } = await req.json();

  if (!ticker || !type || !quantity || !price || !date) {
    return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
  }

  const db = getDb();
  const result = db
    .prepare(
      `INSERT INTO transactions (user_id, ticker, name, type, quantity, price, date, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(userId, ticker.toUpperCase().trim(), name || '', type, Number(quantity), Number(price), date, notes || '');

  return NextResponse.json({ id: Number(result.lastInsertRowid) }, { status: 201 });
}
