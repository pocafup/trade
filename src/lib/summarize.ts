export interface NewsSummaryResult {
  para: string;
  bullets: string[];
}

const _cache = new Map<string, { result: NewsSummaryResult; exp: number }>();

export async function summarizeNews(
  ticker: string,
  period: string,
  titles: string[],
): Promise<NewsSummaryResult> {
  const empty: NewsSummaryResult = { para: '', bullets: [] };
  if (!titles.length) return empty;

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return empty;

  const cacheKey = `${ticker}:${period}:${titles.slice(0, 3).join('§')}`;
  const hit = _cache.get(cacheKey);
  if (hit && hit.exp > Date.now()) return hit.result;

  const prompt = `你是一位专业的股票投资分析助手。
以下是 ${ticker} 在"${period}"内的 ${titles.length} 条英文新闻标题（按时间倒序排列）：

${titles.map((t, i) => `${i + 1}. ${t}`).join('\n')}

任务：用中文输出两部分内容。

第一部分：综合分析段落（5～10句话）
- 概括此时段内最重要的动向与背景
- 包含关键数字、时间节点、因果关系
- 语言流畅连贯，适合投资者快速了解全貌
- 直接输出段落正文，不要加任何标题行

第二部分：重点要点（3～5条）
- 每条以「•」开头
- 每条 25～50 字，包含关键数据
- 聚焦：财报/业绩指引、重大产品/合作/并购、监管/法律、分析师评级、高管言论
- 忽略重复、营销性、无实质信息的内容

格式（严格遵守）：
[段落直接写在这里，不要标题]

• [要点1]
• [要点2]
• [要点3]`;

  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.15, maxOutputTokens: 1000 },
        }),
        signal: AbortSignal.timeout(25_000),
      }
    );
    if (!res.ok) return empty;
    const data = await res.json();
    const raw: string = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';

    const lines = raw.split('\n');
    const firstBulletIdx = lines.findIndex(l => l.trimStart().startsWith('•'));

    const para = firstBulletIdx > 0
      ? lines.slice(0, firstBulletIdx).join('\n').trim()
      : '';

    const bulletLines = firstBulletIdx >= 0 ? lines.slice(firstBulletIdx) : lines;
    const bullets = bulletLines
      .map(l => l.replace(/^[•·\-\*]\s*/, '').trim())
      .filter(l => l.length > 8);

    const result: NewsSummaryResult = { para, bullets };
    _cache.set(cacheKey, { result, exp: Date.now() + 2 * 3_600_000 });
    return result;
  } catch {
    return empty;
  }
}
