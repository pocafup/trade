const _cache = new Map<string, { bullets: string[]; exp: number }>();

export async function summarizeNews(
  ticker: string,
  period: string,
  titles: string[],
): Promise<string[]> {
  if (!titles.length) return [];

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return []; // fallback to translated headlines in the UI

  // Cache key = ticker + period + first 3 titles (invalidates when news changes)
  const cacheKey = `${ticker}:${period}:${titles.slice(0, 3).join('§')}`;
  const hit = _cache.get(cacheKey);
  if (hit && hit.exp > Date.now()) return hit.bullets;

  const prompt = `你是一位专业的股票投资分析助手。
以下是 ${ticker} 在"${period}"内的 ${titles.length} 条英文新闻标题（按时间倒序排列）：

${titles.map((t, i) => `${i + 1}. ${t}`).join('\n')}

任务：提炼出 3~5 条最值得投资者关注的要点，用中文输出。
判断标准（按优先级）：
- 财报 / 业绩指引 / EPS 超预期或未达
- 重大产品发布 / 战略合作 / 收并购
- 监管政策 / 法律诉讼
- 分析师评级 / 目标价变化
- CEO / 高管重要言论
- 忽略重复、营销性、无实质信息的内容

格式要求：
- 每条以「•」开头
- 25～50 字，直接简洁，包含关键数据
- 只输出 bullet points，不要任何标题或解释文字`;

  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.15, maxOutputTokens: 600 },
        }),
        signal: AbortSignal.timeout(20_000),
      }
    );
    if (!res.ok) return [];
    const data = await res.json();
    const raw: string = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';

    const bullets = raw
      .split('\n')
      .map(l => l.replace(/^[•·\-\*\d.]\s*/, '').trim())
      .filter(l => l.length > 8);

    _cache.set(cacheKey, { bullets, exp: Date.now() + 2 * 3_600_000 }); // 2h cache
    return bullets;
  } catch {
    return [];
  }
}
