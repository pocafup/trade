/**
 * 批次(lot)核心计算 —— 纯函数，零依赖，方便单元测试。
 *
 * 模型：每笔买入是一个"批次"；每笔卖出通过 sell_allocations 表
 * 分配到一个或多个批次（可部分消耗）。持仓成本与已实现盈亏都用
 * "具体识别法"(specific identification)：卖了哪批，就按哪批的买价算。
 *
 * 不变式：每笔分配满足 买入日期 ≤ 卖出日期 且 Σ分配 ≤ 批次数量，
 * 即可保证任意日期的运行持仓 ≥ 0（天然防超卖，含倒填日期的情况）。
 */

// 数量比较容差：UI 允许的最小股数是 0.0001，取 1e-6 既低于最小交易单位、
// 又高于 float64 的舍入噪声（0.1+0.2 级别的误差在 1e-16 量级）
export const QTY_EPS = 1e-6;

/** 存储用舍入：保留 8 位小数，与 portfolio 路由的 toFixed(8) 口径一致 */
export function round8(n: number): number {
  return parseFloat(n.toFixed(8));
}

/** 买入交易行（transactions 表里 type='buy' 的行） */
export interface BuyTxn {
  id: number;
  quantity: number;
  price: number;
  date: string; // 'YYYY-MM-DD'
  created_at?: string; // 同日排序的 tiebreak
}

/** 一笔分配：卖出中有 quantity 股来自 buy_txn_id 这个批次 */
export interface AllocInput {
  buy_txn_id: number;
  quantity: number;
}

/** 开放批次：还有剩余可卖数量的买入 */
export interface OpenLot {
  buy_txn_id: number;
  date: string;
  price: number;
  quantity: number; // 原始买入股数
  remaining: number; // 剩余 = 买入股数 − 已分配给各卖出的数量
}

/**
 * FIFO 排序规则：日期升序 → 同日买入先于卖出 → created_at → id。
 * date 只有年月日没有时分秒，同日"买先于卖"可避免同一天先记卖出
 * 后记买入时被误判为超卖。
 */
export function compareTxnsForFifo(
  a: { date: string; type: 'buy' | 'sell'; created_at?: string; id: number },
  b: { date: string; type: 'buy' | 'sell'; created_at?: string; id: number },
): number {
  if (a.date !== b.date) return a.date < b.date ? -1 : 1;
  if (a.type !== b.type) return a.type === 'buy' ? -1 : 1;
  const ca = a.created_at ?? '';
  const cb = b.created_at ?? '';
  if (ca !== cb) return ca < cb ? -1 : 1;
  return a.id - b.id;
}

/**
 * 由买入列表 + 已有分配，算出每个批次的剩余数量。
 * 剔除剩余 ≤ QTY_EPS 的批次；按 FIFO 顺序（日期升序）返回。
 * asOfDate 可选：只保留买入日期 ≤ asOfDate 的批次（用于"截至卖出日可卖哪些批"）。
 */
export function computeOpenLots(
  buys: BuyTxn[],
  allocations: AllocInput[],
  asOfDate?: string,
): OpenLot[] {
  const allocated = new Map<number, number>();
  for (const a of allocations) {
    allocated.set(a.buy_txn_id, (allocated.get(a.buy_txn_id) ?? 0) + a.quantity);
  }

  return buys
    .filter((b) => asOfDate === undefined || b.date <= asOfDate)
    .slice()
    .sort((a, b) =>
      compareTxnsForFifo(
        { date: a.date, type: 'buy', created_at: a.created_at, id: a.id },
        { date: b.date, type: 'buy', created_at: b.created_at, id: b.id },
      ),
    )
    .map((b) => ({
      buy_txn_id: b.id,
      date: b.date,
      price: b.price,
      quantity: b.quantity,
      remaining: round8(b.quantity - (allocated.get(b.id) ?? 0)),
    }))
    .filter((l) => l.remaining > QTY_EPS);
}

/**
 * FIFO 贪心分配：从最早的批次开始扣，直到扣满 sellQty。
 * 不修改传入的 openLots（openLots 需已按 FIFO 排序，即 computeOpenLots 的输出）。
 * 返回分配列表和无法分配的剩余量（unallocated > 0 说明持仓不足）。
 */
export function fifoAllocate(
  sellQty: number,
  openLots: OpenLot[],
): { allocations: AllocInput[]; unallocated: number } {
  const allocations: AllocInput[] = [];
  let need = sellQty;

  for (const lot of openLots) {
    if (need <= QTY_EPS) break;
    if (lot.remaining <= QTY_EPS) continue;
    const take = round8(Math.min(lot.remaining, need));
    if (take <= 0) continue;
    allocations.push({ buy_txn_id: lot.buy_txn_id, quantity: take });
    need = round8(need - take);
  }

  return { allocations, unallocated: need <= QTY_EPS ? 0 : round8(need) };
}

/**
 * 校验一笔卖出的显式分配列表。openLots 必须已按当前用户 + ticker 过滤，
 * 因此不在 openLots 里的 buy_txn_id（含他人/他股票的 id）会直接被拒。
 * 返回 { ok: true } 或 { ok: false, error: 用户可读的中文消息 }。
 */
export function validateAllocations(
  sell: { quantity: number; date: string },
  allocations: AllocInput[],
  openLots: OpenLot[],
): { ok: true } | { ok: false; error: string } {
  if (!Array.isArray(allocations) || allocations.length === 0) {
    return { ok: false, error: '卖出必须至少分配一个买入批次' };
  }

  const byId = new Map(openLots.map((l) => [l.buy_txn_id, l]));
  const seen = new Set<number>();
  let total = 0;

  for (const a of allocations) {
    if (!Number.isFinite(a.quantity) || a.quantity <= 0) {
      return { ok: false, error: '分配数量必须大于 0' };
    }
    if (!Number.isInteger(a.buy_txn_id)) {
      return { ok: false, error: '批次 id 无效' };
    }
    if (seen.has(a.buy_txn_id)) {
      return { ok: false, error: `批次 #${a.buy_txn_id} 被重复分配` };
    }
    seen.add(a.buy_txn_id);

    const lot = byId.get(a.buy_txn_id);
    if (!lot) {
      return { ok: false, error: `批次 #${a.buy_txn_id} 不存在、已卖完或不属于该股票` };
    }
    if (lot.date > sell.date) {
      return {
        ok: false,
        error: `批次 #${a.buy_txn_id} 买入日期(${lot.date})晚于卖出日期(${sell.date})`,
      };
    }
    if (a.quantity > lot.remaining + QTY_EPS) {
      return {
        ok: false,
        error: `批次 #${a.buy_txn_id}（${lot.date} 买入）剩余 ${lot.remaining} 股，无法卖出 ${a.quantity} 股`,
      };
    }
    total += a.quantity;
  }

  if (Math.abs(total - sell.quantity) > QTY_EPS) {
    return {
      ok: false,
      error: `分配数量合计 ${round8(total)} 股与卖出股数 ${sell.quantity} 股不一致`,
    };
  }

  return { ok: true };
}

/**
 * 剩余批次的加权平均成本：Σ(剩余股数×买价) / Σ剩余股数。
 * 这就是"具体识别法"下当前持仓的每股成本；没有开放批次时返回 0。
 */
export function weightedAvgCost(openLots: OpenLot[]): number {
  let qty = 0;
  let cost = 0;
  for (const l of openLots) {
    qty += l.remaining;
    cost += l.remaining * l.price;
  }
  return qty > QTY_EPS ? cost / qty : 0;
}

/**
 * 一笔卖出的已实现盈亏（具体识别法）：
 *   Σ (卖价 − 该批买价) × 分配数量
 * 加上未分配残量（仅存量超卖数据会有）按 fallbackCost 计：
 *   (sellQty − Σ分配) × (卖价 − fallbackCost)
 */
export function sellRealizedPnl(
  sellQty: number,
  sellPrice: number,
  allocs: { quantity: number; buy_price: number }[],
  fallbackCost: number,
): number {
  let pnl = 0;
  let allocated = 0;
  for (const a of allocs) {
    pnl += a.quantity * (sellPrice - a.buy_price);
    allocated += a.quantity;
  }
  const unallocated = sellQty - allocated;
  if (unallocated > QTY_EPS) pnl += unallocated * (sellPrice - fallbackCost);
  return pnl;
}

/**
 * 遗留未分配残量的成本兜底：该 ticker 卖出日（含当日）之前所有买入的加权均价
 *   Σ(数量×价格) / Σ数量  （只回看，不引入前视）
 * 完全没有更早的买入时返回卖价本身 —— 残量贡献 0 盈亏，而不是凭空的盈利/亏损。
 */
export function fallbackCostForSell(
  buys: { quantity: number; price: number; date: string }[],
  sellDate: string,
  sellPrice: number,
): number {
  let qty = 0;
  let cost = 0;
  for (const b of buys) {
    if (b.date > sellDate) continue;
    qty += b.quantity;
    cost += b.quantity * b.price;
  }
  return qty > QTY_EPS ? cost / qty : sellPrice;
}
