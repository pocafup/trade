import { NextRequest, NextResponse } from 'next/server';
import { getNews } from '@/lib/yahoo';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, { params }: { params: { ticker: string } }) {
  const news = await getNews(params.ticker.toUpperCase());
  return NextResponse.json(news);
}
