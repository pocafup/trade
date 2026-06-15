import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { getCurrentUserId } from '@/lib/session';
import { getDailyInsight } from '@/lib/daily-focus';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const userId = await getCurrentUserId();
    if (userId == null) return NextResponse.json({ focus: [], alerts: [] });

    const db = getDb();
    const rows = db.prepare(`
      SELECT ticker FROM (
        SELECT ticker,
          SUM(CASE WHEN type='buy' THEN quantity ELSE 0 END) -
          SUM(CASE WHEN type='sell' THEN quantity ELSE 0 END) AS net
        FROM transactions WHERE user_id = ? GROUP BY ticker
      ) WHERE net > 0.0001
    `).all(userId) as { ticker: string }[];
    const heldTickers = rows.map(r => r.ticker);
    const insight = await getDailyInsight(heldTickers);
    return NextResponse.json(insight);
  } catch {
    return NextResponse.json({ focus: [], alerts: [] });
  }
}
