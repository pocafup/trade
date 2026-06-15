import { NextRequest, NextResponse } from 'next/server';
import { changeUserCredentials } from '@/lib/credentials';
import { getCurrentUserId } from '@/lib/session';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const userId = await getCurrentUserId();
  if (userId == null) return NextResponse.json({ error: '未登录' }, { status: 401 });

  const { currentPassword, newUsername, newPassword } = await req.json();
  if (!currentPassword || !newUsername || !newPassword) {
    return NextResponse.json({ error: '请填写所有字段' }, { status: 400 });
  }
  if (newPassword.length < 6) {
    return NextResponse.json({ error: '密码至少6位' }, { status: 400 });
  }

  const result = changeUserCredentials(userId, currentPassword, newUsername, newPassword);
  if (!result.ok) {
    if (result.error === 'username_taken') {
      return NextResponse.json({ error: '该用户名已被占用' }, { status: 409 });
    }
    return NextResponse.json({ error: '当前密码错误' }, { status: 401 });
  }
  return NextResponse.json({ ok: true });
}
