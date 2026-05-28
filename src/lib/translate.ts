const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

const _cache = new Map<string, { v: string; exp: number }>();

export async function translateToZh(text: string): Promise<string> {
  if (!text?.trim()) return text;
  const cached = _cache.get(text);
  if (cached && cached.exp > Date.now()) return cached.v;
  try {
    const res = await fetch(
      `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=zh-CN&dt=t&q=${encodeURIComponent(text)}`,
      { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(6000) }
    );
    if (!res.ok) return text;
    const data = await res.json();
    const out = (data[0] as [string][]).map(s => s[0] ?? '').join('') || text;
    _cache.set(text, { v: out, exp: Date.now() + 6 * 3_600_000 }); // 6h cache
    return out;
  } catch {
    return text;
  }
}
