import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

async function yfRaw(url: string) {
  const fcRes = await fetch('https://fc.yahoo.com/', { headers: { 'User-Agent': UA }, redirect: 'follow', cache: 'no-store' });
  const cookie = fcRes.headers.get('set-cookie') ?? '';
  const crumbRes = await fetch('https://query2.finance.yahoo.com/v1/test/getcrumb', { headers: { 'User-Agent': UA, Cookie: cookie }, cache: 'no-store' });
  const crumb = await crumbRes.text();
  const fullUrl = url + (url.includes('?') ? '&' : '?') + `crumb=${encodeURIComponent(crumb)}`;
  const res = await fetch(fullUrl, { headers: { 'User-Agent': UA, Accept: 'application/json', Cookie: cookie }, cache: 'no-store' });
  return res.ok ? res.json() : null;
}

export async function GET(req: Request) {
  const ticker = (new URL(req.url).searchParams.get('t') ?? 'ARM').toUpperCase();

  const raw = await yfRaw(
    `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${ticker}?modules=earnings,earningsHistory,incomeStatementHistoryQuarterly,earningsTrend`
  ).catch(() => null);

  const r0 = raw?.quoteSummary?.result?.[0] ?? null;

  // 各路径当前实际长度 — 用于快速判断哪条路径有数据
  const earningsQLen    = r0?.earnings?.earningsChart?.quarterly?.length ?? 0;
  const earningsHistLen = r0?.earningsHistory?.history?.length ?? 0;
  const incomeQLen      = r0?.incomeStatementHistoryQuarterly?.incomeStatementHistory?.length ?? 0;
  const trendLen        = r0?.earningsTrend?.trend?.length ?? 0;

  return NextResponse.json({
    ticker,
    topLevelKeys: r0 ? Object.keys(r0) : null,
    lengths: { earningsQLen, earningsHistLen, incomeQLen, trendLen },
    // 各路径原始前两条数据
    path1_earnings_quarterly: r0?.earnings?.earningsChart?.quarterly?.slice(0, 2) ?? null,
    path2_earningsHistory:    r0?.earningsHistory?.history?.slice(0, 2) ?? null,
    path3_incomeStatementQ:   r0?.incomeStatementHistoryQuarterly?.incomeStatementHistory?.slice(0, 2) ?? null,
    path4_earningsTrend:      r0?.earningsTrend?.trend?.slice(0, 2) ?? null,
  });
}
