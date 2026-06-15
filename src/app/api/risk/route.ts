/**
 * /api/risk — 代理到 quant 风险服务（127.0.0.1:8000）
 *
 * 鉴权由 src/middleware.ts 统一处理：
 *   - 未登录 → 中间件返回 401，本路由不会被调用
 *   - 已登录 → 代理请求转发到 quant 服务
 *
 * 错误处理：
 *   - quant 服务未启动 / 连接拒绝 → 503 + 明确提示
 *   - 请求超时（>30s）           → 503 + 超时提示
 *   - quant 服务返回 4xx/5xx    → 透传状态码 + body
 */

import { NextResponse } from 'next/server';
import { getCurrentUserId } from '@/lib/session';

export const dynamic = 'force-dynamic';

const QUANT_URL = process.env.QUANT_SERVICE_URL ?? 'http://127.0.0.1:8000';
const TIMEOUT_MS = 60_000; // 价格数据首次拉取可能需要较长时间

export async function GET() {
  const userId = await getCurrentUserId();
  if (userId == null) return NextResponse.json({ error: '未登录' }, { status: 401 });

  let res: Response;

  try {
    // 透传 user_id：quant 服务只分析该账号自己的持仓（多租户隔离）
    res = await fetch(`${QUANT_URL}/risk/portfolio?user_id=${userId}`, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      // 不携带用户 cookie：quant 服务只监听 127.0.0.1，无需鉴权
      cache: 'no-store',
    });
  } catch (err: unknown) {
    const isTimeout =
      err instanceof Error &&
      (err.name === 'TimeoutError' || err.name === 'AbortError');

    return NextResponse.json(
      {
        error: 'quant_unavailable',
        message: isTimeout
          ? `quant 服务请求超时（>${TIMEOUT_MS / 1000}s）。价格数据首次拉取较慢，请稍后重试。`
          : 'quant 服务未启动或无法连接。请在服务器上执行：cd quant && uvicorn main:app --host 127.0.0.1 --port 8000',
      },
      { status: 503 },
    );
  }

  // 透传 quant 服务的响应（含错误状态码）
  const data = await res.json().catch(() => ({ error: 'invalid_json' }));

  return NextResponse.json(data, { status: res.status });
}
