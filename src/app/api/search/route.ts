import { NextRequest, NextResponse } from 'next/server';
import { searchTickers } from '@/lib/yahoo';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams.get('q') || '';
  if (q.length < 1) return NextResponse.json([]);
  const results = await searchTickers(q);
  return NextResponse.json(results);
}
