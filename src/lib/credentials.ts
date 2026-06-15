// Node.js-only — password hashing + DB credential management
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
      // 旧 credentials 表格式：<hex-salt>:<hex-hash>（32字节）
      const [salt, hash] = stored.split(':');
      const derived = scryptSync(password, salt, 32).toString('hex');
      return timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(derived, 'hex'));
    }
  } catch { return false; }
}

function ensureSeeded() {
  const db = getDb();
  const row = db.prepare('SELECT username, password_hash FROM credentials LIMIT 1').get() as
    { username: string; password_hash: string } | undefined;
  if (!row) {
    db.prepare('INSERT INTO credentials (username, password_hash) VALUES (?, ?)').run(
      DEFAULT_USER, hashPassword(DEFAULT_PASS)
    );
  }
}

export function validateCredentials(username: string, password: string): boolean {
  const db = getDb();

  // 先查 users 表（多用户系统）
  const userRow = db.prepare('SELECT password_hash FROM users WHERE username = ?').get(username) as
    { password_hash: string } | undefined;
  if (userRow) return checkPassword(password, userRow.password_hash);

  // fallback：老的单用户 credentials 表
  ensureSeeded();
  const row = db.prepare('SELECT username, password_hash FROM credentials LIMIT 1').get() as
    { username: string; password_hash: string } | undefined;
  if (!row || row.username !== username) return false;
  return checkPassword(password, row.password_hash);
}

export function changeCredentials(currentPassword: string, newUsername: string, newPassword: string): boolean {
  ensureSeeded();
  const db = getDb();
  const row = db.prepare('SELECT username, password_hash FROM credentials LIMIT 1').get() as
    { username: string; password_hash: string } | undefined;
  if (!row || !checkPassword(currentPassword, row.password_hash)) return false;
  db.prepare('UPDATE credentials SET username = ?, password_hash = ?').run(
    newUsername, hashPassword(newPassword)
  );
  return true;
}

export function getUsername(): string {
  ensureSeeded();
  const db = getDb();
  const row = db.prepare('SELECT username FROM credentials LIMIT 1').get() as { username: string } | undefined;
  return row?.username ?? DEFAULT_USER;
}
