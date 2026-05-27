import { NextRequest, NextResponse } from 'next/server';
import { getNews } from '@/lib/yahoo';

export async function GET(req: NextRequest, { params }: { params: { ticker: string } }) {
  const news = await getNews(params.ticker.toUpperCase());
  return NextResponse.json(news);
}
