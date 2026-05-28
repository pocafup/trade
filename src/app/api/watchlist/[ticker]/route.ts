import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';

export const dynamic = 'force-dynamic';

export async function DELETE(_req: NextRequest, { params }: { params: { ticker: string } }) {
  const db = getDb();
  db.prepare('DELETE FROM watchlist WHERE ticker = ?').run(params.ticker.toUpperCase());
  return NextResponse.json({ ok: true });
}
