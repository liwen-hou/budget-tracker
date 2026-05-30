// Claude spending-analysis paragraph — single-shot summary of the current
// month from a pre-built overview object. Returns the raw paragraph text.

const ANALYSIS_MODEL = 'claude-sonnet-4-6';

export async function generateAnalysisWithClaude({ apiKey, overview }) {
  if (!apiKey) throw new Error('No API key');

  const prompt = `You are a sharp personal finance coach. Look at this user's current-month dashboard data and write ONE paragraph (max 110 words) that:
- States the headline: are they on/under/over pace? quantify briefly
- Calls out the 1-2 categories driving the pace (good or bad)
- Notes any miles-card cap they should chase or avoid wasting
- Ends with one concrete, specific action for the rest of the month

Be direct and Singaporean-pragmatic. Use SGD. No bullet points, no preamble, no markdown — just the paragraph.

Dashboard data (JSON):
${JSON.stringify(overview, null, 2)}`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: ANALYSIS_MODEL,
      max_tokens: 400,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const err = new Error(`Claude API ${res.status}`);
    err.status = res.status;
    err.body = text;
    throw err;
  }

  const json = await res.json();
  return (json?.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n').trim();
}
