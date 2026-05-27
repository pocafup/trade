import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';

export const dynamic = 'force-dynamic';

export async function GET() {
  const db = getDb();
  const rows = db
    .prepare('SELECT * FROM transactions ORDER BY date DESC, created_at DESC')
    .all();
  return NextResponse.json(rows);
}

export async function POST(req: NextRequest) {
  const { ticker, name, type, quantity, price, date, notes } = await req.json();

  if (!ticker || !type || !quantity || !price || !date) {
    return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
  }

  const db = getDb();
  const result = db
    .prepare(
      `INSERT INTO transactions (ticker, name, type, quantity, price, date, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(ticker.toUpperCase().trim(), name || '', type, Number(quantity), Number(price), date, notes || '');

  return NextResponse.json({ id: Number(result.lastInsertRowid) }, { status: 201 });
}
