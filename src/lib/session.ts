// Node-only — 解析当前登录用户的 user_id（按用户隔离数据用）
import { cookies } from 'next/headers';
import { verifyToken, SESSION_COOKIE } from './auth';
import { getDb } from './db';

/**
 * 从会话 cookie 解出当前用户在 users 表里的 id。
 * 鉴权已由 src/middleware.ts 统一保证，这里只负责把 username → id。
 * 返回 null 表示无有效会话或用户名已不存在（例如改名后旧 session 失效）。
 */
export async function getCurrentUserId(): Promise<number | null> {
  const token = cookies().get(SESSION_COOKIE)?.value;
  if (!token) return null;

  const username = await verifyToken(token);
  if (!username) return null;

  const row = getDb().prepare('SELECT id FROM users WHERE username = ?').get(username) as
    { id: number } | undefined;
  return row?.id ?? null;
}
