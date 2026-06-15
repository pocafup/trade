'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import {
  ArrowLeft, RefreshCw, Globe, TrendingUp, TrendingDown,
  Gauge, CalendarDays, Landmark, ExternalLink, AlertTriangle,
} from 'lucide-react';

// ── 字号缩放（仅作用于本页正文，存 localStorage，方便视力不好时自己调大）──────────
const FS_MIN = 1.0;   // 100% = 现有大小
const FS_MAX = 2.5;   // 250% = 超大
const FS_STEP = 0.15;
const FS_DEFAULT = 1.45;       // 默认就放大，照顾视力
const FS_DENSE_AT = 1.45;      // ≥ 此值时数字网格降为单列，防止窄屏撑破
const FS_KEY = 'macroFontScale';

// ── Types (mirror src/lib/macro.ts) ─────────────────────────────────────────────

interface MarketTick {
  symbol: string; label: string; price: number; changePct: number;
  group: 'index' | 'vol' | 'rate' | 'fx' | 'commodity' | 'crypto';
}
interface FearGreed {
  score: number; rating: string; label: string;
  prevClose: number; week: number; month: number; year: number;
}
interface EconIndicator {
  key: string; label: string; value: number; unit: string;
  date: string; prev: number | null; higherIsHot: boolean; hint: string;
}
interface CalendarEvent { label: string; date: string; daysAway: number; note: string }
interface FomcSummary { date: string; title: string; url: string; summary: string; changes: string[] }
interface MacroData {
  marketPulse: MarketTick[];
  fearGreed: FearGreed | null;
  indicators: EconIndicator[];
  calendar: CalendarEvent[];
  fomc: FomcSummary[];
  generatedAt: string;
}

// ── Formatters ───────────────────────────────────────────────────────────────────

function fmtPrice(t: MarketTick): string {
  const p = t.price;
  if (t.group === 'rate') return `${p.toFixed(2)}%`;
  if (t.group === 'crypto') return `$${p.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
  if (p >= 1000) return p.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return p.toFixed(2);
}
function signColor(v: number): string {
  return v > 0 ? 'text-emerald-400' : v < 0 ? 'text-rose-400' : 'text-[#8B9CC0]';
}

// 恐惧贪婪：分区取色
function fgColor(score: number): string {
  if (score <= 25) return '#F43F5E'; // 极度恐惧 红
  if (score <= 45) return '#FB923C'; // 恐惧 橙
  if (score <= 55) return '#FACC15'; // 中性 黄
  if (score <= 75) return '#4ADE80'; // 贪婪 浅绿
  return '#22C55E';                  // 极度贪婪 绿
}

// ── Market pulse ─────────────────────────────────────────────────────────────────

function MarketPulse({ ticks, gridClass }: { ticks: MarketTick[]; gridClass: string }) {
  return (
    <section>
      <div className="flex items-center gap-2 mb-3">
        <TrendingUp size={13} className="text-[#4F8EF7]" />
        <p className="text-[0.625em] font-medium text-[#6B7E9C] uppercase tracking-wider">市场脉搏 · 今日</p>
      </div>
      {ticks.length === 0 ? (
        <div className="rounded-2xl bg-[#0F1520] border border-[#1E2D42] p-4 text-[0.75em] text-[#3A4E6A]">
          行情数据暂不可用，稍后刷新
        </div>
      ) : (
        <div className={gridClass}>
          {ticks.map((t) => {
            const pos = t.changePct >= 0;
            return (
              <div key={t.symbol} className="bg-[#0F1520] border border-[#1E2D42] rounded-2xl p-3">
                <p className="text-[0.625em] text-[#6B7E9C] truncate mb-1">{t.label}</p>
                <p className="font-mono font-bold text-[1em] text-[#E8EDFB] tracking-tight leading-none">
                  {fmtPrice(t)}
                </p>
                <div className={`flex items-center gap-1 mt-1.5 ${signColor(t.changePct)}`}>
                  {pos ? <TrendingUp size={11} /> : <TrendingDown size={11} />}
                  <span className="font-mono text-[0.75em] font-semibold">
                    {pos ? '+' : ''}{t.changePct.toFixed(2)}%
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

// ── Fear & Greed gauge ───────────────────────────────────────────────────────────

function FearGreedCard({ fg }: { fg: FearGreed | null }) {
  if (!fg) {
    return (
      <section>
        <div className="flex items-center gap-2 mb-3">
          <Gauge size={13} className="text-[#4F8EF7]" />
          <p className="text-[0.625em] font-medium text-[#6B7E9C] uppercase tracking-wider">市场情绪</p>
        </div>
        <div className="rounded-2xl bg-[#0F1520] border border-[#1E2D42] p-4 text-[0.75em] text-[#3A4E6A]">
          恐惧贪婪指数暂不可用（数据源限流），稍后刷新
        </div>
      </section>
    );
  }

  const color = fgColor(fg.score);
  const trends: { label: string; v: number }[] = [
    { label: '昨日', v: fg.prevClose },
    { label: '一周前', v: fg.week },
    { label: '一月前', v: fg.month },
    { label: '一年前', v: fg.year },
  ];

  return (
    <section>
      <div className="flex items-center gap-2 mb-3">
        <Gauge size={13} className="text-[#4F8EF7]" />
        <p className="text-[0.625em] font-medium text-[#6B7E9C] uppercase tracking-wider">市场情绪 · CNN 恐惧贪婪指数</p>
      </div>
      <div className="rounded-2xl bg-[#0F1520] border border-[#1E2D42] p-5">
        <div className="flex items-end gap-4 mb-4">
          <div>
            <p className="font-mono font-bold text-[2.25em] leading-none tracking-tight" style={{ color }}>
              {fg.score}
            </p>
            <p className="text-[0.875em] font-semibold mt-1.5" style={{ color }}>{fg.label}</p>
          </div>
          <p className="text-[0.6875em] text-[#6B7E9C] leading-relaxed pb-1 flex-1">
            0 = 极度恐惧，100 = 极度贪婪。此指标常被反向解读：
            <span className="text-[#8B9CC0]">极度恐惧时市场往往超卖、情绪见底，极度贪婪时需警惕回调。</span>
          </p>
        </div>

        {/* 0–100 渐变刻度条 + 当前位置标记 */}
        <div className="relative h-2.5 rounded-full overflow-hidden mb-1"
          style={{ background: 'linear-gradient(90deg,#F43F5E 0%,#FB923C 27%,#FACC15 50%,#4ADE80 73%,#22C55E 100%)' }}>
        </div>
        <div className="relative h-0">
          <div className="absolute -top-[13px] w-3 h-3 rounded-full border-2 border-[#080B14]"
            style={{ left: `calc(${Math.max(0, Math.min(100, fg.score))}% - 6px)`, backgroundColor: '#E8EDFB' }} />
        </div>
        <div className="flex justify-between text-[0.5625em] text-[#3A4E6A] mt-2 mb-4">
          <span>0 极度恐惧</span><span>50 中性</span><span>100 极度贪婪</span>
        </div>

        {/* 趋势对比 */}
        <div className="grid grid-cols-4 gap-2 pt-3 border-t border-[#1E2D42]">
          {trends.map((tr) => (
            <div key={tr.label}>
              <p className="text-[0.625em] text-[#6B7E9C] mb-1">{tr.label}</p>
              <div className="flex items-baseline gap-1">
                <span className="font-mono text-[0.875em] font-semibold" style={{ color: fgColor(tr.v) }}>{tr.v}</span>
                <span className="text-[0.5625em]" style={{ color: fgColor(tr.v) }}>
                  {tr.v <= 25 ? '极恐' : tr.v <= 45 ? '恐惧' : tr.v <= 55 ? '中性' : tr.v <= 75 ? '贪婪' : '极贪'}
                </span>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

// ── Economic calendar ────────────────────────────────────────────────────────────

function CalendarCard({ events }: { events: CalendarEvent[] }) {
  if (!events.length) return null;
  return (
    <section>
      <div className="flex items-center gap-2 mb-3">
        <CalendarDays size={13} className="text-[#4F8EF7]" />
        <p className="text-[0.625em] font-medium text-[#6B7E9C] uppercase tracking-wider">经济日历 · 即将公布</p>
      </div>
      <div className="rounded-2xl bg-[#0F1520] border border-[#1E2D42] overflow-hidden">
        {events.map((e, i) => (
          <div key={e.label} className={`flex items-center gap-3 px-4 py-3 ${i > 0 ? 'border-t border-[#1E2D42]' : ''}`}>
            <div className="flex flex-col items-center justify-center w-14 shrink-0">
              <span className={`font-mono font-bold text-[1.125em] leading-none ${e.daysAway <= 3 ? 'text-[#4F8EF7]' : 'text-[#E8EDFB]'}`}>
                {e.daysAway}
              </span>
              <span className="text-[0.5625em] text-[#3A4E6A] mt-0.5">天后</span>
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-[0.875em] font-semibold text-[#E8EDFB]">{e.label}</p>
              <p className="text-[0.6875em] text-[#6B7E9C] mt-0.5">{e.note}</p>
            </div>
            <span className="font-mono text-[0.75em] text-[#8B9CC0] shrink-0">{e.date}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

// ── Economic indicators (FRED) ───────────────────────────────────────────────────

function IndicatorsCard({ items, gridClass }: { items: EconIndicator[]; gridClass: string }) {
  if (!items.length) {
    return (
      <section>
        <div className="flex items-center gap-2 mb-3">
          <Landmark size={13} className="text-[#4F8EF7]" />
          <p className="text-[0.625em] font-medium text-[#6B7E9C] uppercase tracking-wider">经济数据</p>
        </div>
        <div className="rounded-2xl bg-[#0F1520] border border-[#1E2D42] p-4 text-[0.75em] text-[#3A4E6A]">
          经济数据暂不可用（检查 FRED_API_KEY），稍后刷新
        </div>
      </section>
    );
  }
  return (
    <section>
      <div className="flex items-center gap-2 mb-3">
        <Landmark size={13} className="text-[#4F8EF7]" />
        <p className="text-[0.625em] font-medium text-[#6B7E9C] uppercase tracking-wider">经济数据 · 最新读数</p>
      </div>
      <div className={gridClass}>
        {items.map((it) => {
          const delta = it.prev != null ? it.value - it.prev : null;
          // 通胀/利率/失业率回落 → 绿（降温/转松）；上升 → 琥珀
          const arrowColor = delta == null || Math.abs(delta) < 0.005
            ? 'text-[#6B7E9C]' : delta > 0 ? 'text-amber-400' : 'text-emerald-400';
          return (
            <div key={it.key} className="bg-[#0F1520] border border-[#1E2D42] rounded-2xl p-3" title={it.hint}>
              <p className="text-[0.625em] text-[#6B7E9C] truncate mb-1">{it.label}</p>
              <div className="flex items-baseline gap-1">
                <p className="font-mono font-bold text-[1.25em] text-[#E8EDFB] tracking-tight leading-none">
                  {it.value.toFixed(it.unit === '%' ? 1 : 2)}
                </p>
                <span className="text-[0.6875em] text-[#6B7E9C]">{it.unit}</span>
              </div>
              <div className="flex items-center justify-between mt-1.5">
                {delta != null ? (
                  <span className={`font-mono text-[0.6875em] ${arrowColor}`}>
                    {delta > 0 ? '▲' : delta < 0 ? '▼' : '–'} {Math.abs(delta).toFixed(2)}
                  </span>
                ) : <span />}
                <span className="text-[0.5625em] text-[#3A4E6A]">{it.date}</span>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

// ── FOMC statements ──────────────────────────────────────────────────────────────

function FomcCard({ fomc }: { fomc: FomcSummary[] }) {
  return (
    <section>
      <div className="flex items-center gap-2 mb-3">
        <Landmark size={13} className="text-[#4F8EF7]" />
        <p className="text-[0.625em] font-medium text-[#6B7E9C] uppercase tracking-wider">美联储 FOMC 声明 · AI 摘要</p>
      </div>

      {fomc.length === 0 ? (
        <div className="rounded-2xl bg-[#0F1520] border border-[#1E2D42] p-4 text-[0.75em] text-[#3A4E6A]">
          FOMC 声明暂不可用，稍后刷新
        </div>
      ) : (
        <div className="space-y-3">
          {fomc.map((s, i) => (
            <div key={s.url || i} className="rounded-2xl bg-[#0F1520] border border-[#1E2D42] overflow-hidden">
              <div className="flex items-center gap-2 px-4 py-3 border-b border-[#1E2D42]">
                <span className={`text-[0.625em] px-2 py-0.5 rounded-md font-medium ${
                  i === 0 ? 'bg-[#4F8EF7]/15 text-[#4F8EF7] border border-[#4F8EF7]/30'
                          : 'bg-[#172033] text-[#6B7E9C] border border-[#1E2D42]'
                }`}>
                  {i === 0 ? '最新' : '上一次'}
                </span>
                <span className="font-mono text-[0.75em] text-[#8B9CC0]">{s.date || '—'}</span>
                <a href={s.url} target="_blank" rel="noopener noreferrer"
                  className="ml-auto flex items-center gap-1 text-[0.625em] text-[#6B7E9C] hover:text-[#4F8EF7] transition-colors">
                  <ExternalLink size={11} /> 官方原文
                </a>
              </div>

              <div className="px-4 py-3">
                {s.summary ? (
                  <p className="text-[0.875em] text-[#C7D2E6] leading-relaxed">{s.summary}</p>
                ) : (
                  <p className="text-[0.75em] text-[#3A4E6A]">AI 摘要暂不可用，点击右上角查看官方原文。</p>
                )}

                {i === 0 && s.changes.length > 0 && (
                  <div className="mt-3 pt-3 border-t border-[#1E2D42]">
                    <p className="text-[0.625em] text-[#6B7E9C] uppercase tracking-wider mb-2">较上次的变化</p>
                    <ul className="space-y-1.5">
                      {s.changes.map((c, j) => (
                        <li key={j} className="flex gap-2 text-[0.75em] text-[#8B9CC0] leading-relaxed">
                          <span className="text-[#4F8EF7] shrink-0">•</span>
                          <span>{c}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

// ── Skeleton ─────────────────────────────────────────────────────────────────────

function Skeleton() {
  return (
    <div className="space-y-6 animate-pulse">
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2.5">
        {[...Array(10)].map((_, i) => <div key={i} className="h-[74px] rounded-2xl bg-[#0F1520] border border-[#1E2D42]" />)}
      </div>
      <div className="h-44 rounded-2xl bg-[#0F1520] border border-[#1E2D42]" />
      <div className="h-32 rounded-2xl bg-[#0F1520] border border-[#1E2D42]" />
      <div className="h-40 rounded-2xl bg-[#0F1520] border border-[#1E2D42]" />
      <p className="text-[0.6875em] text-[#3A4E6A] text-center pt-1">
        正在拉取行情、情绪、经济数据与 FOMC 声明摘要，首次加载约需 10–30 秒…
      </p>
    </div>
  );
}

// ── Main page ────────────────────────────────────────────────────────────────────

export default function MacroPage() {
  const router = useRouter();
  const [data, setData] = useState<MacroData | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [fontScale, setFontScale] = useState(FS_DEFAULT);

  // 读取上次保存的字号
  useEffect(() => {
    const saved = Number(localStorage.getItem(FS_KEY));
    if (saved >= FS_MIN && saved <= FS_MAX) setFontScale(saved);
  }, []);

  const adjustFont = useCallback((delta: number) => {
    setFontScale((s) => {
      const next = Math.min(FS_MAX, Math.max(FS_MIN, Math.round((s + delta) * 100) / 100));
      try { localStorage.setItem(FS_KEY, String(next)); } catch { /* localStorage 不可用就只在内存里改 */ }
      return next;
    });
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setErr(false);
    try {
      const res = await fetch('/api/macro');
      if (!res.ok) { setErr(true); return; }
      const json = await res.json();
      setData(json as MacroData);
      setLastUpdated(new Date());
    } catch {
      setErr(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // 字号很大时(手机上)两列数字会撑破屏幕，降为单列让每个数字占满整行
  const gridClass = `grid gap-2.5 ${
    fontScale >= FS_DENSE_AT
      ? 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-4'
      : 'grid-cols-2 sm:grid-cols-3 lg:grid-cols-5'
  }`;

  return (
    <div className="min-h-screen bg-[#080B14]">
      <header className="sticky top-0 z-30 bg-[#080B14]/90 backdrop-blur border-b border-[#1E2D42]">
        <div className="max-w-5xl mx-auto px-4 h-14 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <button onClick={() => router.push('/')}
              className="p-1.5 rounded-lg hover:bg-[#172033] text-[#6B7E9C] hover:text-[#E8EDFB] transition-colors">
              <ArrowLeft size={15} />
            </button>
            <Globe size={15} className="text-[#4F8EF7]" />
            <span className="font-semibold text-sm tracking-tight">宏观大盘</span>
          </div>
          <div className="flex items-center gap-2">
            {lastUpdated && (
              <span className="text-[10px] text-[#3A4E6A] hidden sm:block">
                {lastUpdated.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
              </span>
            )}
            {/* 字号调节：A− / 当前% / A+，仅作用于本页正文，自动记忆 */}
            <div className="flex items-center rounded-lg border border-[#1E2D42] overflow-hidden">
              <button onClick={() => adjustFont(-FS_STEP)} disabled={fontScale <= FS_MIN} title="缩小字体"
                aria-label="缩小字体"
                className="px-2.5 py-1.5 text-[#6B7E9C] hover:text-[#E8EDFB] hover:bg-[#172033] disabled:opacity-30 transition-colors leading-none">
                <span className="text-[13px] font-semibold">A</span>
              </button>
              <span className="px-1.5 text-[10px] font-mono text-[#8B9CC0] tabular-nums select-none border-x border-[#1E2D42]">
                {Math.round(fontScale * 100)}%
              </span>
              <button onClick={() => adjustFont(FS_STEP)} disabled={fontScale >= FS_MAX} title="放大字体"
                aria-label="放大字体"
                className="px-2.5 py-1.5 text-[#6B7E9C] hover:text-[#E8EDFB] hover:bg-[#172033] disabled:opacity-30 transition-colors leading-none">
                <span className="text-[18px] font-semibold">A</span>
              </button>
            </div>
            <button onClick={load} disabled={loading}
              className="p-2 rounded-lg hover:bg-[#172033] text-[#6B7E9C] hover:text-[#E8EDFB] transition-colors disabled:opacity-40">
              <RefreshCw size={15} className={loading ? 'animate-spin' : ''} />
            </button>
          </div>
        </div>
      </header>

      <main style={{ fontSize: `${fontScale}rem` }} className="max-w-5xl mx-auto px-4 pb-24 pt-6 space-y-6">
        {loading && !data ? (
          <Skeleton />
        ) : err && !data ? (
          <div className="rounded-2xl bg-rose-950/30 border border-rose-500/30 p-6 flex items-center gap-2">
            <AlertTriangle size={15} className="text-rose-400 shrink-0" />
            <p className="text-[0.875em] text-rose-200/80">获取宏观数据失败，请点击右上角刷新重试。</p>
          </div>
        ) : data ? (
          <>
            <MarketPulse ticks={data.marketPulse} gridClass={gridClass} />
            <FearGreedCard fg={data.fearGreed} />
            <CalendarCard events={data.calendar} />
            <IndicatorsCard items={data.indicators} gridClass={gridClass} />
            <FomcCard fomc={data.fomc} />
            <p className="text-[0.625em] text-[#3A4E6A] text-center pt-1 leading-relaxed">
              行情 Yahoo Finance · 情绪 CNN Fear &amp; Greed · 经济数据 FRED(圣路易斯联储) · 声明来自美联储官网<br />
              仅供信息参考，非投资建议 · 生成于 {new Date(data.generatedAt).toLocaleString('zh-CN')}
            </p>
          </>
        ) : null}
      </main>
    </div>
  );
}
