import { NextRequest, NextResponse } from 'next/server';
import { changeCredentials } from '@/lib/credentials';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const { currentPassword, newUsername, newPassword } = await req.json();
  if (!currentPassword || !newUsername || !newPassword) {
    return NextResponse.json({ error: '请填写所有字段' }, { status: 400 });
  }
  if (newPassword.length < 6) {
    return NextResponse.json({ error: '密码至少6位' }, { status: 400 });
  }
  const ok = changeCredentials(currentPassword, newUsername, newPassword);
  if (!ok) {
    return NextResponse.json({ error: '当前密码错误' }, { status: 401 });
  }
  return NextResponse.json({ ok: true });
}
