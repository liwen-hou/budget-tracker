// Claude Vision OCR — reads receipt/statement images + PDFs, returns the
// extracted transactions as a JSON-array string (caller decides whether to
// parse, edit, or hand to the import-review flow as-is).

const OCR_MODEL = 'claude-haiku-4-5';

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result || '';
      // strip "data:<mime>;base64," prefix
      const comma = String(result).indexOf(',');
      resolve(comma >= 0 ? String(result).slice(comma + 1) : String(result));
    };
    reader.onerror = () => reject(reader.error || new Error('File read failed'));
    reader.readAsDataURL(file);
  });
}

export async function scanReceiptsWithClaude({ apiKey, files, categoryNames, cardNames }) {
  if (!apiKey) throw new Error('No API key');
  if (!files?.length) throw new Error('No files');

  const pdfCount = files.filter(f => f.type === 'application/pdf').length;
  const imgCount = files.length - pdfCount;

  const contentBlocks = await Promise.all(files.map(async f => {
    const data = await fileToBase64(f);
    if (f.type === 'application/pdf') {
      return { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } };
    }
    return { type: 'image', source: { type: 'base64', media_type: f.type || 'image/jpeg', data } };
  }));

  const today = new Date().toISOString().split('T')[0];
  const catList = categoryNames.join(', ');
  const cardList = cardNames.join(', ');
  const sourceLabel = pdfCount && imgCount ? 'attached receipts, statements, and PDFs'
                    : pdfCount > 1 ? `${pdfCount} attached bank statement PDFs`
                    : pdfCount === 1 ? 'this bank statement PDF'
                    : imgCount > 1 ? `${imgCount} attached receipt or statement images`
                    : 'this receipt or statement image';
  const multi = files.length > 1 || pdfCount >= 1;

  const prompt = `Extract every transaction visible in ${sourceLabel}.

${multi ? 'Merge transactions from every page and file into a single combined JSON array, in chronological order. Skip non-transaction rows (opening balance, closing balance, totals, fees summary headers, payments to the card if this is a credit card statement). ' : ''}For each transaction return:
- date: YYYY-MM-DD (if year not visible, infer from the statement period; if no date at all, use ${today})
- merchant: short description (clean up redundant codes like reference numbers, location IDs)
- category: choose the closest match from this list — ${catList}
- card: choose from — ${cardList}. If a bank statement makes the source card obvious (e.g. "DBS Vantage Statement"), use it. Otherwise "Cash".
- amount: a positive number in SGD (use the debit/charge amount, not credit)
- mcc: 4-digit Merchant Category Code IF visible on the statement (e.g. "5814"). Omit the field entirely if not shown.

Return ONLY a JSON array, no prose, no markdown fences. Example:
[{"date":"${today}","merchant":"NTUC","category":"Groceries","card":"DBS Vantage","amount":42.50,"mcc":"5411"}]`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: OCR_MODEL,
      // Bank statements can list 50–100+ transactions per file, so leave room.
      max_tokens: pdfCount > 0 ? 16384 : 4096,
      messages: [{
        role: 'user',
        content: [...contentBlocks, { type: 'text', text: prompt }],
      }],
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const err = new Error(`Claude API ${res.status}`);
    err.status = res.status;
    err.body = text;
    throw err;
  }

  const body = await res.json();
  const text = (body?.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n').trim();
  return text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
}
