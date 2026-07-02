import { DatabaseSync } from 'node:sqlite';
import path from 'path';
import fs from 'fs';
import { QTY_EPS, round8, compareTxnsForFifo, fifoAllocate, type OpenLot } from './lots';

let _db: DatabaseSync | null = null;

export function getDb(): DatabaseSync {
  if (_db) return _db;

  const dbPath = process.env.DB_PATH || path.join(process.cwd(), 'data', 'trade.db');
  const dbDir = path.dirname(dbPath);
  if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });

  _db = new DatabaseSync(dbPath);
  _db.exec('PRAGMA journal_mode = WAL;');
  // 显式开启外键约束：本机 Node 24 默认开，但 Docker 的 node:22 不一定
  _db.exec('PRAGMA foreign_keys = ON;');
  _db.exec(`
    CREATE TABLE IF NOT EXISTS transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      ticker TEXT NOT NULL,
      name TEXT NOT NULL DEFAULT '',
      type TEXT NOT NULL CHECK(type IN ('buy', 'sell')),
      quantity REAL NOT NULL CHECK(quantity > 0),
      price REAL NOT NULL CHECK(price >= 0),
      date TEXT NOT NULL,
      notes TEXT DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS watchlist (
      user_id INTEGER NOT NULL DEFAULT 0,
      ticker TEXT NOT NULL,
      name TEXT NOT NULL DEFAULT '',
      added_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
      PRIMARY KEY (user_id, ticker)
    );
    CREATE TABLE IF NOT EXISTS credentials (
      id INTEGER PRIMARY KEY CHECK(id = 1),
      username TEXT NOT NULL,
      password_hash TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS cash_flows (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      type TEXT NOT NULL CHECK(type IN ('deposit', 'withdrawal')),
      amount REAL NOT NULL CHECK(amount > 0),
      date TEXT NOT NULL,
      notes TEXT DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  migrateToMultiUser(_db);
  migrateSellAllocations(_db); // 必须在 multi-user 迁移之后（回填按 user_id 分组）

  return _db;
}

function hasColumn(db: DatabaseSync, table: string, col: string): boolean {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return cols.some((c) => c.name === col);
}

function hasTable(db: DatabaseSync, table: string): boolean {
  const row = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(table);
  return row !== undefined;
}

/**
 * 把老的"全局共享"数据库迁移成多用户：给按用户的表加 user_id，并把存量数据
 * 归给原始 admin 账号。幂等——每次启动都能安全重复执行。
 */
function migrateToMultiUser(db: DatabaseSync): void {
  const needTxn   = !hasColumn(db, 'transactions', 'user_id');
  const needCash  = !hasColumn(db, 'cash_flows', 'user_id');
  const needWatch = !hasColumn(db, 'watchlist', 'user_id');
  if (!needTxn && !needCash && !needWatch) return; // 已迁移过

  // 原始 admin：把老 credentials 表里的单账号迁进 users 表，存量数据都归它名下
  const ownerId = resolveLegacyOwnerId(db);

  db.exec('BEGIN');
  try {
    if (needTxn) {
      db.exec('ALTER TABLE transactions ADD COLUMN user_id INTEGER');
      if (ownerId != null) db.prepare('UPDATE transactions SET user_id = ? WHERE user_id IS NULL').run(ownerId);
    }
    if (needCash) {
      db.exec('ALTER TABLE cash_flows ADD COLUMN user_id INTEGER');
      if (ownerId != null) db.prepare('UPDATE cash_flows SET user_id = ? WHERE user_id IS NULL').run(ownerId);
    }
    if (needWatch) {
      // SQLite 不能直接改主键 (ticker → user_id+ticker)，只能重建表
      db.exec(`
        CREATE TABLE watchlist_new (
          user_id INTEGER NOT NULL,
          ticker TEXT NOT NULL,
          name TEXT NOT NULL DEFAULT '',
          added_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
          PRIMARY KEY (user_id, ticker)
        );
      `);
      if (ownerId != null) {
        db.prepare(
          'INSERT INTO watchlist_new (user_id, ticker, name, added_at) SELECT ?, ticker, name, added_at FROM watchlist',
        ).run(ownerId);
      }
      db.exec('DROP TABLE watchlist');
      db.exec('ALTER TABLE watchlist_new RENAME TO watchlist');
    }

    db.exec('CREATE INDEX IF NOT EXISTS idx_txn_user ON transactions(user_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_cash_user ON cash_flows(user_id)');
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/**
 * 找出"存量数据归属"的 user_id：
 *  1. 把老 credentials 表里的单账号迁进 users 表（密码 hash 原样搬，旧格式登录仍兼容）
 *  2. 返回它在 users 表里的 id
 * 若没有 credentials 账号，则退而取 users 表里第一个用户；都没有（全新库）返回 null。
 */
function resolveLegacyOwnerId(db: DatabaseSync): number | null {
  const cred = db.prepare('SELECT username, password_hash FROM credentials WHERE id = 1').get() as
    { username: string; password_hash: string } | undefined;

  if (cred) {
    const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(cred.username) as
      { id: number } | undefined;
    if (existing) return existing.id;
    const r = db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)').run(
      cred.username, cred.password_hash,
    );
    return Number(r.lastInsertRowid);
  }

  const first = db.prepare('SELECT id FROM users ORDER BY id LIMIT 1').get() as { id: number } | undefined;
  return first?.id ?? null;
}

/**
 * 批次(lot)迁移：建 sell_allocations 表，并把存量卖出按 FIFO（先买先卖）
 * 回填到买入批次上。此后每笔卖出都必须有分配记录（新卖出由 API 层写入）。
 * 幂等——以表是否存在为守卫，只在第一次启动时回填一次。
 */
function migrateSellAllocations(db: DatabaseSync): void {
  if (hasTable(db, 'sell_allocations')) return; // 已迁移过

  db.exec('BEGIN');
  try {
    db.exec(`
      CREATE TABLE sell_allocations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sell_txn_id INTEGER NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
        buy_txn_id  INTEGER NOT NULL REFERENCES transactions(id),
        quantity    REAL NOT NULL CHECK(quantity > 0),
        created_at  TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(sell_txn_id, buy_txn_id)
      );
      CREATE INDEX idx_alloc_buy  ON sell_allocations(buy_txn_id);
      CREATE INDEX idx_alloc_sell ON sell_allocations(sell_txn_id);
    `);

    const txns = db
      .prepare(
        `SELECT id, user_id, ticker, type, quantity, date, created_at FROM transactions`,
      )
      .all() as unknown as {
      id: number;
      user_id: number | null;
      ticker: string;
      type: 'buy' | 'sell';
      quantity: number;
      date: string;
      created_at: string;
    }[];

    // 按 用户×股票 分组（user_id 可能为 NULL——无主遗留数据自成一组）
    const groups = new Map<string, typeof txns>();
    for (const t of txns) {
      const key = `${t.user_id ?? 'null'}:${t.ticker}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(t);
    }

    const ins = db.prepare(
      'INSERT INTO sell_allocations (sell_txn_id, buy_txn_id, quantity) VALUES (?, ?, ?)',
    );

    for (const [key, list] of groups) {
      list.sort(compareTxnsForFifo);

      // 顺序重放：买入开新批次，卖出从最早的批次贪心扣减
      const lots: OpenLot[] = [];
      for (const t of list) {
        if (t.type === 'buy') {
          lots.push({ buy_txn_id: t.id, date: t.date, price: 0, quantity: t.quantity, remaining: t.quantity });
          continue;
        }
        const { allocations, unallocated } = fifoAllocate(t.quantity, lots);
        for (const a of allocations) {
          ins.run(t.id, a.buy_txn_id, a.quantity);
          const lot = lots.find((l) => l.buy_txn_id === a.buy_txn_id)!;
          lot.remaining = round8(lot.remaining - a.quantity);
        }
        if (unallocated > QTY_EPS) {
          // 存量数据本身超卖（卖出多于此前买入）：能配多少配多少，剩余留空。
          // 盈亏计算对未分配残量有 fallback（见 lots.ts sellRealizedPnl），不会 NaN。
          console.warn(
            `[migrate:sell_allocations] 存量超卖：${key} 卖出#${t.id}（${t.date}）有 ${unallocated} 股无法配对到买入批次，保留为未分配`,
          );
        }
      }
    }

    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
