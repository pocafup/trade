import { NextRequest, NextResponse } from 'next/server';
import db from '@/lib/db';

export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  db.prepare('DELETE FROM transactions WHERE id = ?').run(Number(params.id));
  return NextResponse.json({ success: true });
}
