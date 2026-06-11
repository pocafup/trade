import { NextResponse } from 'next/server';
import { getMacroData } from '@/lib/macro';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const data = await getMacroData();
    return NextResponse.json(data);
  } catch {
    return NextResponse.json({ error: 'macro_failed' }, { status: 500 });
  }
}
