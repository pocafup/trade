/**
 * lots.ts 单元测试 —— 验证批次计算的数学正确性（CLAUDE.md 铁律 4）。
 * 运行：npm test（Node ≥23.6 原生跑 TS，无需任何依赖）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  QTY_EPS,
  round8,
  compareTxnsForFifo,
  computeOpenLots,
  fifoAllocate,
  validateAllocations,
  weightedAvgCost,
  sellRealizedPnl,
  fallbackCostForSell,
  type BuyTxn,
  type OpenLot,
} from './lots.ts';

const buy = (id: number, quantity: number, price: number, date: string, created_at?: string): BuyTxn =>
  ({ id, quantity, price, date, created_at });

const lot = (buy_txn_id: number, remaining: number, price = 100, date = '2024-01-01'): OpenLot =>
  ({ buy_txn_id, date, price, quantity: remaining, remaining });

// ── compareTxnsForFifo ───────────────────────────────────────────────────────

test('compareTxnsForFifo: 日期升序优先', () => {
  const a = { date: '2024-01-01', type: 'sell' as const, id: 9 };
  const b = { date: '2024-02-01', type: 'buy' as const, id: 1 };
  assert.ok(compareTxnsForFifo(a, b) < 0);
});

test('compareTxnsForFifo: 同日买入排在卖出前', () => {
  const s = { date: '2024-01-01', type: 'sell' as const, id: 1, created_at: '2024-01-01 09:00:00' };
  const b = { date: '2024-01-01', type: 'buy' as const, id: 2, created_at: '2024-01-01 10:00:00' };
  assert.ok(compareTxnsForFifo(b, s) < 0, '即使卖出先录入，同日买入也应排前');
});

test('compareTxnsForFifo: 同日同类型按 created_at 再按 id', () => {
  const a = { date: '2024-01-01', type: 'buy' as const, id: 5, created_at: '2024-01-01 09:00:00' };
  const b = { date: '2024-01-01', type: 'buy' as const, id: 3, created_at: '2024-01-01 10:00:00' };
  assert.ok(compareTxnsForFifo(a, b) < 0);
  const c = { date: '2024-01-01', type: 'buy' as const, id: 3, created_at: '2024-01-01 09:00:00' };
  assert.ok(compareTxnsForFifo(c, a) < 0, 'created_at 相同时 id 小的在前');
});

// ── computeOpenLots ──────────────────────────────────────────────────────────

test('computeOpenLots: 无分配时每批剩余等于买入量，按日期 FIFO 排序', () => {
  const lots = computeOpenLots(
    [buy(2, 5, 200, '2024-02-01'), buy(1, 10, 100, '2024-01-01')],
    [],
  );
  assert.deepEqual(lots.map((l) => l.buy_txn_id), [1, 2]);
  assert.equal(lots[0].remaining, 10);
  assert.equal(lots[1].remaining, 5);
});

test('computeOpenLots: 分配扣减剩余，多笔分配对同批次累加', () => {
  const lots = computeOpenLots(
    [buy(1, 10, 100, '2024-01-01')],
    [{ buy_txn_id: 1, quantity: 3 }, { buy_txn_id: 1, quantity: 2 }],
  );
  assert.equal(lots.length, 1);
  assert.equal(lots[0].remaining, 5);
});

test('computeOpenLots: 耗尽的批次被剔除（含浮点噪声内的"零"）', () => {
  const lots = computeOpenLots(
    [buy(1, 10, 100, '2024-01-01'), buy(2, 0.3, 100, '2024-01-02')],
    [
      { buy_txn_id: 1, quantity: 10 },
      { buy_txn_id: 2, quantity: 0.1 },
      { buy_txn_id: 2, quantity: 0.2 }, // 0.3 − 0.1 − 0.2 在浮点下 ≈ 5.5e-17
    ],
  );
  assert.equal(lots.length, 0);
});

test('computeOpenLots: asOfDate 过滤掉之后买入的批次', () => {
  const lots = computeOpenLots(
    [buy(1, 10, 100, '2024-01-01'), buy(2, 5, 200, '2024-03-01')],
    [],
    '2024-02-01',
  );
  assert.deepEqual(lots.map((l) => l.buy_txn_id), [1]);
});

// ── fifoAllocate ─────────────────────────────────────────────────────────────

test('fifoAllocate: 单批次恰好卖完', () => {
  const r = fifoAllocate(10, [lot(1, 10)]);
  assert.deepEqual(r.allocations, [{ buy_txn_id: 1, quantity: 10 }]);
  assert.equal(r.unallocated, 0);
});

test('fifoAllocate: 跨批次分配 10+10 卖 15 → [10, 5]', () => {
  const r = fifoAllocate(15, [lot(1, 10), lot(2, 10)]);
  assert.deepEqual(r.allocations, [
    { buy_txn_id: 1, quantity: 10 },
    { buy_txn_id: 2, quantity: 5 },
  ]);
  assert.equal(r.unallocated, 0);
});

test('fifoAllocate: 跳过已耗尽批次', () => {
  const r = fifoAllocate(3, [lot(1, 0), lot(2, 5)]);
  assert.deepEqual(r.allocations, [{ buy_txn_id: 2, quantity: 3 }]);
});

test('fifoAllocate: 持仓不足时返回未分配量', () => {
  const r = fifoAllocate(10, [lot(1, 8)]);
  assert.deepEqual(r.allocations, [{ buy_txn_id: 1, quantity: 8 }]);
  assert.equal(r.unallocated, 2);
});

test('fifoAllocate: 浮点 0.1+0.2 卖 0.3 完全分配', () => {
  const r = fifoAllocate(0.3, [lot(1, 0.1), lot(2, 0.2)]);
  assert.equal(r.unallocated, 0);
  const total = r.allocations.reduce((s, a) => s + a.quantity, 0);
  assert.ok(Math.abs(total - 0.3) <= QTY_EPS);
  for (const a of r.allocations) assert.equal(a.quantity, round8(a.quantity), '存储量应为 round8 后的干净值');
});

// ── validateAllocations ──────────────────────────────────────────────────────

const sell = (quantity: number, date = '2024-06-01') => ({ quantity, date });

test('validateAllocations: 多批次合法分配通过', () => {
  const r = validateAllocations(sell(15), [
    { buy_txn_id: 1, quantity: 10 },
    { buy_txn_id: 2, quantity: 5 },
  ], [lot(1, 10), lot(2, 10)]);
  assert.deepEqual(r, { ok: true });
});

test('validateAllocations: 空分配拒绝', () => {
  const r = validateAllocations(sell(5), [], [lot(1, 10)]);
  assert.equal(r.ok, false);
});

test('validateAllocations: 合计 ≠ 卖出股数拒绝；EPS 内的浮点差放行', () => {
  const bad = validateAllocations(sell(15), [{ buy_txn_id: 1, quantity: 10 }], [lot(1, 10)]);
  assert.equal(bad.ok, false);
  const okFloat = validateAllocations(sell(0.3), [
    { buy_txn_id: 1, quantity: 0.1 },
    { buy_txn_id: 2, quantity: 0.2 }, // 0.1+0.2 = 0.30000000000000004
  ], [lot(1, 1), lot(2, 1)]);
  assert.deepEqual(okFloat, { ok: true });
});

test('validateAllocations: 超过批次剩余拒绝；EPS 内放行', () => {
  const bad = validateAllocations(sell(5), [{ buy_txn_id: 1, quantity: 5 }], [lot(1, 3)]);
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.match(bad.error, /剩余 3 股/);
  const ok = validateAllocations(
    sell(3.0000000001),
    [{ buy_txn_id: 1, quantity: 3.0000000001 }],
    [lot(1, 3)],
  );
  assert.deepEqual(ok, { ok: true });
});

test('validateAllocations: 未知批次 id 拒绝（覆盖跨用户/跨股票场景）', () => {
  const r = validateAllocations(sell(5), [{ buy_txn_id: 999, quantity: 5 }], [lot(1, 10)]);
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /#999/);
});

test('validateAllocations: 重复批次 id 拒绝', () => {
  const r = validateAllocations(sell(6), [
    { buy_txn_id: 1, quantity: 3 },
    { buy_txn_id: 1, quantity: 3 },
  ], [lot(1, 10)]);
  assert.equal(r.ok, false);
});

test('validateAllocations: 数量 ≤ 0 拒绝', () => {
  const r = validateAllocations(sell(0), [{ buy_txn_id: 1, quantity: 0 }], [lot(1, 10)]);
  assert.equal(r.ok, false);
});

test('validateAllocations: 批次买入日期晚于卖出日期拒绝，同日允许', () => {
  const late = validateAllocations(
    { quantity: 5, date: '2024-01-01' },
    [{ buy_txn_id: 1, quantity: 5 }],
    [lot(1, 10, 100, '2024-02-01')],
  );
  assert.equal(late.ok, false);
  const sameDay = validateAllocations(
    { quantity: 5, date: '2024-02-01' },
    [{ buy_txn_id: 1, quantity: 5 }],
    [lot(1, 10, 100, '2024-02-01')],
  );
  assert.deepEqual(sameDay, { ok: true });
});

// ── weightedAvgCost ──────────────────────────────────────────────────────────

test('weightedAvgCost: 剩余量加权 (10股@100 + 5股@200 → 133.33…)', () => {
  const cost = weightedAvgCost([lot(1, 10, 100), lot(2, 5, 200)]);
  assert.ok(Math.abs(cost - (10 * 100 + 5 * 200) / 15) < 1e-12);
});

test('weightedAvgCost: 空批次返回 0', () => {
  assert.equal(weightedAvgCost([]), 0);
});

// ── sellRealizedPnl ──────────────────────────────────────────────────────────

test('sellRealizedPnl: 具体识别法多批次 (卖 15@120，10@100 + 5@110 → 250)', () => {
  const pnl = sellRealizedPnl(15, 120, [
    { quantity: 10, buy_price: 100 },
    { quantity: 5, buy_price: 110 },
  ], 0);
  assert.equal(pnl, 10 * 20 + 5 * 10);
});

test('sellRealizedPnl: 未分配残量按 fallbackCost 计', () => {
  // 卖 10@120，只有 8 股有分配(@100)，残量 2 股按 fallback 90 计
  const pnl = sellRealizedPnl(10, 120, [{ quantity: 8, buy_price: 100 }], 90);
  assert.equal(pnl, 8 * 20 + 2 * 30);
});

test('sellRealizedPnl: fallbackCost = 卖价时残量贡献 0', () => {
  const pnl = sellRealizedPnl(10, 120, [], 120);
  assert.equal(pnl, 0);
});

// ── fallbackCostForSell ──────────────────────────────────────────────────────

test('fallbackCostForSell: 卖出日(含当日)前买入的加权均价，不看之后的买入', () => {
  const buys = [
    { quantity: 10, price: 100, date: '2024-01-01' },
    { quantity: 10, price: 200, date: '2024-03-01' }, // 晚于卖出日，不计入
  ];
  assert.equal(fallbackCostForSell(buys, '2024-02-01', 999), 100);
  // 含当日
  assert.equal(fallbackCostForSell(buys, '2024-03-01', 999), 150);
});

test('fallbackCostForSell: 无更早买入时返回卖价（残量零盈亏）', () => {
  assert.equal(fallbackCostForSell([], '2024-02-01', 88), 88);
});
