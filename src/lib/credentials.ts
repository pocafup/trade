// Node.js-only — password hashing + DB credential management
// users 表是账号的唯一来源；老的单账号 credentials 表只在 db.ts 迁移时被读取一次后即弃用。
import { scryptSync, timingSafeEqual, randomBytes } from 'crypto';
import { getDb } from './db';

const DEFAULT_USER = process.env.AUTH_USERNAME ?? 'admin';
const DEFAULT_PASS = process.env.AUTH_PASSWORD ?? 'trade2024';

function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, 32).toString('hex');
  return `${salt}:${hash}`;
}

function checkPassword(password: string, stored: string): boolean {
  try {
    if (stored.startsWith('scrypt:')) {
      // user-admin.js 写入格式：scrypt:<hex-salt>:<hex-hash>（64字节）
      const parts = stored.split(':');
      const salt    = parts[1];
      const hash    = parts[2];
      const derived = scryptSync(password, salt, 64).toString('hex');
      return timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(derived, 'hex'));
    } else {
      // 旧 credentials / changeUserCredentials 写入格式：<hex-salt>:<hex-hash>（32字节）
      const [salt, hash] = stored.split(':');
      const derived = scryptSync(password, salt, 32).toString('hex');
      return timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(derived, 'hex'));
    }
  } catch { return false; }
}

// 全新部署且没有任何用户时，种入一个默认 admin（仅当 users 表为空）。
// 已有账号（含 db.ts 迁移导入的原始 admin）时不会重复种入。
function ensureSeeded() {
  const db = getDb();
  const row = db.prepare('SELECT id FROM users LIMIT 1').get();
  if (!row) {
    db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)').run(
      DEFAULT_USER, hashPassword(DEFAULT_PASS),
    );
  }
}

export function validateCredentials(username: string, password: string): boolean {
  ensureSeeded();
  const db = getDb();
  const row = db.prepare('SELECT password_hash FROM users WHERE username = ?').get(username) as
    { password_hash: string } | undefined;
  if (!row) return false;
  return checkPassword(password, row.password_hash);
}

/**
 * 修改“当前登录用户”的用户名/密码（按 users 表的 id 定位，不影响其他账号）。
 * 返回 { ok:false, error } 用于区分“当前密码错误”和“新用户名被占用”。
 */
export function changeUserCredentials(
  userId: number,
  currentPassword: string,
  newUsername: string,
  newPassword: string,
): { ok: boolean; error?: 'bad_password' | 'username_taken' } {
  const db = getDb();
  const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(userId) as
    { password_hash: string } | undefined;
  if (!row || !checkPassword(currentPassword, row.password_hash)) {
    return { ok: false, error: 'bad_password' };
  }
  const clash = db.prepare('SELECT id FROM users WHERE username = ? AND id != ?').get(newUsername, userId) as
    { id: number } | undefined;
  if (clash) return { ok: false, error: 'username_taken' };

  db.prepare('UPDATE users SET username = ?, password_hash = ? WHERE id = ?').run(
    newUsername, hashPassword(newPassword), userId,
  );
  return { ok: true };
}
