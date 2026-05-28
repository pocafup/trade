import { NextRequest, NextResponse } from 'next/server';
import { createToken, SESSION_COOKIE } from '@/lib/auth';
import { validateCredentials } from '@/lib/credentials';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const { username, password } = await req.json();
  if (!username || !password) {
    return NextResponse.json({ error: '请输入用户名和密码' }, { status: 400 });
  }
  if (!validateCredentials(username, password)) {
    return NextResponse.json({ error: '用户名或密码错误' }, { status: 401 });
  }
  const token = await createToken(username);
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    maxAge: 7 * 24 * 60 * 60,
    path: '/',
  });
  return res;
}
