import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';

export const dynamic = 'force-dynamic';

export async function GET() {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM cash_flows ORDER BY date DESC, id DESC').all();
  return NextResponse.json(rows);
}

export async function POST(req: NextRequest) {
  const { type, amount, date, notes } = await req.json();
  if (!['deposit', 'withdrawal'].includes(type) || !amount || amount <= 0 || !date) {
    return NextResponse.json({ error: 'Invalid params' }, { status: 400 });
  }
  const db = getDb();
  const result = db.prepare(
    'INSERT INTO cash_flows (type, amount, date, notes) VALUES (?, ?, ?, ?)',
  ).run(type, Number(amount), date, notes ?? '');
  return NextResponse.json({ id: result.lastInsertRowid });
}
