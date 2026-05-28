import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { getDailyInsight } from '@/lib/daily-focus';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const db = getDb();
    const rows = db.prepare('SELECT DISTINCT ticker FROM transactions').all() as { ticker: string }[];
    const heldTickers = rows.map(r => r.ticker);
    const insight = await getDailyInsight(heldTickers);
    return NextResponse.json(insight);
  } catch {
    return NextResponse.json({ focus: [], alerts: [] });
  }
}
